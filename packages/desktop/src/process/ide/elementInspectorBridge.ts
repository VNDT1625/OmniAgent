/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `elementInspectorBridge` — the Main-process IPC surface for Quick Test's
 * **visual element picker** ("Inspect", like F12's pick-element).
 *
 * This is an ADDITIVE feature, fully independent from the bug-prediction trace
 * flow (`quickTestBridge`). It does NOT attach the CDP debugger — it drives the
 * page purely through `WebContents.executeJavaScript`, so it can run alongside a
 * Quick Test recording without fighting over the single debugger session.
 *
 * ## How the pick works (no CDP, no polling)
 *
 * `executeJavaScript` AWAITS a Promise returned by the page. So `startInspect`
 * injects a self-contained picker that:
 *   1. paints a hover highlight overlay + label,
 *   2. resolves a Promise with a typed element snapshot on the next click
 *      (capturing tag/text/attrs, on-screen box, key computed styles, and the
 *      React fiber `_debugSource` → exact authored `file:line` in dev mode),
 *   3. cleans the overlay up and swallows that click so the app does not react.
 * The bridge then maps the snapshot to the repo's knowledge graph
 * ({@link locateElement}) and returns a {@link LocatedElement} the renderer can
 * show + turn into an agent brief.
 *
 * `cancelInspect` flips a page-side flag so an in-flight pick resolves to null
 * (e.g. the user toggled Inspect off or pressed Escape).
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs here
 * (the DOM code is a string evaluated in the page).
 */

import { bridge } from '@office-ai/platform';
import type { WebContents } from 'electron';

import type { Dirent } from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { locateElement, type LocatedElement, type PickedElement } from './elementInspectorLocator';
import type { CdpWebContents } from './quickTestTracer';
import type { loadGraph } from './quickTestBridgeHelpers';
import type { UnderstandResult } from './understandTypes';
import { capturePageViewportPng, createFfmpegVideoBackend } from '../testing/engines/ffmpegVideoBackend';
import { resolveFfmpeg } from '../testing/engines/toolResolver';
import { runUiAudit, type UiAuditReport } from './uiAuditEngine';

/** IPC channel names for the element inspector surface. */
export const INSPECT_CHANNELS = {
  pick: 'ide.inspect-pick',
  cancel: 'ide.inspect-cancel',
  screenshot: 'ide.inspect-screenshot',
  videoStart: 'ide.inspect-video-start',
  videoStop: 'ide.inspect-video-stop',
  audit: 'ide.ui-audit',
} as const;

/** Request for {@link INSPECT_CHANNELS.pick}. */
export type InspectPickRequest = {
  /** Absolute repo root the IDE has open (for graph mapping). */
  rootPath: string;
  /** The embedded browser tab id to inspect (the Quick Test panel's own tab). */
  tabId?: string;
};

/** Area of the embedded page included in a screenshot. */
export type InspectScreenshotMode = 'viewport' | 'fullPage';

/** Request for {@link INSPECT_CHANNELS.screenshot}. */
export type InspectScreenshotRequest = InspectPickRequest & {
  mode: InspectScreenshotMode;
};

/** Result of a screenshot capture: the saved PNG path the agent can open. */
export type InspectScreenshotResult = {
  /** Absolute path of the saved PNG. */
  filePath: string;
  /** Data URL (for an inline preview in the panel). */
  dataUrl: string;
  /** Area of the page represented by this image. */
  mode: InspectScreenshotMode;
};

/** Saved recording of the embedded web tab. */
export type InspectVideoResult = {
  /** Absolute path of the MP4 that the agent can inspect. */
  filePath: string;
  /** Stable embedded-tab id so recording can still stop after navigation. */
  tabId: string;
  /** Recording start time (Unix milliseconds). */
  startedAt: number;
  /** Final duration; zero while the recording is active. */
  durationMs: number;
};

type CaptureSize = { width?: number; height?: number };

const INSPECT_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const INSPECT_EVIDENCE_SWEEP_MS = 60 * 60 * 1000;
const MANAGED_EVIDENCE_PATTERN = /^(shot-(?:full-page|viewport)-|recording-)\d+\.(?:png|mp4|webm)$/i;

/**
 * Delete stale Quick Test captures while leaving unrelated files untouched.
 * Evidence remains available for 24 hours after it is sent to an agent.
 */
export const pruneInspectEvidence = async (rootPath: string, now = Date.now()): Promise<number> => {
  const dir = path.join(rootPath, '.omni', 'inspect');
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  let removed = 0;
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !MANAGED_EVIDENCE_PATTERN.test(entry.name)) return;
      const filePath = path.join(dir, entry.name);
      const stat = await fsp.stat(filePath).catch((): null => null);
      if (!stat || now - stat.mtimeMs < INSPECT_EVIDENCE_TTL_MS) return;
      await fsp.rm(filePath, { force: true });
      removed += 1;
    })
  );
  return removed;
};

