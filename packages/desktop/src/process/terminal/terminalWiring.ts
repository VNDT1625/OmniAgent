/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wiring for the Terminal feature — builds the single set of services the
 * renderer Terminal page (via `terminalBridge`) and the global bootstrap share.
 *
 * {@link getTerminalServices} lazily constructs (and then caches) the session
 * manager, the schedule store, and the scheduler. The store resolves its
 * on-disk root from the Electron `userData` dir lazily, so no `app` access
 * happens at import time.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { createTerminalManager, type ITerminalManager } from './terminalManager';
import { createTerminalScheduleStore, type ITerminalScheduleStore } from './terminalScheduleStore';
import { createTerminalScheduler, type ITerminalScheduler } from './terminalScheduler';
import { tryCreateNodePtyBackend } from './nodePtyBackend';

/** The shared Terminal services for the whole Main process. */
export type TerminalServices = {
  manager: ITerminalManager;
  store: ITerminalScheduleStore;
  scheduler: ITerminalScheduler;
};

let shared: TerminalServices | undefined;

/**
 * Resolve the shared {@link TerminalServices}, constructing the defaults on
 * first use. The manager prefers a real `node-pty` PTY backend (VS Code-grade
 * TTY: colors, resize, full-screen TUIs) and falls back to the `child_process`
 * pipe backend when the native module is unavailable. The scheduler arms saved
 * schedules against that same manager (so a scheduled script spawns a session
 * visible in the Terminal list like any other).
 */
export const getTerminalServices = (): TerminalServices => {
  if (shared) return shared;
  // Prefer the real pty; fall back to the piped child_process backend (null →
  // createTerminalManager uses its built-in child_process default).
  const backend = tryCreateNodePtyBackend() ?? undefined;
  const manager = createTerminalManager(backend ? { backend } : {});
  const store = createTerminalScheduleStore();
  const scheduler = createTerminalScheduler({ store, manager });
  shared = { manager, store, scheduler };
  return shared;
};

/** Reset the cached services (deterministic teardown for tests/hot-reload). */
export const disposeTerminalServices = (): void => {
  shared?.scheduler.stop();
  shared?.manager.dispose();
  shared = undefined;
};
