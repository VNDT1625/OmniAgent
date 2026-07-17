/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
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

/** How much of the runtime was observable for this session. */
export type TraceEvidenceLevel = 'full' | 'accessibility' | 'runtime' | 'visual';

/** Adapter and capabilities selected by the adaptive probe. */
export type TraceEvidence = {
  adapter: 'web-cdp' | 'native-accessibility' | 'native-log' | 'visual-fallback';
  level: TraceEvidenceLevel;
  capabilities: Array<'interaction' | 'network' | 'stack' | 'coverage' | 'screen'>;
  noteKey?: 'full' | 'accessibility' | 'runtime' | 'visual';
};

/** A single frame captured from a runtime exception stack. */
export type TraceStackFrame = {
  functionName: string;
  url?: string;
  line?: number;
  column?: number;
};

/** One recorded event in the trace. */
export type TraceEvent =
  | { kind: 'click'; selector: string; text: string; at: number; coverage?: CoverageFunction[] }
  | { kind: 'input'; selector: string; value: string; at: number; coverage?: CoverageFunction[] }
  | { kind: 'navigate'; url: string; at: number }
  | {
      kind: 'network';
      method: string;
      url: string;
      status: number;
      error?: string;
      requestId?: string;
      resourceType?: string;
      requestBody?: string;
      responseHeaders?: Record<string, string>;
      responseBody?: string;
      at: number;
    }
  | { kind: 'console'; level: 'log' | 'warn' | 'error'; message: string; at: number }
  | {
      kind: 'exception';
      message: string;
      stack?: string;
      stackFrames?: TraceStackFrame[];
      url?: string;
      line?: number;
      at: number;
    };

/** The full trace produced by one Quick Test session. */
export type RuntimeTrace = {
  /** Platform the trace was captured on. */
  platform: TracePlatform;
  /** Absolute repo root the IDE had open (for graph mapping). */
  rootPath: string;
  /** Resolved native target (Android serial or Windows executable). */
  target?: string;
  /** All recorded events, oldest first. */
  events: TraceEvent[];
  /** The first error/exception event, if any. */
  firstError: TraceEvent | null;
  /** Timestamp when recording started. */
  startedAt: number;
  /** Timestamp when recording stopped. */
  stoppedAt: number;
  /**
   * The user's OWN functions that actually executed during the session
   * (V8 precise coverage, web only). Ranked by call count. This answers "which
   * code ran when I clicked" — including bugs that throw nothing. Empty when the
   * platform/Profiler did not provide coverage.
   */
  coverage?: CoverageFunction[];
  /** Adaptive probe metadata describing the confidence and adapter used. */
  evidence?: TraceEvidence;
};

// The rolling-buffer policy + error precedence live in `quickTestBuffer` so the
// web + native tracers and the agent service share ONE source of truth.
import { findFirstError, isErrorEvent, pushBounded } from './quickTestBuffer';
// V8 precise coverage — "which of the user's functions actually ran". Same CDP
// session the tracer already owns, so it is driven from here on start/stop.
import { createCoverageRecorder, type CoverageFunction, type CoverageRecorder } from './quickTestCoverage';

export { findFirstError } from './quickTestBuffer';
export type { CoverageFunction } from './quickTestCoverage';

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
  /**
   * Drain V8 precise coverage (which of the user's functions ran) into the next
   * trace. MUST be awaited BEFORE {@link stop}, while the debugger is still
   * attached. Best-effort + idempotent; safe to call when coverage never
   * started. The bridge calls this on the stop path before `stop()`.
   */
  finalizeCoverage: () => Promise<void>;
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

const truncatePayload = (value: string, max = 8192): string => (value.length > max ? `${value.slice(0, max)}…` : value);

const SENSITIVE_FIELD = /(authorization|cookie|password|passwd|secret|token|api[-_]?key)/i;

const sanitizePayload = (value: string): string => {
  try {
    const redact = (entry: unknown): unknown => {
      if (Array.isArray(entry)) return entry.map(redact);
      if (!entry || typeof entry !== 'object') return entry;
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([key, child]) => [
          key,
          SENSITIVE_FIELD.test(key) ? '[REDACTED]' : redact(child),
        ])
      );
    };
    return truncatePayload(JSON.stringify(redact(JSON.parse(value)), null, 2));
  } catch {
    return truncatePayload(value.replace(/((?:password|passwd|secret|token|api[-_]?key)=)[^&\s]*/gi, '$1[REDACTED]'));
  }
};

const headerMap = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') result[key] = SENSITIVE_FIELD.test(key) ? '[REDACTED]' : entry;
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