const trackedInspectRoots = new Set<string>();
let inspectEvidenceSweep: ReturnType<typeof setInterval> | null = null;

const trackInspectEvidenceRoot = (rootPath: string): void => {
  trackedInspectRoots.add(rootPath);
  if (inspectEvidenceSweep) return;
  inspectEvidenceSweep = setInterval(() => {
    for (const trackedRoot of trackedInspectRoots) {
      void pruneInspectEvidence(trackedRoot).catch(() => {});
    }
  }, INSPECT_EVIDENCE_SWEEP_MS);
  inspectEvidenceSweep.unref();
};

/** Resolve a full-page clip without trusting viewport-sized CDP metrics alone. */
export const resolveFullPageSize = (
  layoutSize: CaptureSize,
  domSize: CaptureSize
): { width: number; height: number } => ({
  width: Math.ceil(Math.max(layoutSize.width ?? 0, domSize.width ?? 0)),
  height: Math.ceil(Math.max(layoutSize.height ?? 0, domSize.height ?? 0)),
});

/**
 * Capture and persist a Quick Test screenshot using the same implementation as
 * the renderer IPC bridge. Keeping this operation here lets agent-facing tools
 * reuse the proven CDP full-page path without maintaining a second algorithm.
 */
export const captureInspectScreenshot = async (
  wc: CdpWebContents,
  rootPath: string,
  mode: InspectScreenshotMode
): Promise<InspectScreenshotResult | null> => {
  trackInspectEvidenceRoot(rootPath);
  await pruneInspectEvidence(rootPath);
  let png: Buffer;
  let dataUrl: string;
  if (mode === 'fullPage') {
    const wasAttached = wc.debugger.isAttached();
    const zoomable = wc as CdpWebContents & { getZoomFactor?: () => number; setZoomFactor?: (factor: number) => void };
    const previousZoom = zoomable.getZoomFactor?.();
    const canRestoreZoom =
      typeof previousZoom === 'number' && Number.isFinite(previousZoom) && !!zoomable.setZoomFactor;
    if (canRestoreZoom && Math.abs(previousZoom - 1) > 0.001) zoomable.setZoomFactor?.(1);
    try {
      if (!wasAttached) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Page.enable');
      const [metrics, domSize] = await Promise.all([
        wc.debugger.sendCommand('Page.getLayoutMetrics') as Promise<{
          cssContentSize?: CaptureSize;
          contentSize?: CaptureSize;
        }>,
        wc.executeJavaScript(`(() => {
          const nodes = [document.documentElement, document.body, document.scrollingElement].filter(Boolean);
          const dimensions = (key) => nodes.map((node) => Number(node[key]) || 0);
          return {
            width: Math.max(
              window.innerWidth,
              ...dimensions('scrollWidth'),
              ...dimensions('offsetWidth'),
              ...dimensions('clientWidth')
            ),
            height: Math.max(
              window.innerHeight,
              ...dimensions('scrollHeight'),
              ...dimensions('offsetHeight'),
              ...dimensions('clientHeight')
            )
          };
        })()`) as Promise<CaptureSize>,
      ]);
      const contentSize = metrics.cssContentSize ?? metrics.contentSize ?? {};
      const { width, height } = resolveFullPageSize(contentSize, domSize);
      if (width <= 0 || height <= 0) throw new Error('The page has no capturable area.');
      const captured = (await wc.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      })) as { data?: string };
      if (!captured.data) throw new Error('Chromium returned an empty screenshot.');
      png = Buffer.from(captured.data, 'base64');
      dataUrl = `data:image/png;base64,${captured.data}`;
    } finally {
      if (!wasAttached && wc.debugger.isAttached()) wc.debugger.detach();
      if (canRestoreZoom) zoomable.setZoomFactor?.(previousZoom);
    }
  } else {
    const captured = await capturePageViewportPng(wc as unknown as WebContents);
    if (!captured) return null;
    png = captured;
    dataUrl = `data:image/png;base64,${captured.toString('base64')}`;
  }
  const dir = path.join(rootPath, '.omni', 'inspect');
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `shot-${mode === 'fullPage' ? 'full-page' : 'viewport'}-${Date.now()}.png`);
  await fsp.writeFile(filePath, png);
  return { filePath, dataUrl, mode };
};

