/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * docTerminal service — the facade that learns commands and suggests them.
 *
 * - `init` loads the persisted records into memory once.
 * - `capture` is SYNChronous: it updates the in-memory snapshot immediately
 *   (redacting secrets, updating frequency/recency/success counters) and
 *   schedules a single coalesced flush, so suggestions are instant and disk
 *   writes are batched.
 * - `suggest` / `ghost` rank the in-memory records for the current input.
 * - `flush` persists the snapshot through the injected store.
 *
 * The flush scheduler is injected (`schedule`) so tests can drive it
 * deterministically and production can debounce. PURE ranking lives in
 * `commandScore`. Process boundary: Main-process module, no DOM APIs.
 */

import { redactSecrets } from './commandRedact';
import { classifyCommand } from './commandClassify';
import { bestGhost, rankCommands } from './commandScore';
import type { ICommandDocStore } from './commandDocStore';
import type { CommandRecord, CommandSuggestion } from './commandTypes';

/** A captured command event. */
export type CaptureInput = {
  /** The command line that ran (will be redacted before storing). */
  command: string;
  /** Its exit code (0 = success). */
  exitCode: number;
  /** Working directory it ran in (best-effort; optional). */
  cwd?: string;
};

/** Dependencies for {@link createCommandDocService}. */
export type CommandDocServiceDeps = {
  /** Persistence layer. */
  store: ICommandDocStore;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Schedule a coalesced flush. Production passes a debounced timer; tests pass
   * a capturing stub. Called at most once between flushes.
   */
  schedule: (flush: () => void) => void;
};

/** Public contract of the docTerminal service. */
export type ICommandDocService = {
  /** Load persisted records into memory (call once at startup). */
  init(): Promise<void>;
  /** Learn from a command the user ran (synchronous; schedules a flush). */
  capture(input: CaptureInput): void;
  /** Current in-memory records (for inspection/tests). */
  snapshot(): CommandRecord[];
  /** Rank suggestions for the current input. */
  suggest(prefix: string, limit?: number): CommandSuggestion[];
  /** The single best ghost-text completion for the input, or null. */
  ghost(prefix: string): CommandSuggestion | null;
  /** Persist the in-memory snapshot through the store. */
  flush(): Promise<void>;
};

/** Trivial commands not worth learning (shell navigation / noise). */
const isTrivial = (command: string): boolean => {
  const c = command.trim();
  if (c.length < 2) return true;
  return ['ls', 'cd', 'cls', 'clear', 'pwd', 'dir', 'exit'].includes(c.toLowerCase());
};

/**
 * Create an {@link ICommandDocService}.
 *
 * @param deps Store + clock + flush scheduler.
 */
export const createCommandDocService = (deps: CommandDocServiceDeps): ICommandDocService => {
  const now = deps.now ?? Date.now;
  let records: CommandRecord[] = [];
  let dirty = false;
  let flushScheduled = false;

  const scheduleFlush = (): void => {
    if (flushScheduled) return; // coalesce — one scheduled flush until it runs
    flushScheduled = true;
    deps.schedule(() => {
      void flush();
    });
  };

  const init = async (): Promise<void> => {
    records = await deps.store.readAll();
  };

  const capture = (input: CaptureInput): void => {
    const raw = input.command.trim();
    if (raw.length === 0 || isTrivial(raw)) return;
    const command = redactSecrets(raw);
    const program = classifyCommand(command).program;
    const at = now();
    const success = input.exitCode === 0;
    const existing = records.find((r) => r.command === command);
    if (existing) {
      existing.count += 1;
      if (success) existing.successCount += 1;
      existing.lastUsedAt = at;
      existing.lastExitCode = input.exitCode;
      existing.program = program;
      if (input.cwd !== undefined) existing.cwd = input.cwd;
    } else {
      records.push({
        command,
        program,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        count: 1,
        successCount: success ? 1 : 0,
        firstUsedAt: at,
        lastUsedAt: at,
        lastExitCode: input.exitCode,
      });
    }
    dirty = true;
    scheduleFlush();
  };

  const snapshot = (): CommandRecord[] => records;

  const suggest = (prefix: string, limit?: number): CommandSuggestion[] =>
    rankCommands(records, { prefix, now: now() }, limit);

  const ghost = (prefix: string): CommandSuggestion | null => bestGhost(records, { prefix, now: now() });

  const flush = async (): Promise<void> => {
    flushScheduled = false;
    if (!dirty) return;
    dirty = false;
    await deps.store.writeAll(records);
  };

  return { init, capture, snapshot, suggest, ghost, flush };
};
