/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `quickTestNativeTracer` — the "user tests, Omni watches" engine for NATIVE
 * targets (Android + Windows desktop), the counterpart of the CDP-based
 * {@link createQuickTestTracer} which only covers the web target.
 *
 * Unlike the web tracer (which attaches CDP to an embedded WebContents), there
 * is no DevTools protocol for a native app. Instead this tracer attaches to the
 * platform's runtime log stream — the same idea, a different pipe:
 *
 *   - **android** — spawns `adb -s <serial> logcat` and parses each line into a
 *     {@link TraceEvent}. Crash/`AndroidRuntime`/`FATAL EXCEPTION` lines become
 *     `exception` events; `E/` priority lines become `console` errors; `W/`
 *     become warnings; everything else is a `console` log. The user drives the
 *     app on the emulator/device by hand while Omni records what the app logs.
 *   - **windows** — attaches to a launched process' stdout/stderr (or one passed
 *     in) and parses each line the same way. An `Unhandled exception` /
 *     `.Exception` / non-zero exit becomes an `exception` event.
 *
 * The output is a {@link RuntimeTrace} with the SAME shape the web tracer
 * produces, so the renderer (`QuickTestPanel`) and the context builder
 * (`traceContextBuilder`) treat all three platforms uniformly. The only
 * difference is `platform` and the kinds of events present (native traces carry
 * `console`/`exception` events, not DOM `click`/`input`).
 *
 * Everything OS-touching (spawning adb, resolving the device serial, attaching
 * to a process) is injected, so the unit tests drive it with fakes — no real
 * emulator/exe needed. Process boundary: Main-process (Node.js) module. No DOM
 * APIs.
 */

import { type RuntimeTrace, type TraceEvent, type TracePlatform } from './quickTestTracer';
import { findFirstError, isErrorEvent, pushBounded } from './quickTestBuffer';

/**
 * A live line stream from a native runtime (adb logcat or a process' stdio).
 * Abstracted so the tracer never imports `child_process` directly — the wiring
 * layer supplies a real implementation, the tests a fake.
 */
/** Identity shared by Windows/Android native adapters and agent evidence. */
export type NativeTargetIdentity = {
  platform: Extract<TracePlatform, 'android' | 'windows'>;
  processId?: number;
  executable?: string;
  windowHandle?: string;
  windowTitle?: string;
  deviceSerial?: string;
};

/** Capability contract lets callers choose the strongest available native path. */
export type NativeAdapterCapabilities = {
  logs: boolean;
  interactions: boolean;
  screenshots: boolean;
  actions: boolean;
  attach: boolean;
};

/** Native replay action accepted by accessibility adapters. */
export type NativeAutomationAction =
  | { kind: 'click'; selector: string }
  | { kind: 'input'; selector: string; value: string };

export type NativeLogStream = {
  /** PID of the launched native target, when the opener owns the process. */
  processId?: number;
  /** Resolved target used for later native replay (Android serial or Windows executable). */
  target?: string;
  /** Stable process/window identity resolved by the native adapter. */
  identity?: NativeTargetIdentity;
  /** Honest capabilities; unsupported operations stay false instead of faking success. */
  capabilities?: NativeAdapterCapabilities;
  /** Register a listener for each emitted log line. */
  onLine: (listener: (line: string) => void) => void;
  /** Register a listener for the stream ending (process exit / adb detach). */
  onClose: (listener: (info: { code: number | null }) => void) => void;
  /** Optional structured UI events supplied by an accessibility adapter. */
  onInteraction?: (listener: (event: Extract<TraceEvent, { kind: 'click' | 'input' }>) => void) => void;

  /** Capture the target window only. */
  captureScreenshot?: () => Promise<Buffer | null>;
  /** Perform one accessibility action for deterministic native replay. */
  performAction?: (action: NativeAutomationAction) => Promise<boolean>;
  /** Stop the stream and release the underlying process/handle. */
  close: () => void;
};

/**
 * Open a {@link NativeLogStream} for the given target. Implementations:
 *   - android → `adb -s <serial> logcat` (clears the buffer first).
 *   - windows → attach to the launched app's stdout/stderr.
 * Returns null when the platform's tooling/target is unavailable (e.g. no adb,
 * no device, no launched process) — the tracer then reports "not available".
 */
export type NativeStreamOpener = (platform: TracePlatform, target: string) => Promise<NativeLogStream | null>;

/** Injected collaborators for {@link createQuickTestNativeTracer}. */
export type QuickTestNativeTracerDeps = {
  /** Open the platform log stream for a target (serial / pid / exe). */
  openStream: NativeStreamOpener;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Optional sink called synchronously for every recorded event, so the IPC
   * bridge can stream events to the renderer as they happen (push) instead of
   * polling the evicting buffer. Mirrors the web tracer's `onEvent`.
   */
  onEvent?: (event: TraceEvent) => void;
};