/** Typed inspector channels. */
export const inspectChannels = {
  pick: bridge.buildProvider<UnderstandResult<LocatedElement | null>, InspectPickRequest>(INSPECT_CHANNELS.pick),
  cancel: bridge.buildProvider<UnderstandResult<boolean>, InspectPickRequest>(INSPECT_CHANNELS.cancel),
  screenshot: bridge.buildProvider<UnderstandResult<InspectScreenshotResult | null>, InspectScreenshotRequest>(
    INSPECT_CHANNELS.screenshot
  ),
  videoStart: bridge.buildProvider<UnderstandResult<InspectVideoResult>, InspectPickRequest>(
    INSPECT_CHANNELS.videoStart
  ),
  videoStop: bridge.buildProvider<UnderstandResult<InspectVideoResult>, InspectPickRequest>(INSPECT_CHANNELS.videoStop),
  audit: bridge.buildProvider<UnderstandResult<UiAuditReport>, InspectPickRequest>(INSPECT_CHANNELS.audit),
};

/** Injected collaborators for {@link registerElementInspectorBridge}. */
export type ElementInspectorBridgeDeps = {
  /** Resolve the embedded tab's WebContents to drive (null when none is open). */
  getWebContents: (tabId?: string) => CdpWebContents | null;
  /** Load the persisted KG for a repo root (for element→code mapping). */
  loadGraph: typeof loadGraph;
};

/**
 * Page-side picker. A self-contained IIFE that returns a Promise resolving to a
 * {@link PickedElement} JSON on the next click, or null when cancelled. Reads the
 * React fiber `_debugSource` for the exact authored file:line (dev mode). Safe to
 * re-run: it tears down any previous picker first.
 */
