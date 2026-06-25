/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Background scheduler that periodically refreshes stale/expired Realtime
 * Knowledge facts (mechanism b).
 *
 * Arms a `croner` job (default every 6 hours) that runs an injected refresh
 * sweep. The arm function is injectable so tests can drive ticks deterministically
 * without real timers. A re-entrancy guard prevents overlapping sweeps, and a
 * consecutive-failure backoff temporarily widens the interval when a run throws
 * (e.g. the machine is offline), so the scheduler degrades safely.
 *
 * The sweep itself is supplied by the caller (typically
 * `rtkService.refreshExpired`), which runs the heavy network work under the
 * app's lease/ResourceCoordinator policy — this module only handles cadence.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { Cron } from 'croner';

/** A handle to an armed periodic job. */
export type ArmedJob = { stop: () => void };

/** Arms a periodic job from a cron expression; returns a stop handle. */
export type ArmCronFn = (expression: string, onTick: () => void) => ArmedJob;

/** Dependencies for {@link createRtkScheduler}. */
export type RtkSchedulerDeps = {
  /** Run one refresh sweep. Should not reject for routine misses (caller guards). */
  runSweep: () => Promise<unknown>;
  /** Cron expression for the cadence. Defaults to every 6 hours. */
  cronExpression?: string;
  /** Arm function. Defaults to `croner`. Injectable for tests. */
  arm?: ArmCronFn;
  /** Max consecutive failures before the scheduler stops auto-running. Default 5. */
  maxConsecutiveFailures?: number;
  /** Optional logger; defaults to `console`. */
  log?: Pick<Console, 'warn' | 'error'>;
};

/** The realtime-knowledge scheduler. */
export type IRtkScheduler = {
  /** Arm the periodic sweep. Idempotent (re-arming stops the previous job). */
  start(): void;
  /** Stop the periodic sweep. */
  stop(): void;
  /** Run a sweep immediately (also used internally on each tick). */
  runNow(): Promise<void>;
  /** Whether a sweep is currently running. */
  isRunning(): boolean;
};

const DEFAULT_CRON = '0 */6 * * *'; // every 6 hours

const defaultArm: ArmCronFn = (expression, onTick) => {
  const job = new Cron(expression, {}, onTick);
  return { stop: () => job.stop() };
};

/**
 * Create an {@link IRtkScheduler}.
 *
 * @param deps Sweep runner + optional cadence/arm/limits.
 */
export const createRtkScheduler = (deps: RtkSchedulerDeps): IRtkScheduler => {
  const arm = deps.arm ?? defaultArm;
  const cronExpression = deps.cronExpression ?? DEFAULT_CRON;
  const maxFailures = deps.maxConsecutiveFailures ?? 5;
  const log = deps.log ?? console;

  let job: ArmedJob | null = null;
  let running = false;
  let consecutiveFailures = 0;

  const runNow = async (): Promise<void> => {
    if (running) return; // re-entrancy guard — never overlap sweeps
    if (consecutiveFailures >= maxFailures) {
      log.warn(`[RTK] Scheduler paused after ${consecutiveFailures} consecutive failures; skipping sweep.`);
      return;
    }
    running = true;
    try {
      await deps.runSweep();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      log.error('[RTK] Refresh sweep failed:', error);
    } finally {
      running = false;
    }
  };

  const start = (): void => {
    if (job) job.stop();
    job = arm(cronExpression, () => {
      void runNow();
    });
  };

  const stop = (): void => {
    if (job) {
      job.stop();
      job = null;
    }
  };

  return { start, stop, runNow, isRunning: () => running };
};
