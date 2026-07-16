/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Quick Test IPC bridge — exposes the {@link QuickTestTracer} to the renderer
 * via three channels:
 *
 *   - `ide.qt-start`  — attach CDP + start recording for a repo root.
 *   - `ide.qt-stop`   — detach CDP + return the completed {@link RuntimeTrace}.
 *   - `ide.qt-event`  — emitter: streams live {@link TraceEvent}s to the renderer
 *                       so the UI can show a live "recording" indicator.
 *
 * The tracer is wired to the embedded browser's active WebContents via the
 * injected `getWebContents` dep (same pattern as `browserBridge`). For native
 * targets (android/windows) `start` returns `{ ok: true, data: false }` — the
 * renderer shows a "native trace not available" hint and falls back to the
 * existing testOrchestrator screenshot approach.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import {
  createQuickTestTracer,
  type CdpWebContents,
  type RuntimeTrace,
  type TraceEvent,
  type TraceEvidence,
  type TracePlatform,
} from './quickTestTracer';
import { createQuickTestNativeTracer, type NativeStreamOpener } from './quickTestNativeTracer';
import { createAdaptiveRuntimeProbe } from './adaptiveRuntimeProbe';
import { isSignificantEvent } from './quickTestBuffer';
import { buildTraceContext } from './traceContextBuilder';
import type { loadGraph } from './quickTestBridgeHelpers';
import type { ContextPack, UnderstandResult } from './understandTypes';

/** IPC channel names for the Quick Test surface. */
export const QT_CHANNELS = {
  start: 'ide.qt-start',
  stop: 'ide.qt-stop',
  event: 'ide.qt-event',
} as const;

/** Request for {@link QT_CHANNELS.start}. */
export type QtStartRequest = {
  /** Absolute repo root the IDE has open. */
  rootPath: string;
  /** Platform to observe. Defaults to `'web'` (CDP on the embedded browser). */
  platform?: TracePlatform;
  /**
   * Native target hint: the android device serial or the Windows `.exe` path.
   * Ignored for the web platform. May be empty when it can be auto-resolved
   * (e.g. the first connected android device).
   */
  target?: string;
  /** Optional web assertion evaluated against the rendered page text on stop. */
  expectedText?: string;
  /**
   * For the web platform: the embedded browser tab id whose WebContents the
   * tracer attaches CDP to. When omitted the bridge falls back to the focused
   * WebContents (legacy behaviour).
   */
  tabId?: string;
};

/** One explicit assertion evaluated by Quick Test. */
export type QtVerification = {
  kind: 'text';
  expected: string;
  passed: boolean;
};

/** Response for {@link QT_CHANNELS.stop}: the trace + verification + context. */
export type QtStopResponse = {
  trace: RuntimeTrace;
  /** Explicit assertion result; null means the session was observation-only. */
  verification: QtVerification | null;
  /** Context pack derived from the trace (null when graph not built yet). */
  contextPack: ContextPack | null;
};

/** Envelope for streamed trace events. */
export type QtEventEnvelope = {
  event: TraceEvent;
};

/** Typed Quick Test channels. */
export const qtChannels = {
  start: bridge.buildProvider<UnderstandResult<boolean>, QtStartRequest>(QT_CHANNELS.start),
  stop: bridge.buildProvider<UnderstandResult<QtStopResponse>, void>(QT_CHANNELS.stop),
  event: bridge.buildEmitter<QtEventEnvelope>(QT_CHANNELS.event),
};

/** Evaluate the explicit web pass condition against the rendered page. */
const verifyExpectedText = async (wc: CdpWebContents | null, expected: string): Promise<QtVerification> => {
  if (!wc) return { kind: 'text', expected, passed: false };
  const renderedText = await wc.executeJavaScript(`(() => {
    const body = document.body;
    const text = body?.innerText ?? body?.textContent ?? '';
    return String(text);
  })()`);
  const actual = typeof renderedText === 'string' ? renderedText : '';
  return { kind: 'text', expected, passed: actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase()) };
};

/** Injected collaborators for {@link registerQuickTestBridge}. */
export type QuickTestBridgeDeps = {
  /**
   * Resolve the browser WebContents to attach CDP to (null when none is open).
   * When `tabId` is given, resolve THAT embedded tab's WebContents (the Quick
   * Test panel hosts its own browser tab); when omitted, fall back to the
   * focused WebContents so the legacy "open it in the Browser page" flow keeps
   * working.
   */
  getWebContents: (tabId?: string) => CdpWebContents | null;
  /** Load the persisted KG for a repo root (for trace→context mapping). */
  loadGraph: typeof loadGraph;
  /** Open a native log stream (android logcat / windows stdio) for the tracer. */
  openNativeStream: NativeStreamOpener;
};