const PICKER_SCRIPT = `
(function () {
  if (window.__omniInspectCleanup) { try { window.__omniInspectCleanup(); } catch (e) {} }
  window.__omniInspectCancel = false;
  return new Promise(function (resolve) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2f6bff;background:rgba(47,107,255,0.12);border-radius:3px;transition:all 40ms ease;display:none;';
    var label = document.createElement('div');
    label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#2f6bff;color:#fff;font:11px/1.4 ui-monospace,monospace;padding:2px 6px;border-radius:4px;display:none;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    document.body.appendChild(overlay);
    document.body.appendChild(label);

    function fiberSource(el) {
      var key = Object.keys(el).find(function (k) { return k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0; });
      if (!key) return { source: null, name: null };
      var fiber = el[key];
      var src = null, name = null;
      var hops = 0;
      while (fiber && hops < 30) {
        if (!src && fiber._debugSource) src = fiber._debugSource;
        if (!name && fiber.type) {
          var t = fiber.type;
          var n = typeof t === 'function' ? (t.displayName || t.name) : (t && t.render ? (t.render.displayName || t.render.name) : null);
          if (n && n[0] === n[0].toUpperCase()) name = n;
        }
        if (src && name) break;
        fiber = fiber.return;
        hops++;
      }
      return {
        source: src ? { fileName: String(src.fileName || ''), lineNumber: src.lineNumber || 0, columnNumber: src.columnNumber || 0 } : null,
        name: name,
      };
    }

    function cssSelector(el) {
      var parts = [];
      var node = el;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 4) {
        var part = node.tagName.toLowerCase();
        if (node.id) { part += '#' + node.id; parts.unshift(part); break; }
        if (node.className && typeof node.className === 'string') {
          var cls = node.className.trim().split(/\\s+/).slice(0, 3).join('.');
          if (cls) part += '.' + cls;
        }
        parts.unshift(part);
        node = node.parentElement;
        depth++;
      }
      return parts.join(' > ');
    }

    function snapshot(el) {
      var r = el.getBoundingClientRect();
      var cs = window.getComputedStyle(el);
      var fs = fiberSource(el);
      var attrs = {};
      ['role', 'type', 'name', 'href', 'aria-label', 'data-testid', 'placeholder', 'title'].forEach(function (a) {
        var v = el.getAttribute && el.getAttribute(a);
        if (v) attrs[a] = String(v).slice(0, 80);
      });
      var styleKeys = ['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'margin', 'padding', 'border', 'borderRadius', 'display', 'position', 'width', 'height', 'flex', 'gap'];
      var styles = {};
      styleKeys.forEach(function (k) { var v = cs.getPropertyValue(k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); })); if (v) styles[k] = v.trim(); });
      return {
        selector: cssSelector(el),
        tagName: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).filter(Boolean) : [],
        text: (el.textContent || '').trim().slice(0, 120),
        attributes: attrs,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        styles: styles,
        componentName: fs.name || undefined,
        source: fs.source && fs.source.fileName ? fs.source : undefined,
      };
    }

    var current = null;
    function onMove(e) {
      if (window.__omniInspectCancel) return;
      var el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === current) return;
      current = el;
      var r = el.getBoundingClientRect();
      overlay.style.display = 'block';
      overlay.style.left = r.left + 'px'; overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px'; overlay.style.height = r.height + 'px';
      var tag = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
      label.style.display = 'block';
      label.textContent = tag + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
      var ly = r.top - 22; if (ly < 0) ly = r.top + 4;
      label.style.left = r.left + 'px'; label.style.top = ly + 'px';
    }
    function cleanup() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (label.parentNode) label.parentNode.removeChild(label);
      window.__omniInspectCleanup = null;
    }
    window.__omniInspectCleanup = cleanup;
    function onClick(e) {
      if (window.__omniInspectCancel) return;
      e.preventDefault(); e.stopPropagation();
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var snap = el ? snapshot(el) : null;
      cleanup();
      resolve(snap);
    }
    function onKey(e) { if (e.key === 'Escape') { cleanup(); resolve(null); } }
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);

    var poll = setInterval(function () {
      if (window.__omniInspectCancel) { clearInterval(poll); cleanup(); resolve(null); }
    }, 200);
  });
})();
`;

/** Script that cancels an in-flight pick (resolves the page-side Promise to null). */
const CANCEL_SCRIPT = `(function () { window.__omniInspectCancel = true; if (window.__omniInspectCleanup) { try { window.__omniInspectCleanup(); } catch (e) {} } return true; })();`;

/**
 * Register the element inspector IPC handlers. Idempotent. Called once during
 * Main-process bootstrap (alongside the Quick Test bridge).
 */