/** Public contract — mirrors the web {@link QuickTestTracer}, with a target arg. */
export type QuickTestNativeTracer = {
  /**
   * Start recording for a repo root on a native platform.
   *
   * @param platform `'android'` or `'windows'`.
   * @param rootPath Absolute repo root (for trace→context mapping).
   * @param target   Device serial (android) or pid/exe path (windows). May be
   *                 empty when the opener can resolve it itself.
   * @returns false when no log stream could be opened (tooling/target missing).
   */
  start: (platform: TracePlatform, rootPath: string, target: string) => Promise<boolean>;
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
  /** Whether the active stream supplied structured accessibility interactions. */
  hasStructuredInteractions: () => boolean;

  /** Capabilities of the active native adapter. */
  capabilities: () => NativeAdapterCapabilities | null;
  /** Process/window/device identity of the active target. */
  targetIdentity: () => NativeTargetIdentity | null;
  /** Best-effort target-window screenshot. */
  captureScreenshot: () => Promise<Buffer | null>;
  /** Run an accessibility action when supported. */
  performAction: (action: NativeAutomationAction) => Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Log line → TraceEvent mapping
// ---------------------------------------------------------------------------

/** A logcat line carrying a fatal crash signature. */
const CRASH_SIGNATURE = /FATAL EXCEPTION|AndroidRuntime|Unhandled exception|System\.\w+Exception|\bat [\w.$]+\(/;

/** An Android logcat priority tag at the start of a line (e.g. `E/Tag(123):`). */
const LOGCAT_PRIORITY = /^([VDIWEF])\/(.+?)\(\s*\d+\)\s*:\s?(.*)$/;

/**
 * Map one raw native log line to a {@link TraceEvent}. Both Android logcat and
 * a Windows process' stdio funnel through here so the heuristics stay in one
 * place. Returns null for blank lines (skipped).
 */
export const mapNativeLogLine = (raw: string, now: number): TraceEvent | null => {
  const line = raw.replace(/\r$/, '');
  if (line.trim().length === 0) return null;

  // Android logcat format: "E/Tag( 1234): message" — extract priority + body.
  const priorityMatch = line.match(LOGCAT_PRIORITY);
  const priority = priorityMatch?.[1];
  const body = priorityMatch?.[3] ?? line;

  if (CRASH_SIGNATURE.test(line) || priority === 'F') {
    return { kind: 'exception', message: body.slice(0, 500), stack: line.slice(0, 1000), at: now };
  }
  if (priority === 'E') {
    return { kind: 'console', level: 'error', message: body.slice(0, 500), at: now };
  }
  if (priority === 'W') {
    return { kind: 'console', level: 'warn', message: body.slice(0, 500), at: now };
  }
  // Windows / untagged stdio: surface obvious error words as errors.
  if (!priority && /\b(error|exception|fail(ed|ure)?)\b/i.test(line)) {
    return { kind: 'console', level: 'error', message: line.slice(0, 500), at: now };
  }
  return { kind: 'console', level: 'log', message: body.slice(0, 500), at: now };
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a {@link QuickTestNativeTracer} backed by the injected stream opener.
 * The tracer opens the platform log stream on `start`, buffers parsed events
 * (rolling, capped via {@link pushBounded}), and closes the stream on `stop`,
 * keeping the recording window minimal.
 */
export const createQuickTestNativeTracer = (deps: QuickTestNativeTracerDeps): QuickTestNativeTracer => {
  const clock = deps.now ?? (() => Date.now());
  let active = false;
  let platform: TracePlatform = 'android';
  let rootPath = '';

  let resolvedTarget = '';
  let startedAt = 0;
  let recorded = 0;
  let errorSeen = false;
  let stream: NativeLogStream | null = null;
  const events: TraceEvent[] = [];
  let structuredInteractions = false;

  let adapterCapabilities: NativeAdapterCapabilities | null = null;
  let identity: NativeTargetIdentity | null = null;

  const push = (event: TraceEvent | null): void => {
    if (!event || !active) return;
    pushBounded(events, event);
    recorded += 1;
    if (isErrorEvent(event)) errorSeen = true;
    deps.onEvent?.(event);
  };

  const start = async (plat: TracePlatform, root: string, target: string): Promise<boolean> => {
    if (active) return true;
    if (plat !== 'android' && plat !== 'windows') return false;

    const opened = await deps.openStream(plat, target).catch((): null => null);
    if (!opened) return false; // tooling/target missing — no fake recording

    platform = plat;
    rootPath = root;

    resolvedTarget = opened.target?.trim() || target.trim();
    startedAt = clock();
    events.length = 0;
    recorded = 0;
    errorSeen = false;
    stream = opened;
    structuredInteractions = Boolean(opened.onInteraction);

    adapterCapabilities = opened.capabilities ?? {
      logs: true,
      interactions: structuredInteractions,
      screenshots: Boolean(opened.captureScreenshot),
      actions: Boolean(opened.performAction),
      attach: false,
    };
    identity = opened.identity ?? (opened.processId ? { platform: plat, processId: opened.processId } : null);
    active = true;

    opened.onLine((line) => push(mapNativeLogLine(line, clock())));
    opened.onInteraction?.((event) => push(event));
    opened.onClose(({ code }) => {
      if (active && code != null && code !== 0) {
        push({ kind: 'exception', message: `Process exited with code ${code}`, at: clock() });
      }
    });
    return true;
  };

  const stop = (): RuntimeTrace => {
    const stoppedAt = clock();
    active = false;
    if (stream) {
      try {
        stream.close();
      } catch {
        /* already closed — non-fatal */
      }
      stream = null;
    }
    structuredInteractions = false;
    const typed = [...events];
    return {
      platform,
      rootPath,
      ...(resolvedTarget ? { target: resolvedTarget } : {}),
      events: typed,
      firstError: findFirstError(typed),
      startedAt,
      stoppedAt,
    };
  };

  return {
    start,
    stop,
    isActive: () => active,
    hasError: () => errorSeen,
    recordedCount: () => recorded,
    currentEvents: () => [...events],
    hasStructuredInteractions: () => structuredInteractions,

    capabilities: () => (adapterCapabilities ? { ...adapterCapabilities } : null),
    targetIdentity: () => (identity ? { ...identity } : null),
    captureScreenshot: async () => (stream?.captureScreenshot ? stream.captureScreenshot() : null),
    performAction: async (action) => (stream?.performAction ? stream.performAction(action) : false),
  };
};

export default createQuickTestNativeTracer;
