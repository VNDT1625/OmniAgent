/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `repoWatcher` — a small, dependency-injected realtime file watcher for the
 * IDE "Understand Anything" feature. When the user turns on Live mode, this
 * watches a repo root for code-file changes and emits DEBOUNCED batches of
 * relative paths (added/changed vs removed) so the knowledge graph can be
 * incrementally rebuilt without the user pressing "Rebuild".
 *
 * Design notes:
 *  - The actual `fs.watch` (recursive) is INJECTED so this module stays pure and
 *    unit-testable with a fake watcher (no real disk, no timers in tests).
 *  - Events are debounced (default 800ms) and coalesced: many rapid saves over a
 *    burst collapse into one {@link RepoChangeEvent}. Editors that emit
 *    rename+change pairs therefore fire the rebuild once, not twice.
 *  - Well-known build/vendor directories and non-code files are ignored so a
 *    `node_modules` churn or a `.git` write never triggers a rebuild.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs at module scope.
 */

import type { RepoChangeEvent } from './understandTypes';

/** Directory names whose changes never trigger a rebuild. */
const IGNORED_DIRS = new Set([
  '\x2eomni',
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  '.aionui',
  '.mtui',
  'coverage',
  '.understand-anything',
  'ide-knowledge',
]);

/** Code file extensions whose changes are relevant to the graph. */
const WATCHED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.json', '.md'];

/** Default debounce window (ms) for coalescing a burst of file events. */
const DEFAULT_DEBOUNCE_MS = 800;

/** A minimal watcher handle (matches the shape of Node's `fs.FSWatcher`). */
export type FsWatcherHandle = {
  /** Stop watching and release the OS handle. */
  close: () => void;
};

/** The raw `fs.watch` event kinds Node reports. */
export type RawWatchEventType = 'rename' | 'change';

/** Injected collaborators so the watcher is pure/testable (no direct `fs`). */
export type RepoWatcherDeps = {
  /**
   * Start watching `rootPath` recursively. The `onEvent` callback receives the
   * raw event type and the path RELATIVE to the root (forward-slash). Returns a
   * handle whose `close()` stops the watch. Mirrors `fs.watch(root, { recursive
   * true })` with the filename normalised by the caller.
   */
  watch: (rootPath: string, onEvent: (type: RawWatchEventType, relPath: string) => void) => FsWatcherHandle;
  /** Whether a relative path currently exists on disk (added/changed vs removed). */
  exists: (rootPath: string, relPath: string) => boolean;
  /** Schedule a debounced flush; returns a cancel handle. Defaults to setTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Cancel a scheduled flush. Defaults to clearTimeout. */
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
};

/** Options for {@link createRepoWatcher}. */
export type RepoWatcherOptions = {
  /** Debounce window in ms (default {@link DEFAULT_DEBOUNCE_MS}). */
  debounceMs?: number;
};

/** The watcher surface returned by {@link createRepoWatcher}. */
export type RepoWatcher = {
  /** Begin watching `rootPath`; `onChange` fires once per debounced burst. */
  start: (rootPath: string, onChange: (event: RepoChangeEvent) => void) => void;
  /** Stop the active watch (idempotent). */
  stop: () => void;
  /** Whether a watch is currently active. */
  isActive: () => boolean;
};

/** Whether a relative path sits under an ignored directory. */
export const isIgnoredPath = (relPath: string): boolean => {
  const segments = relPath.split('/');
  return segments.some((segment) => IGNORED_DIRS.has(segment));
};

/** Whether a relative path names a file the graph cares about. */
export const isWatchedFile = (relPath: string): boolean => {
  const lower = relPath.toLowerCase();
  return WATCHED_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

/**
 * Create a debounced, dependency-injected repo watcher. A single watcher
 * instance tracks at most one active watch at a time; calling `start` again
 * replaces the previous watch (its pending burst is dropped).
 */
export const createRepoWatcher = (deps: RepoWatcherDeps, opts?: RepoWatcherOptions): RepoWatcher => {
  const debounceMs = opts?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimer = deps.setTimer ?? ((fn, ms): ReturnType<typeof setTimeout> => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle): void => clearTimeout(handle));

  let handle: FsWatcherHandle | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeRoot: string | null = null;
  // Pending burst: a path can only be in one bucket — last event wins.
  const pendingChanged = new Set<string>();
  const pendingRemoved = new Set<string>();

  const reset = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    pendingChanged.clear();
    pendingRemoved.clear();
  };

  const stop = (): void => {
    if (handle) {
      try {
        handle.close();
      } catch {
        /* already closed — non-fatal */
      }
      handle = null;
    }
    activeRoot = null;
    reset();
  };

  const start = (rootPath: string, onChange: (event: RepoChangeEvent) => void): void => {
    stop();
    activeRoot = rootPath;

    const flush = (): void => {
      timer = null;
      if (pendingChanged.size === 0 && pendingRemoved.size === 0) {
        return;
      }
      const event: RepoChangeEvent = {
        rootPath,
        changed: Array.from(pendingChanged).toSorted(),
        removed: Array.from(pendingRemoved).toSorted(),
      };
      pendingChanged.clear();
      pendingRemoved.clear();
      onChange(event);
    };

    handle = deps.watch(rootPath, (_type, rawRel) => {
      const relPath = rawRel.replace(/\\/g, '/').replace(/^\.\//, '');
      if (relPath.length === 0 || isIgnoredPath(relPath) || !isWatchedFile(relPath)) {
        return;
      }
      // Classify by current existence: present → changed/added; gone → removed.
      if (deps.exists(rootPath, relPath)) {
        pendingRemoved.delete(relPath);
        pendingChanged.add(relPath);
      } else {
        pendingChanged.delete(relPath);
        pendingRemoved.add(relPath);
      }
      if (timer !== null) {
        clearTimer(timer);
      }
      timer = setTimer(flush, debounceMs);
    });
  };

  return {
    start,
    stop,
    isActive: (): boolean => handle !== null && activeRoot !== null,
  };
};

export default createRepoWatcher;