export function registerElementInspectorBridge(deps: ElementInspectorBridgeDeps): void {
  const ffmpeg = resolveFfmpeg();
  const videoBackend = createFfmpegVideoBackend({
    getWebContents: (tabId) => (deps.getWebContents(tabId) as unknown as WebContents | null) ?? undefined,
    ...(ffmpeg.path ? { ffmpegPath: ffmpeg.path } : {}),
  });
  const activeVideos = new Map<string, InspectVideoResult>();

  inspectChannels.pick.provider(async (req): Promise<UnderstandResult<LocatedElement | null>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.', code: 'error' };
    const wc = deps.getWebContents(req.tabId);
    if (!wc) return { ok: false, error: 'No embedded browser tab to inspect.', code: 'error' };
    try {
      // executeJavaScript awaits the page-side Promise → resolves on click/Escape.
      const picked = (await wc.executeJavaScript(PICKER_SCRIPT)) as PickedElement | null;
      if (!picked) return { ok: true, data: null };
      const graph = await deps.loadGraph(rootPath).catch((): null => null);
      return { ok: true, data: locateElement(picked, graph, rootPath) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  inspectChannels.cancel.provider(async (req): Promise<UnderstandResult<boolean>> => {
    const wc = deps.getWebContents(req.tabId);
    if (!wc) return { ok: true, data: false };
    try {
      await wc.executeJavaScript(CANCEL_SCRIPT);
      return { ok: true, data: true };
    } catch {
      return { ok: true, data: false };
    }
  });

  inspectChannels.audit.provider(async (req): Promise<UnderstandResult<UiAuditReport>> => {
    try {
      const wc = deps.getWebContents(req.tabId);
      if (!wc) return { ok: false, error: 'No browser tab is available for UI audit.', code: 'error' };
      return { ok: true, data: await runUiAudit(wc) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), code: 'error' };
    }
  });

  inspectChannels.screenshot.provider(async (req): Promise<UnderstandResult<InspectScreenshotResult | null>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.', code: 'error' };
    const wc = deps.getWebContents(req.tabId);
    if (!wc) return { ok: false, error: 'No embedded browser tab to capture.', code: 'error' };
    try {
      return { ok: true, data: await captureInspectScreenshot(wc, rootPath, req.mode) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  inspectChannels.videoStart.provider(async (req): Promise<UnderstandResult<InspectVideoResult>> => {
    const rootPath = req.rootPath?.trim();
    const tabId = req.tabId?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.', code: 'error' };
    if (!tabId || !deps.getWebContents(tabId)) {
      return { ok: false, error: 'No embedded browser tab to record.', code: 'error' };
    }
    if (!ffmpeg.ok || !ffmpeg.path) {
      return { ok: false, error: ffmpeg.reason ?? 'Bundled ffmpeg is unavailable.', code: 'error' };
    }
    if (activeVideos.has(tabId)) return { ok: false, error: 'This tab is already being recorded.', code: 'error' };
    try {
      trackInspectEvidenceRoot(rootPath);
      await pruneInspectEvidence(rootPath);
      const dir = path.join(rootPath, '.omni', 'inspect');
      await fsp.mkdir(dir, { recursive: true });
      const webmPath = path.join(dir, `recording-${Date.now()}.webm`);
      const recording: InspectVideoResult = {
        filePath: webmPath.replace(/\.webm$/i, '.mp4'),
        tabId,
        startedAt: Date.now(),
        durationMs: 0,
      };
      await videoBackend.startVideo({ tabId }, webmPath);
      activeVideos.set(tabId, recording);
      return { ok: true, data: recording };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  inspectChannels.videoStop.provider(async (req): Promise<UnderstandResult<InspectVideoResult>> => {
    const tabId = req.tabId?.trim();
    if (!tabId) return { ok: false, error: 'No embedded browser tab to stop.', code: 'error' };
    const recording = activeVideos.get(tabId);
    if (!recording) return { ok: false, error: 'This tab is not being recorded.', code: 'error' };
    activeVideos.delete(tabId);
    try {
      await videoBackend.stopVideo({ tabId });
      const stat = await fsp.stat(recording.filePath).catch((): null => null);
      if (!stat || stat.size === 0) throw new Error('The recording did not produce a playable video.');
      return {
        ok: true,
        data: { ...recording, durationMs: Math.max(0, Date.now() - recording.startedAt) },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: 'error' };
    }
  });
}
