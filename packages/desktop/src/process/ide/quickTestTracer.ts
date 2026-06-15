/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `quickTestTracer` — the "user tests, Omni watches" engine for the IDE.
 *
 * When the user opens Quick Test, Omni attaches a CDP (Chrome DevTools Protocol)
 * session to the embedded browser's WebContents and silently records:
 *   - DOM interactions (clicks, inputs) — maps to component/file via the graph.
 *   - Network requests + responses — surfaces API errors (4xx/5xx).
 *   - Console messages + uncaught exceptions — the actual error text + stack.
 *
 * When the user stops (or an error is detected), the tracer produces a
 * {@link RuntimeTrace}: the ordered sequence of events from the last user action
 * to the first error. This is handed to the Context Builder as a "changed-boost"
 * so the agent receives the exact call chain that led to the bug — not a guess.
 *
 * ## Platform scope
 *
 * CDP is available for the **web** target (Electron's embedded WebContentsView),
 * handled by THIS module. **Android** and **Windows** targets are observed by
 * {@link createQuickTestNativeTracer} (`quickTestNativeTracer.ts`) via `adb
 * logcat` / process stdio respectively — both produce the same
 * {@link RuntimeTrace} shape so the renderer + context builder are platform
 * agnostic.
 *
 * ## Integration with testOrchestrator
 *
 * A recorded trace can be exported as a `TestScenario` (record-and-replay):
 * each DOM interaction becomes a `TestStep` so the orchestrator can re-run the
 * exact sequence on web/android/windows automatically. This is opt-in — the
 * tracer itself never calls the orchestrator.
 *
 * ## Privacy
 *
 * CDP is attached ONLY while Quick Test is active (opt-in, user-triggered).
 * No background recording. The trace is kept in memory and discarded when the
 * IDE workspace closes unless the user explicitly saves it.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

/** The platform the trace was captured on. */
export type TracePlatform = 'web' | 'android' | 'windows';

/** One recorded event in the trace. */
export type TraceEvent =
  | { kind: 'click'; selector: string; text: string; at: number }
  | { kind: 'input'; selector: string; value: string; at: number }
  | { kind: 'navigate'; url: string; at: number }
  | { kind: 'network'; method: string; url: string; status: number; error?: string; at: number }
  | { kind: 'console'; level: 'log' | 'warn' | 'error'; message: string; at: number }
  | { kind: 'exception'; message: string; stack?: string; url?: string; line?: number; at: number };

/** The full trace produced by one Quick Test session. */
export type RuntimeTrace = {
  /** Platform the trace was captured on. */
  platform: TracePlatform;
  /** Absolute repo root the IDE had open (for graph mapping). */
  rootPath: string;
  /** All recorded events, oldest first. */
  events: TraceEvent[];
  /** The first error/exception event, if any. */
  firstError: TraceEvent | null;
  /** Timestamp when recording started. */
  startedAt: number;
  /** Timestamp when recording stopped. */
  stoppedAt: number;
};

// The rolling-buffer policy + error precedence live in `quickTestBuffer` so the
// web + native tracers and the agent service share ONE source of truth.
import { findFirstError, isErrorEvent, pushBounded } from './quickTestBuffer';

export { findFirstError } from './quickTestBuffer';

/** Minimal CDP-capable WebContents surface (Electron's `WebContents` satisfies this). */
export type CdpWebContents = {
  debugger: {
    attach: (version: string) => void;
    detach: () => void;
    sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    on: (event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void) => void;
    removeAllListeners: (event: 'message') => void;
    isAttached: () => boolean;
  };
  executeJavaScript: (code: string) => Promise<unknown>;
};

/** Injected collaborators for {@link createQuickTestTracer}. */
export type QuickTestTracerDeps = {
  /** Resolve the WebContents for the active browser tab (web target). */
  getWebContents: () => CdpWebContents | null;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Optional sink called synchronously for every recorded event. Lets the IPC
   * bridge stream events to the renderer as they happen (push), instead of
   * polling the buffer — which is both more responsive AND correct under the
   * smart-eviction policy (a polled index into an evicting buffer skips/dupes).
   */
  onEvent?: (event: TraceEvent) => void;
};

/** Public contract of the Quick Test tracer. */
export type QuickTestTracer = {
  /** Start recording. Returns false when no WebContents is available (native target). */
  start: (rootPath: string) => Promise<boolean>;
  /** Stop recording and return the completed trace. */
  stop: () => RuntimeTrace;
  /** Whether a recording is currently active. */
  isActive: () => boolean;
  /** Whether an error-like event has been recorded (cheap O(1) check). */
  hasError: () => boolean;
  /** Total events recorded so far, monotonic (never decreased by eviction). */
  recordedCount: () => number;
  /** The events collected so far (live view for streaming to the renderer). */
  currentEvents: () => TraceEvent[];
};

// ---------------------------------------------------------------------------
// CDP event → TraceEvent mapping
// ---------------------------------------------------------------------------

/** Map a CDP `Network.responseReceived` to a network TraceEvent. */
const mapNetworkResponse = (params: Record<string, unknown>, now: number): TraceEvent | null => {
  const response = params.response as Record<string, unknown> | undefined;
  const request = params.request as Record<string, unknown> | undefined;
  const url = (response?.url ?? request?.url ?? '') as string;
  const method = (request?.method ?? 'GET') as string;
  const status = (response?.status ?? 0) as number;
  if (!url) return null;
  return { kind: 'network', method, url, status, at: now };
};

/** Map a CDP `Network.loadingFailed` to a network error TraceEvent. */
const mapNetworkFailed = (params: Record<string, unknown>, now: number): TraceEvent | null => {
  const url = (params.request as Record<string, unknown> | undefined)?.url as string | undefined;
  const error = (params.errorText ?? 'Network error') as string;
  if (!url) return null;
  return { kind: 'network', method: 'GET', url, status: 0, error, at: now };
};

/** Map a CDP `Runtime.consoleAPICalled` to a console TraceEvent. */
const mapConsole = (params: Record<string, unknown>, now: number): TraceEvent | null => {
  const type = (params.type ?? 'log') as string;
  const level: 'log' | 'warn' | 'error' = type === 'error' ? 'error' : type === 'warning' ? 'warn' : 'log';
  const args = (params.args as Array<Record<string, unknown>> | undefined) ?? [];
  const message = args.map((a) => String(a.value ?? a.description ?? '')).join(' ');
  return { kind: 'console', level, message, at: now };
};

/** Map a CDP `Runtime.exceptionThrown` to an exception TraceEvent. */
const mapException = (params: Record<string, unknown>, now: number): TraceEvent | null => {
  const detail = params.exceptionDetails as Record<string, unknown> | undefined;
  if (!detail) return null;
  const exception = detail.exception as Record<string, unknown> | undefined;
  const message = (exception?.description ?? detail.text ?? 'Uncaught exception') as string;
  const stack = (exception?.description ?? '') as string;
  const url = (detail.url ?? '') as string;
  const line = (detail.lineNumber ?? 0) as number;
  return { kind: 'exception', message, stack, url, line, at: now };
};

/**
 * Map a CDP `Page.frameNavigated` (top-level frame only) to a navigate
 * TraceEvent. Sub-frame navigations are ignored — only the main document
 * navigation is part of the user's interaction path.
 */
const mapNavigate = (params: Record<string, unknown>, now: number): TraceEvent | null => {
  const frame = params.frame as Record<string, unknown> | undefined;
  if (!frame || frame.parentId) return null; // sub-frame — not the main document
  const url = (frame.url ?? '') as string;
  if (!url || url === 'about:blank') return null;
  return { kind: 'navigate', url, at: now };
};

/**
 * Parse an injected `[omni-qt-click]` / `[omni-qt-input]` console marker into a
 * typed DOM {@link TraceEvent}. Returns null for any other message.
 *
 * Done at record time (not on stop) so DOM interactions enter the buffer as
 * `click`/`input` events: this (a) makes them "significant" so the smart buffer
 * preserves the interaction path under log pressure, and (b) lets the live
 * stream show real interactions instead of raw marker text.
 */
const parseDomMarker = (message: string, at: number): TraceEvent | null => {
  if (message.startsWith('[omni-qt-click]')) {
    try {
      const data = JSON.parse(message.slice('[omni-qt-click]'.length)) as { selector: string; text: string };
      return { kind: 'click', selector: data.selector, text: data.text, at };
    } catch {
      return null;
    }
  }
  if (message.startsWith('[omni-qt-input]')) {
    try {
      const data = JSON.parse(message.slice('[omni-qt-input]'.length)) as { selector: string; value: string };
      return { kind: 'input', selector: data.selector, value: data.value, at };
    } catch {
      return null;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Page-side script that binds capture-phase click/change listeners and reports
 * each interaction back through `console.log` markers (`[omni-qt-click]` /
 * `[omni-qt-input]`) the tracer parses on stop. Idempotent within a document
 * via the `__omniQtListening` guard; a fresh document (after navigation) resets
 * the guard, so re-running this re-binds on the new page.
 */
const DOM_LISTENER_SCRIPT = `
        (function() {
          if (window.__omniQtListening) return;
          window.__omniQtListening = true;
          document.addEventListener('click', function(e) {
            var el = e.target;
            var sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className.split(' ').join('.') : '');
            var text = (el.textContent || '').trim().slice(0, 80);
            console.log('[omni-qt-click]' + JSON.stringify({ selector: sel, text: text }));
          }, true);
          document.addEventListener('change', function(e) {
            var el = e.target;
            var sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
            console.log('[omni-qt-input]' + JSON.stringify({ selector: sel, value: (el.value || '').slice(0, 80) }));
          }, true);
        })();
      `;

/**
 * Create a {@link QuickTestTracer} backed by the injected collaborators.
 * The tracer attaches CDP to the active WebContents on `start` and detaches on
 * `stop`, keeping the recording window minimal.
 */
export const createQuickTestTracer = (deps: QuickTestTracerDeps): QuickTestTracer => {
  const clock = deps.now ?? (() => Date.now());
  let active = false;
  let rootPath = '';
  let startedAt = 0;
  // Monotonic count of every recorded event (never decreased by buffer
  // eviction) + a cheap O(1) error flag so callers don't rescan the buffer.
  let recorded = 0;
  let errorSeen = false;
  const events: TraceEvent[] = [];

  /** (Re-)inject the page-side DOM listeners. Fire-and-forget, never throws. */
  const injectDomListeners = (wc: CdpWebContents): void => {
    void wc.executeJavaScript(DOM_LISTENER_SCRIPT).catch((): void => undefined);
  };

  const push = (event: TraceEvent | null): void => {
    if (!event || !active) return;
    pushBounded(events, event);
    recorded += 1;
    if (isErrorEvent(event)) errorSeen = true;
    deps.onEvent?.(event);
  };

  const start = async (root: string): Promise<boolean> => {
    if (active) return true;
    const wc = deps.getWebContents();
    if (!wc) return false; // native target — no CDP available

    rootPath = root;
    startedAt = clock();
    events.length = 0;
    recorded = 0;
    errorSeen = false;
    active = true;

    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }
      await wc.debugger.sendCommand('Network.enable');
      await wc.debugger.sendCommand('Runtime.enable');
      await wc.debugger.sendCommand('Page.enable');

      wc.debugger.on('message', (_evt, method, params) => {
        const now = clock();
        switch (method) {
          case 'Network.responseReceived':
            push(mapNetworkResponse(params, now));
            break;
          case 'Network.loadingFailed':
            push(mapNetworkFailed(params, now));
            break;
          case 'Runtime.consoleAPICalled': {
            // Console markers from our injected listener become typed DOM
            // events at record time (so they survive smart eviction + stream
            // live correctly); all other console messages stay as-is.
            const consoleEv = mapConsole(params, now);
            const marker = consoleEv && consoleEv.kind === 'console' ? parseDomMarker(consoleEv.message, now) : null;
            push(marker ?? consoleEv);
            break;
          }
          case 'Runtime.exceptionThrown':
            push(mapException(params, now));
            break;
          case 'Page.frameNavigated': {
            const nav = mapNavigate(params, now);
            push(nav);
            // A top-level navigation replaces the document, dropping our
            // listeners — re-inject so post-navigation clicks are captured.
            if (nav) injectDomListeners(wc);
            break;
          }
          default:
            break;
        }
      });

      // Inject a lightweight click/input listener into the page so DOM
      // interactions are captured without full JS coverage overhead.
      injectDomListeners(wc);
    } catch {
      active = false;
      return false;
    }
    return true;
  };

  const stop = (): RuntimeTrace => {
    const stoppedAt = clock();
    active = false;
    const wc = deps.getWebContents();
    if (wc) {
      try {
        wc.debugger.removeAllListeners('message');
        if (wc.debugger.isAttached()) wc.debugger.detach();
      } catch {
        /* already detached — non-fatal */
      }
    }

    // Events are already fully typed (DOM markers parsed at record time), so
    // the trace is just a snapshot of the buffer.
    const typed: TraceEvent[] = [...events];
    const firstError = findFirstError(typed);

    return { platform: 'web', rootPath, events: typed, firstError, startedAt, stoppedAt };
  };

  return {
    start,
    stop,
    isActive: () => active,
    hasError: () => errorSeen,
    recordedCount: () => recorded,
    currentEvents: () => [...events],
  };
};

export default createQuickTestTracer;