type NetworkRequestInfo = {
  method: string;
  url: string;
  resourceType?: string;
  requestBody?: string;
};

/** Map a CDP `Network.responseReceived` to a network TraceEvent. */
const mapNetworkResponse = (
  params: Record<string, unknown>,
  now: number,
  requestInfo?: NetworkRequestInfo
): Extract<TraceEvent, { kind: 'network' }> | null => {
  const response = params.response as Record<string, unknown> | undefined;
  const request = params.request as Record<string, unknown> | undefined;
  const url = (response?.url ?? request?.url ?? requestInfo?.url ?? '') as string;
  const method = (request?.method ?? requestInfo?.method ?? 'GET') as string;
  const status = (response?.status ?? 0) as number;
  if (!url) return null;
  const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
  const requestBody =
    typeof request?.postData === 'string' ? sanitizePayload(request.postData) : requestInfo?.requestBody;
  const resourceType = typeof params.type === 'string' ? params.type : requestInfo?.resourceType;
  return {
    kind: 'network',
    method,
    url,
    status,
    requestId,
    resourceType,
    requestBody,
    responseHeaders: headerMap(response?.headers),
    at: now,
  };
};

/** Map a CDP `Network.loadingFailed` to a network error TraceEvent. */
const mapNetworkFailed = (
  params: Record<string, unknown>,
  now: number,
  requestInfo?: NetworkRequestInfo
): Extract<TraceEvent, { kind: 'network' }> | null => {
  const url = ((params.request as Record<string, unknown> | undefined)?.url as string | undefined) ?? requestInfo?.url;
  const error = (params.errorText ?? 'Network error') as string;
  if (!url) return null;
  const requestId = typeof params.requestId === 'string' ? params.requestId : undefined;
  return {
    kind: 'network',
    method: requestInfo?.method ?? 'GET',
    url,
    status: 0,
    requestId,
    requestBody: requestInfo?.requestBody,
    resourceType: requestInfo?.resourceType,
    error,
    at: now,
  };
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
  const stackTrace = (detail.stackTrace ?? exception?.stackTrace) as Record<string, unknown> | undefined;
  const callFrames = Array.isArray(stackTrace?.callFrames) ? stackTrace.callFrames : [];
  const stackFrames = callFrames
    .map((frame) => {
      if (!frame || typeof frame !== 'object') return null;
      const item = frame as Record<string, unknown>;
      return {
        functionName: typeof item.functionName === 'string' && item.functionName ? item.functionName : '(anonymous)',
        url: typeof item.url === 'string' && item.url ? item.url : undefined,
        line: typeof item.lineNumber === 'number' ? item.lineNumber + 1 : undefined,
        column: typeof item.columnNumber === 'number' ? item.columnNumber + 1 : undefined,
      } satisfies TraceStackFrame;
    })
    .filter((frame): frame is NonNullable<typeof frame> => frame !== null);
  const url = (detail.url ?? '') as string;
  const line = (detail.lineNumber ?? 0) as number;
  return { kind: 'exception', message, stack, stackFrames, url, line, at: now };
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

const INTERACTION_BINDING = '__aionuiQuickTestEmit';

const parseBindingInteraction = (
  params: Record<string, unknown>,
  at: number
): Extract<TraceEvent, { kind: 'click' | 'input' }> | null => {
  if (params.name !== INTERACTION_BINDING || typeof params.payload !== 'string') return null;
  try {
    const data = JSON.parse(params.payload) as Record<string, unknown>;
    if (data.kind === 'click') {
      return {
        kind: 'click',
        selector: String(data.selector ?? ''),
        text: String(data.text ?? ''),
        at,
      };
    }
    if (data.kind === 'input') {
      return {
        kind: 'input',
        selector: String(data.selector ?? ''),
        value: String(data.value ?? ''),
        at,
      };
    }
  } catch {
    // Ignore malformed/untrusted binding payloads.
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
(function installAionUiQuickTestListeners() {
  if (window.__aionuiQuickTestListeningV2) return true;
  window.__aionuiQuickTestListeningV2 = true;

  var lastInputValues = new WeakMap();

  function eventElement(raw) {
    var el = raw && raw.nodeType === 1 ? raw : raw && raw.parentElement;
    if (!el) return null;
    var interactive = el.closest && el.closest('button,a,input,select,textarea,[role],[data-testid]');
    return interactive || el;
  }

  function safeToken(value) {
    return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').trim();
  }

  function selector(el) {
    var tag = String(el.tagName || 'element').toLowerCase();
    if (el.id) return tag + '#' + safeToken(el.id);
    var testId = el.getAttribute && el.getAttribute('data-testid');
    if (testId) return tag + '[data-testid=' + safeToken(testId) + ']';
    var name = el.getAttribute && el.getAttribute('name');
    if (name) return tag + '[name=' + safeToken(name) + ']';
    var classValue = el.getAttribute && el.getAttribute('class');
    var classes = typeof classValue === 'string' ? classValue.trim().split(/\\s+/).filter(Boolean).slice(0, 3) : [];
    return tag + (classes.length ? '.' + classes.map(safeToken).join('.') : '');
  }

  function emit(kind, data) {
    var payload = JSON.stringify(Object.assign({ kind: kind }, data));
    try {
      if (typeof window.__aionuiQuickTestEmit === 'function') {
        window.__aionuiQuickTestEmit(payload);
        return;
      }
    } catch (_) {}
    console.log((kind === 'click' ? '[omni-qt-click]' : '[omni-qt-input]') + JSON.stringify(data));
  }

  function recordInput(event) {
    var el = eventElement(event.target);
    if (!el) return;
    var type = String(el.type || '').toLowerCase();
    var value =
      type === 'password'
        ? '[redacted]'
        : type === 'checkbox' || type === 'radio'
          ? String(Boolean(el.checked))
          : String(el.value || '').slice(0, 80);
    if (lastInputValues.get(el) === value) return;
    lastInputValues.set(el, value);
    emit('input', { selector: selector(el), value: value });
  }

  document.addEventListener(
    'click',
    function (event) {
      var el = eventElement(event.target);
      if (!el) return;
      var text = String(el.innerText || el.textContent || '').trim().slice(0, 80);
      emit('click', { selector: selector(el), text: text });
    },
    true
  );
  document.addEventListener('input', recordInput, true);
  document.addEventListener('change', recordInput, true);
  return true;
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
  let attachedWebContents: CdpWebContents | null = null;
  let ownsDebugger = false;
  let rootPath = '';
  let startedAt = 0;
  // Monotonic count of every recorded event (never decreased by buffer
  // eviction) + a cheap O(1) error flag so callers don't rescan the buffer.
  let recorded = 0;
  let errorSeen = false;
  const events: TraceEvent[] = [];
  // V8 precise-coverage recorder for the active session (web/CDP only). Created
  // on `start`, drained once by `finalizeCoverage`, embedded by `stop`.
  let coverageRecorder: CoverageRecorder | null = null;
  let coverageResult: CoverageFunction[] = [];
  // The most recent interaction (click/input) whose triggered code has not yet
  // been attributed. Our capture-phase page listener fires its marker BEFORE the
  // target's own handler runs, so the code an interaction triggers only shows up
  // in the delta taken at the NEXT event (interaction or error). We therefore
  // attribute each delta to this PENDING interaction — making the interaction
  // right before an error carry exactly the functions that broke.
  let pendingInteraction: Extract<TraceEvent, { kind: 'click' | 'input' }> | null = null;
  // Serialises per-interaction delta captures so their async assignments finish
  // (and the recorder's delta baseline stays consistent) before finalize.
  let coverageWork: Promise<unknown> = Promise.resolve();
  let lastInteractionFingerprint = '';
  let lastInteractionAt = 0;
  const networkRequests = new Map<string, NetworkRequestInfo>();
  const networkEvents = new Map<string, Extract<TraceEvent, { kind: 'network' }>>();
  let networkWork: Promise<unknown> = Promise.resolve();

  /** Install listeners in the current document, retrying short navigation races. */
  const injectDomListeners = async (wc: CdpWebContents): Promise<void> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop -- retries must be sequential across document replacement.
        await wc.executeJavaScript(DOM_LISTENER_SCRIPT);
        return;
      } catch (error) {
        lastError = error;
        // eslint-disable-next-line no-await-in-loop -- wait before the next sequential injection attempt.
        await new Promise<void>((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Unable to install Quick Test interaction listeners.');
  };

  /**
   * Attribute the coverage delta accumulated since the last capture to the
   * PENDING interaction (the click/input that triggered it). Chained on
   * {@link coverageWork} so assignments complete before finalize and the delta
   * baseline advances in order. No-op when nothing is pending / coverage is off.
   */
  const capturePendingCoverage = (): void => {
    const target = pendingInteraction;
    const rec = coverageRecorder;
    if (!target || !rec) return;
    coverageWork = coverageWork.then(async () => {
      const fns = await rec.takeDelta().catch((): CoverageFunction[] => []);
      if (fns.length > 0) target.coverage = fns;
    });
  };

  const push = (event: TraceEvent | null): void => {
    if (!event || !active) return;
    pushBounded(events, event);
    recorded += 1;
    if (isErrorEvent(event)) errorSeen = true;
    deps.onEvent?.(event);
  };

  const recordInteraction = (interaction: Extract<TraceEvent, { kind: 'click' | 'input' }>): void => {
    const detail = interaction.kind === 'click' ? interaction.text : interaction.value;
    const fingerprint = `${interaction.kind}\u0000${interaction.selector}\u0000${detail}`;
    if (fingerprint === lastInteractionFingerprint && interaction.at - lastInteractionAt <= 50) return;
    lastInteractionFingerprint = fingerprint;
    lastInteractionAt = interaction.at;
    capturePendingCoverage();
    push(interaction);
    pendingInteraction = interaction;
  };

  const releaseAttachedWebContents = async (): Promise<void> => {
    const wc = attachedWebContents;
    if (!wc) return;
    await wc.debugger.sendCommand('Profiler.stopPreciseCoverage').catch((): void => undefined);
    await wc.debugger.sendCommand('Profiler.disable').catch((): void => undefined);
    try {
      wc.debugger.removeAllListeners('message');
      if (ownsDebugger) wc.debugger.detach();
    } catch {
      // The old tab may already have been destroyed or externally detached.
    }
    attachedWebContents = null;
    ownsDebugger = false;
  };

  const start = async (root: string): Promise<boolean> => {
    const wc = deps.getWebContents();
    if (active && wc === attachedWebContents) return true;
    if (active) {
      active = false;
      await releaseAttachedWebContents();
    }
    if (!wc) return false; // native target — no CDP available

    rootPath = root;
    startedAt = clock();
    events.length = 0;
    recorded = 0;
    errorSeen = false;
    coverageResult = [];
    coverageRecorder = null;
    pendingInteraction = null;
    coverageWork = Promise.resolve();
    lastInteractionFingerprint = '';
    lastInteractionAt = 0;
    networkRequests.clear();
    networkEvents.clear();
    networkWork = Promise.resolve();
    attachedWebContents = wc;
    ownsDebugger = false;
    active = true;

    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
        ownsDebugger = true;
      }
      await wc.debugger.sendCommand('Network.enable');
      await wc.debugger.sendCommand('Runtime.enable');
      await wc.debugger.sendCommand('Page.enable');
      // A CDP binding is independent from the app's console implementation, so
      // interaction delivery survives console.log overrides and log filtering.
      await wc.debugger.sendCommand('Runtime.addBinding', { name: INTERACTION_BINDING }).catch((): void => undefined);
      // Install before every future document's application code. This closes
      // the navigation race where a user could click before executeJavaScript
      // re-injected the listener after Page.frameNavigated.
      await wc.debugger
        .sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: DOM_LISTENER_SCRIPT })
        .catch((): void => undefined);
      // `Debugger.enable` is required for `Debugger.getScriptSource` (used by the
      // coverage recorder to turn function offsets into line numbers).
      await wc.debugger.sendCommand('Debugger.enable').catch((): void => undefined);

      // Begin V8 precise coverage so we can report which of the user's own
      // functions actually ran (the "which code was called" answer). Best-effort:
      // if the Profiler can't start, tracing continues without coverage.
      const recorder = createCoverageRecorder({
        sendCommand: (method, params) => wc.debugger.sendCommand(method, params),
      });
      const ok = await recorder.start().catch((): boolean => false);
      coverageRecorder = ok ? recorder : null;

      wc.debugger.on('message', (_evt, method, params) => {
        const now = clock();
        switch (method) {
          case 'Network.requestWillBeSent': {
            const requestId = typeof params.requestId === 'string' ? params.requestId : '';
            const request = params.request as Record<string, unknown> | undefined;
            const url = typeof request?.url === 'string' ? request.url : '';
            if (requestId && url) {
              networkRequests.set(requestId, {
                method: typeof request?.method === 'string' ? request.method : 'GET',
                url,
                resourceType: typeof params.type === 'string' ? params.type : undefined,
                requestBody: typeof request?.postData === 'string' ? sanitizePayload(request.postData) : undefined,
              });
            }
            break;
          }
          case 'Network.responseReceived': {
            const requestId = typeof params.requestId === 'string' ? params.requestId : '';
            const event = mapNetworkResponse(params, now, networkRequests.get(requestId));
            push(event);
            if (event && requestId) networkEvents.set(requestId, event);
            break;
          }
          case 'Network.loadingFinished': {
            const requestId = typeof params.requestId === 'string' ? params.requestId : '';
            const event = networkEvents.get(requestId);
            if (requestId && event) {
              networkWork = networkWork
                .then(() => wc.debugger.sendCommand('Network.getResponseBody', { requestId }))
                .then((result) => {
                  const body = (result as { body?: unknown }).body;
                  if (typeof body === 'string') event.responseBody = sanitizePayload(body);
                })
                .catch((): void => undefined)
                .finally(() => {
                  networkEvents.delete(requestId);
                  networkRequests.delete(requestId);
                });
            }
            break;
          }
          case 'Network.loadingFailed': {
            const requestId = typeof params.requestId === 'string' ? params.requestId : '';
            push(mapNetworkFailed(params, now, networkRequests.get(requestId)));
            networkRequests.delete(requestId);
            break;
          }
          case 'Runtime.bindingCalled': {
            const interaction = parseBindingInteraction(params, now);
            if (interaction) recordInteraction(interaction);
            break;
          }
          case 'Runtime.consoleAPICalled': {
            // Console markers from our injected listener become typed DOM
            // events at record time (so they survive smart eviction + stream
            // live correctly); all other console messages stay as-is.
            const consoleEv = mapConsole(params, now);
            const marker = consoleEv && consoleEv.kind === 'console' ? parseDomMarker(consoleEv.message, now) : null;
            const ev = marker ?? consoleEv;
            // A new DOM interaction closes the previous one: attribute the
            // coverage delta accumulated since then to the PENDING interaction,
            // then make THIS interaction pending so the next delta lands on it.
            if (ev && (ev.kind === 'click' || ev.kind === 'input')) {
              recordInteraction(ev);
            } else {
              push(ev);
            }
            break;
          }
          case 'Runtime.exceptionThrown':
            // Capture the code that ran up to the throw and attribute it to the
            // interaction that triggered it (so the pre-error click carries the
            // exact functions that broke), then record the exception.
            capturePendingCoverage();
            push(mapException(params, now));
            break;
          case 'Page.frameNavigated': {
            const nav = mapNavigate(params, now);
            push(nav);
            // A top-level navigation replaces the document, dropping our
            // listeners — re-inject so post-navigation clicks are captured.
            if (nav) void injectDomListeners(wc).catch((): void => undefined);
            break;
          }
          default:
            break;
        }
      });

      // Inject a lightweight click/input listener into the page so DOM
      // interactions are captured without full JS coverage overhead.
      await injectDomListeners(wc);
    } catch {
      active = false;
      await releaseAttachedWebContents();
      return false;
    }
    return true;
  };

  /**
   * Drain V8 precise coverage into the trace. MUST be called before {@link stop}
   * (stop detaches the debugger). Async because it fetches script sources over
   * CDP to resolve line numbers. Idempotent + best-effort: a second call or any
   * CDP failure leaves `coverageResult` as-is (possibly empty). Safe to await
   * even when coverage never started (returns immediately).
   */
  const finalizeCoverage = async (): Promise<void> => {
    await networkWork.catch((): void => undefined);
    if (!coverageRecorder) return;
    const recorder = coverageRecorder;
    // Attribute the final pending interaction's delta (the last click/input had
    // no successor to close it), then wait for all per-interaction captures to
    // finish so their `coverage` assignments land before we read the trace.
    capturePendingCoverage();
    pendingInteraction = null;
    await coverageWork.catch((): void => undefined);
    coverageRecorder = null;
    coverageResult = await recorder.finalize().catch((): CoverageFunction[] => []);
  };

  const stop = (): RuntimeTrace => {
    const stoppedAt = clock();
    active = false;
    const wc = attachedWebContents;
    if (wc) {
      try {
        wc.debugger.removeAllListeners('message');
        if (ownsDebugger) wc.debugger.detach();
      } catch {
        /* already detached — non-fatal */
      }
    }
    attachedWebContents = null;
    ownsDebugger = false;

    // Events are already fully typed (DOM markers parsed at record time), so
    // the trace is just a snapshot of the buffer.
    const typed: TraceEvent[] = [...events];
    const firstError = findFirstError(typed);

    return {
      platform: 'web',
      rootPath,
      events: typed,
      firstError,
      startedAt,
      stoppedAt,
      ...(coverageResult.length > 0 ? { coverage: coverageResult } : {}),
    };
  };

  return {
    start,
    stop,
    finalizeCoverage,
    isActive: () => active,
    hasError: () => errorSeen,
    recordedCount: () => recorded,
    currentEvents: () => [...events],
  };
};

export default createQuickTestTracer;