/**
 * Register the Quick Test IPC handlers. Idempotent. Called once during
 * Main-process bootstrap (after the browser bridge is registered).
 */
export function registerQuickTestBridge(deps: QuickTestBridgeDeps): void {
  // Stream every *significant* recorded event straight to the renderer as it
  // happens (clicks/inputs/navigation + errors — the interaction path that
  // matters live). Routine logs and successful 2xx responses are kept in the
  // buffer for the final trace but not streamed, so a chatty page can't flood
  // the IPC channel. This push model replaces the old 200ms polling diff, which
  // indexed into the buffer by count — unreliable once smart eviction splices
  // events out of the middle. `push` only fires while a tracer is active, so
  // exactly one tracer emits at a time.
  const emitEvent = (event: TraceEvent): void => {
    if (isSignificantEvent(event)) qtChannels.event.emit({ event });
  };

  // The embedded tab the active web session attaches CDP to. Set on `start`
  // and read by the tracer's `getWebContents` closure so CDP binds to the
  // Quick Test panel's own browser tab instead of whatever is focused.
  let activeTabId: string | undefined;

  const webTracer = createQuickTestTracer({
    getWebContents: () => deps.getWebContents(activeTabId),
    onEvent: emitEvent,
  });
  const nativeTracer = createQuickTestNativeTracer({
    openStream: deps.openNativeStream,
    onEvent: emitEvent,
  });

  /** The tracer currently recording (so `stop` hits the right one). */
  let activeTracer: { stop: () => RuntimeTrace } | null = null;
  let activeExpectedText: string | null = null;
  /** Whether the active session is the web tracer (the only one with coverage). */
  let activeIsWeb = false;
  let activeEvidence: TraceEvidence | null = null;
  const adaptiveProbe = createAdaptiveRuntimeProbe({ getWebContents: () => deps.getWebContents(activeTabId) });

  qtChannels.start.provider(async (req): Promise<UnderstandResult<boolean>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.', code: 'error' };
    const platform = req.platform ?? 'web';
    try {
      // Bind the tab id BEFORE starting so the tracer's getWebContents closure
      // resolves the right embedded tab (web only; native ignores it).
      activeTabId = platform === 'web' ? req.tabId : undefined;
      const started =
        platform === 'web'
          ? await webTracer.start(rootPath)
          : await nativeTracer.start(platform, rootPath, req.target ?? '');
      if (started) {
        activeTracer = platform === 'web' ? webTracer : nativeTracer;
        activeIsWeb = platform === 'web';
        activeExpectedText = platform === 'web' ? req.expectedText?.trim() || null : null;
        activeEvidence = adaptiveProbe.inspect(platform, platform !== 'web', nativeTracer.hasStructuredInteractions());
      } else {
        activeTabId = undefined;
        activeEvidence = null;
      }
      return { ok: true, data: started };
    } catch (error) {
      activeTabId = undefined;
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  qtChannels.stop.provider(async (): Promise<UnderstandResult<QtStopResponse>> => {
    try {
      const expectedText = activeExpectedText;
      const verification = expectedText
        ? await verifyExpectedText(deps.getWebContents(activeTabId), expectedText).catch(
            (): QtVerification => ({ kind: 'text', expected: expectedText, passed: false })
          )
        : null;
      // Drain V8 precise coverage (which of the user's functions ran) BEFORE
      // stop detaches the debugger — web only (the native tracer has no CDP).
      if (activeIsWeb) {
        await webTracer.finalizeCoverage().catch((): void => undefined);
      }
      const rawTrace = activeTracer ? activeTracer.stop() : webTracer.stop();
      const trace: RuntimeTrace = { ...rawTrace, ...(activeEvidence ? { evidence: activeEvidence } : {}) };
      activeTracer = null;
      activeExpectedText = null;
      activeIsWeb = false;
      activeTabId = undefined;
      activeEvidence = null;
      // Build a context pack from the trace + the repo's KG (best-effort).
      let contextPack: ContextPack | null = null;
      if (trace.rootPath) {
        const graph = await deps.loadGraph(trace.rootPath).catch((): null => null);
        if (graph) {
          contextPack = buildTraceContext(trace, graph);
        }
      }
      return { ok: true, data: { trace, verification, contextPack } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: 'error' };
    }
  });
}
