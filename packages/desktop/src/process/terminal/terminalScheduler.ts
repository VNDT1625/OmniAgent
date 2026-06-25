/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal scheduler (Phase 2) — arms saved {@link TerminalSchedule}s and fires
 * their scripts into freshly-spawned terminal sessions at the scheduled time.
 *
 * Built on `croner` (already a dependency) for cron-expression schedules, plus
 * a one-shot `setTimeout` path for `kind: 'once'`. Firing a schedule:
 *  1. asks the {@link ITerminalManager} to create a session (shell/cwd from the
 *     schedule, `scheduled: true` so the UI can distinguish them), then
 *  2. writes the script to the session's stdin (newline-terminated lines), so a
 *     long-lived tool like `9router` keeps running in that session.
 *
 * The script is NOT auto-killed — the whole point is to leave the launched tool
 * running. The session shows up in the manager's list like any other.
 *
 * Safety: schedules only fire while the app is running (no OS-level cron is
 * installed), and never run over a remote channel — they are local-only by
 * construction.
 *
 * The Cron factory, clock, and timeout scheduler are injectable for tests.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { Cron } from 'croner';
import type { ITerminalManager } from './terminalManager';
import type { ITerminalScheduleStore } from './terminalScheduleStore';
import type { TerminalSchedule } from './terminalTypes';

/** A handle that can be stopped (cron job or one-shot timer). */
type Armed = { stop: () => void };

/** Injected dependencies for {@link createTerminalScheduler}. */
export type TerminalSchedulerDeps = {
  store: ITerminalScheduleStore;
  manager: ITerminalManager;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Arm a cron expression. Defaults to a `croner` `Cron` wrapper. Injectable so
   * tests can fire deterministically without real timers.
   */
  armCron?: (expr: string, tz: string | undefined, onTick: () => void) => Armed;
  /** Arm a one-shot timer at `whenMs`. Defaults to `setTimeout`. */
  armOnce?: (whenMs: number, onTick: () => void) => Armed;
};

/** Public contract of the scheduler. */
export type ITerminalScheduler = {
  /** Load schedules and arm all enabled ones. Idempotent. */
  start(): Promise<void>;
  /** Disarm everything (does not delete schedules). */
  stop(): void;
  /** Re-read the store and re-arm (call after any schedule mutation). */
  reload(): Promise<void>;
  /** Fire a schedule immediately (manual "Run now"). */
  runNow(id: string): Promise<void>;
};

const defaultArmCron = (expr: string, tz: string | undefined, onTick: () => void): Armed => {
  const job = new Cron(expr, tz ? { timezone: tz } : {}, onTick);
  return { stop: () => job.stop() };
};

const defaultArmOnce = (whenMs: number, onTick: () => void): Armed => {
  const delay = Math.max(0, whenMs - Date.now());
  const timer = setTimeout(onTick, delay);
  return { stop: () => clearTimeout(timer) };
};

/** Create a terminal scheduler bound to a store + manager. */
export const createTerminalScheduler = (deps: TerminalSchedulerDeps): ITerminalScheduler => {
  const now = deps.now ?? Date.now;
  const armCron = deps.armCron ?? defaultArmCron;
  const armOnce = deps.armOnce ?? defaultArmOnce;

  /** id → armed handle for every currently-armed schedule. */
  const armed = new Map<string, Armed>();
  let started = false;

  /** Spawn a session for the schedule and feed it the script. */
  const fire = async (schedule: TerminalSchedule): Promise<void> => {
    try {
      const session = deps.manager.create({
        shell: schedule.shell,
        cwd: schedule.cwd,
        title: schedule.name,
        scheduled: true,
      });
      // Write each non-empty line as a command. A trailing newline submits the
      // last line so the launched tool actually starts.
      const body = schedule.script.endsWith('\n') ? schedule.script : `${schedule.script}\n`;
      deps.manager.write(session.id, body);
      await deps.store.patch(schedule.id, { lastRunAt: now(), lastStatus: 'ok', lastError: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[TerminalScheduler] fire failed:', message);
      await deps.store.patch(schedule.id, { lastRunAt: now(), lastStatus: 'error', lastError: message });
    }
  };

  const disarm = (id: string): void => {
    const handle = armed.get(id);
    if (handle) {
      handle.stop();
      armed.delete(id);
    }
  };

  const arm = (schedule: TerminalSchedule): void => {
    disarm(schedule.id);
    if (!schedule.enabled) return;
    const onTick = (): void => {
      void fire(schedule);
    };
    if (schedule.kind === 'cron' && schedule.cron && schedule.cron.trim().length > 0) {
      try {
        armed.set(schedule.id, armCron(schedule.cron.trim(), schedule.tz, onTick));
      } catch (error) {
        console.error(`[TerminalScheduler] invalid cron "${schedule.cron}":`, error);
      }
    } else if (schedule.kind === 'once' && typeof schedule.at === 'number') {
      // Skip one-shots already in the past (e.g. fired before an app restart).
      if (schedule.at > now()) armed.set(schedule.id, armOnce(schedule.at, onTick));
    }
  };

  const disarmAll = (): void => {
    for (const handle of armed.values()) handle.stop();
    armed.clear();
  };

  const reload = async (): Promise<void> => {
    disarmAll();
    const schedules = await deps.store.list();
    for (const schedule of schedules) arm(schedule);
  };

  return {
    async start() {
      if (started) return;
      started = true;
      await reload();
    },
    stop() {
      disarmAll();
      started = false;
    },
    reload,
    async runNow(id) {
      const schedule = await deps.store.get(id);
      if (schedule) await fire(schedule);
    },
  };
};
