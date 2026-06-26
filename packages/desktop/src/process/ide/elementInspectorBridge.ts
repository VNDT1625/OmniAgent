/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
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
import { app } from 'electron';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { locateElement, type LocatedElement, type PickedElement } from './elementInspectorLocator';
import type { CdpWebContents } from './quickTestTracer';
import type { loadGraph } from './quickTestBridgeHelpers';
import type { UnderstandResult } from './understandTypes';

/** IPC channel names for the element inspector surface. */
export const INSPECT_CHANNELS = {
  pick: 'ide.inspect-pick',
  cancel: 'ide.inspect-cancel',
  screenshot: 'ide.inspect-screenshot',
} as const;

/** Request for {@link INSPECT_CHANNELS.pick}. */
export type InspectPickRequest = {
  /** Absolute repo root the IDE has open (for graph mapping). */
  rootPath: string;
  /** The embedded browser tab id to inspect (the Quick Test panel's own tab). */
  tabId?: string;
};

/** Result of a screenshot capture: the saved PNG path the agent can open. */
export type InspectScreenshotResult = {
  /** Absolute path of the saved PNG. */
  filePath: string;
  /** Data URL (for an inline preview in the panel). */
  dataUrl: string;
};

/** Typed inspector channels. */
export const inspectChannels = {
  pick: bridge.buildProvider<UnderstandResult<LocatedElement | null>, InspectPickRequest>(INSPECT_CHANNELS.pick),
  cancel: bridge.buildProvider<UnderstandResult<boolean>, InspectPickRequest>(INSPECT_CHANNELS.cancel),
  screenshot: bridge.buildProvider<UnderstandResult<InspectScreenshotResult | null>, InspectPickRequest>(
    INSPECT_CHANNELS.screenshot
  ),
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
      return { ok: true, data: locateElement(picked, graph) };
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

  inspectChannels.screenshot.provider(async (req): Promise<UnderstandResult<InspectScreenshotResult | null>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.', code: 'error' };
    const wc = deps.getWebContents(req.tabId);
    if (!wc) return { ok: false, error: 'No embedded browser tab to capture.', code: 'error' };
    // The Electron WebContents has `capturePage()` (returns a NativeImage); it is
    // not part of the minimal CDP surface type, so reach it through a cast.
    const capturable = wc as unknown as {
      capturePage?: () => Promise<{ isEmpty: () => boolean; toPNG: () => Buffer; toDataURL: () => string }>;
    };
    if (typeof capturable.capturePage !== 'function') {
      return { ok: false, error: 'This tab cannot be captured.', code: 'error' };
    }
    try {
      const image = await capturable.capturePage();
      if (image.isEmpty()) return { ok: true, data: null };
      // Save the PNG into the repo's `.aionui/inspect/` folder so the agent (and
      // its file tools) can open it by path; also return a data URL for an inline
      // preview in the panel.
      const dir = path.join(rootPath, '.aionui', 'inspect');
      await fsp.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `shot-${Date.now()}.png`);
      await fsp.writeFile(filePath, image.toPNG());
      return { ok: true, data: { filePath, dataUrl: image.toDataURL() } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: 'error' };
    }
  });
}
