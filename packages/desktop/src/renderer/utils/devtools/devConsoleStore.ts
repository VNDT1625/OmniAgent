/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Developer console store (renderer-only).
 *
 * When the developer console overlay is enabled (Settings → Display → Developer
 * tools), this module patches the global `console.*` methods plus the
 * `window.onerror` / `unhandledrejection` handlers so that every log line and
 * uncaught error is captured into an in-memory ring buffer. The floating
 * {@link DevConsoleOverlay} subscribes to the buffer and renders it live, so a
 * developer can watch runtime logs/errors without opening Chrome DevTools.
 *
 * Design:
 * - **Idempotent install.** `installDevConsole()` patches the console once; the
 *   original methods are kept and still called, so normal DevTools output is
 *   unaffected. `uninstallDevConsole()` restores the originals.
 * - **Bounded memory.** Entries are capped at {@link MAX_ENTRIES}; the oldest are
 *   dropped. This prevents an infinite log from leaking memory.
 * - **No Node APIs.** Pure browser/renderer module.
 *
 * The enabled flag itself is persisted by the caller through `configService`
 * (`'developer.consoleOverlay'`); this module only owns the capture mechanism
 * and the in-memory buffer.
 */

/** Severity of a captured entry. */
export type DevLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

/** A single captured console/error entry. */
export type DevLogEntry = {
  /** Monotonic id, unique per session. */
  id: number;
  /** Capture time (Unix ms). */
  at: number;
  /** Severity. */
  level: DevLogLevel;
  /** Pre-formatted, human-readable message text. */
  text: string;
};

/** Listener invoked with the full (immutable) buffer whenever it changes. */
type Listener = (entries: DevLogEntry[]) => void;

/** Hard cap on retained entries to bound memory use. */
const MAX_ENTRIES = 500;

/** The console methods we intercept. */
const PATCHED_METHODS: DevLogLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

let entries: DevLogEntry[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

let installed = false;
type ConsoleMethod = (...args: unknown[]) => void;
const originalConsole: Partial<Record<DevLogLevel, ConsoleMethod>> = {};
let originalOnError: typeof window.onerror | null = null;
let rejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

/** Safely stringify one console argument for display. */
const formatArg = (arg: unknown): string => {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (arg === undefined) return 'undefined';
  if (arg === null) return 'null';
  try {
    return JSON.stringify(arg, replaceCircular(), 2);
  } catch {
    return String(arg);
  }
};

/** JSON replacer that drops circular references instead of throwing. */
const replaceCircular = () => {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown): unknown => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
};

/** Join console arguments into a single display line. */
const formatArgs = (args: unknown[]): string => args.map(formatArg).join(' ');

const emit = (): void => {
  // Hand out a shallow copy so subscribers can't mutate the internal buffer.
  const snapshot = entries.slice();
  for (const listener of listeners) listener(snapshot);
};

/** Append an entry to the bounded buffer and notify subscribers. */
const push = (level: DevLogLevel, text: string): void => {
  entries.push({ id: nextId++, at: Date.now(), level, text });
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
  emit();
};

/**
 * Install the capture hooks. Idempotent — calling again while already installed
 * is a no-op. The original console methods continue to run, so DevTools output
 * is preserved.
 */
export const installDevConsole = (): void => {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  for (const level of PATCHED_METHODS) {
    const original = console[level] as ConsoleMethod | undefined;
    if (typeof original === 'function') {
      originalConsole[level] = original.bind(console) as ConsoleMethod;
    }
    console[level] = ((...args: unknown[]) => {
      try {
        push(level, formatArgs(args));
      } catch {
        // Never let capture break the app's logging.
      }
      originalConsole[level]?.(...args);
    }) as Console[typeof level];
  }

  originalOnError = window.onerror;
  window.onerror = (message, source, lineno, colno, error) => {
    try {
      const where = source ? ` (${source}:${lineno ?? 0}:${colno ?? 0})` : '';
      push('error', error?.stack || `${String(message)}${where}`);
    } catch {
      /* ignore */
    }
    return originalOnError ? originalOnError(message, source, lineno, colno, error) : false;
  };

  rejectionHandler = (event: PromiseRejectionEvent) => {
    try {
      const reason = event.reason;
      push(
        'error',
        `Unhandled promise rejection: ${reason instanceof Error ? reason.stack || reason.message : formatArg(reason)}`
      );
    } catch {
      /* ignore */
    }
  };
  window.addEventListener('unhandledrejection', rejectionHandler);
};

/** Restore the original console methods and error handlers. */
export const uninstallDevConsole = (): void => {
  if (!installed || typeof window === 'undefined') return;
  installed = false;

  for (const level of PATCHED_METHODS) {
    const original = originalConsole[level];
    if (original) console[level] = original as Console[typeof level];
  }
  window.onerror = originalOnError;
  if (rejectionHandler) window.removeEventListener('unhandledrejection', rejectionHandler);
  rejectionHandler = null;
};

/** Subscribe to buffer changes. Returns an unsubscribe function. */
export const subscribeDevConsole = (listener: Listener): (() => void) => {
  listeners.add(listener);
  listener(entries.slice());
  return () => {
    listeners.delete(listener);
  };
};

/** Current snapshot of captured entries. */
export const getDevConsoleEntries = (): DevLogEntry[] => entries.slice();

/** Clear the buffer and notify subscribers. */
export const clearDevConsole = (): void => {
  entries = [];
  emit();
};

/** Whether the capture hooks are currently installed (test/debug aid). */
export const isDevConsoleInstalled = (): boolean => installed;
