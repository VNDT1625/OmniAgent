/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-priority manager for the System Insight feature (Settings › Quan sát).
 *
 * Lets the user nudge the OS scheduling priority of a running process so a heavy
 * background process can be de-prioritised (or a foreground one boosted). Built
 * on Node's `os.setPriority` / `os.constants.priority` — no native dependency.
 *
 * Two layers:
 * - **Immediate** — {@link ProcessPriorityManager.setPriority} applies the nice
 *   value to a live pid right now.
 * - **Persisted (best-effort)** — the chosen level is remembered keyed by the
 *   process *identity* (`type:name`) rather than the ephemeral pid, so the
 *   service can re-apply it to matching processes after a restart (pids change).
 *
 * Raising priority (lower nice) can require elevated privileges; failures are
 * reported as a soft {@link SetPriorityResult} (never thrown) so the UI can show
 * a friendly message.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProcessMetric, ProcessPriorityLevel, SetPriorityResult } from './systemInfoTypes';

/** File (under the injected dir) that persists per-identity priority choices. */
export const PRIORITY_STORE_FILE = 'system-priority.json';

/**
 * Map each user-facing level to an `os` nice value. Lower nice = higher
 * priority. We intentionally avoid `PRIORITY_HIGHEST` (-20, realtime-ish) to
 * keep the machine responsive even when a user boosts a process.
 */
export const PRIORITY_NICE: Record<ProcessPriorityLevel, number> = {
  high: os.constants.priority.PRIORITY_HIGH,
  aboveNormal: os.constants.priority.PRIORITY_ABOVE_NORMAL,
  normal: os.constants.priority.PRIORITY_NORMAL,
  belowNormal: os.constants.priority.PRIORITY_BELOW_NORMAL,
  low: os.constants.priority.PRIORITY_LOW,
};

/** All selectable levels, ordered high → low for UI dropdowns. */
export const PRIORITY_LEVELS: ProcessPriorityLevel[] = ['high', 'aboveNormal', 'normal', 'belowNormal', 'low'];

/** Map a raw nice value back to the nearest level (for displaying current state). */
export const levelFromNice = (nice: number): ProcessPriorityLevel => {
  let best: ProcessPriorityLevel = 'normal';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of PRIORITY_LEVELS) {
    const distance = Math.abs(PRIORITY_NICE[level] - nice);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
};

/** Stable identity for a process across restarts (pid is ephemeral). */
export const processIdentity = (process: Pick<ProcessMetric, 'type' | 'name'>): string =>
  `${process.type}:${process.name}`;

/** External reads/writes injected for testability. */
export type PriorityManagerDeps = {
  /** Apply a nice value to a pid; should throw on failure (e.g. EPERM). */
  setPriority: (pid: number, nice: number) => void;
  /** Directory that holds {@link PRIORITY_STORE_FILE}. */
  storeDir: string;
  /** Read a file as UTF-8 (defaults to `fs.readFileSync`). */
  readFile: (filePath: string) => string;
  /** Write a file as UTF-8 (defaults to atomic-ish `fs.writeFileSync`). */
  writeFile: (filePath: string, data: string) => void;
};

/** Build default deps backed by real `os`/`fs`. */
export const defaultPriorityManagerDeps = (storeDir: string): PriorityManagerDeps => ({
  setPriority: (pid, nice) => os.setPriority(pid, nice),
  storeDir,
  readFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
  writeFile: (filePath, data) => fs.writeFileSync(filePath, data, 'utf-8'),
});

/** Persisted choices: identity (`type:name`) → chosen level. */
type PersistedChoices = Record<string, ProcessPriorityLevel>;

/** Type guard for the persisted-choices JSON shape. */
const isPersistedChoices = (value: unknown): value is PersistedChoices => {
  if (value === null || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(
    (level) => typeof level === 'string' && (PRIORITY_LEVELS as string[]).includes(level)
  );
};

export type ProcessPriorityManager = {
  /** Apply a level to a live pid now, and remember the choice by identity. */
  setPriority: (pid: number, level: ProcessPriorityLevel, identity?: string) => SetPriorityResult;
  /** The remembered level for an identity, or `undefined` if none. */
  getChoice: (identity: string) => ProcessPriorityLevel | undefined;
  /** Re-apply remembered choices to any currently-running matching processes. */
  reapply: (processes: ProcessMetric[]) => void;
};

/**
 * Create a process-priority manager. Loads any persisted choices from disk
 * immediately (tolerating a missing/corrupt file).
 */
export const createPriorityManager = (deps: PriorityManagerDeps): ProcessPriorityManager => {
  const storePath = path.join(deps.storeDir, PRIORITY_STORE_FILE);

  const load = (): PersistedChoices => {
    try {
      const parsed: unknown = JSON.parse(deps.readFile(storePath));
      return isPersistedChoices(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  let choices: PersistedChoices = load();

  const persist = (): void => {
    try {
      deps.writeFile(storePath, JSON.stringify(choices, null, 2));
    } catch (error) {
      console.warn('[SystemInfo] Failed to persist priority choices:', error);
    }
  };

  const setPriority = (pid: number, level: ProcessPriorityLevel, identity?: string): SetPriorityResult => {
    const nice = PRIORITY_NICE[level];
    try {
      deps.setPriority(pid, nice);
      if (identity) {
        choices[identity] = level;
        persist();
      }
      return { ok: true, pid, level };
    } catch (error) {
      return {
        ok: false,
        pid,
        level,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const getChoice = (identity: string): ProcessPriorityLevel | undefined => choices[identity];

  const reapply = (processes: ProcessMetric[]): void => {
    for (const process of processes) {
      const desired = choices[processIdentity(process)];
      if (!desired) continue;
      const desiredNice = PRIORITY_NICE[desired];
      // Skip when already at (or near) the desired priority to avoid churn.
      if (process.priority !== null && levelFromNice(process.priority) === desired) continue;
      try {
        deps.setPriority(process.pid, desiredNice);
      } catch {
        // Best-effort: a process we can no longer touch is silently skipped.
      }
    }
  };

  return { setPriority, getChoice, reapply };
};
