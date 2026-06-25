/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reminder scheduler for the Personal Manager feature (Requirement 3.1–3.3,
 * 3.6).
 *
 * Reminders are scheduled **in the Main process** with a simple 60s ticker —
 * deliberately NOT through aioncore's cron (which is for running *agent tasks*,
 * not personal reminders, and would require an HTTP round-trip / backend
 * change). On {@link IReminderScheduler.start} the scheduler first runs a
 * **catch-up** pass so reminders that came due while the app was closed are not
 * swallowed (criterion 3.3); thereafter the ticker fires due reminders each
 * minute.
 *
 * A reminder fires once: after firing, `firedAt` is stamped via the store and it
 * is never fired again (Property 5). Snoozed reminders (`snoozedTo > now`) are
 * skipped until their snooze elapses. Notifications go through the injected
 * `notify` (defaults to `showNotification`, which already honours the
 * `system.notificationEnabled` setting — criterion 3.2).
 *
 * Testability: `notify`, `now`, and the interval scheduler are injectable so the
 * fire/catch-up/no-double-fire behaviour is unit-testable without real timers or
 * the OS notification system.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { IManagerStore } from './managerStore';
import type { Reminder, Task } from './managerTypes';

/** Notification payload the scheduler emits per due reminder. */
export type ReminderNotification = { title: string; body: string };

/** Injected dependencies for {@link createReminderScheduler}. */
export type ReminderSchedulerDeps = {
  /** The shared Manager store (source of tasks + reminder state). */
  store: IManagerStore;
  /** Deliver a notification. Defaults at call sites to `showNotification`. */
  notify: (n: ReminderNotification) => void | Promise<void>;
  /** Clock. Defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  /**
   * Schedule a repeating tick. Defaults to `setInterval`. Returns a handle the
   * scheduler later clears. Injectable so tests can drive ticks manually.
   */
  setInterval?: (handler: () => void, ms: number) => { clear: () => void };
  /** Tick period in ms. Defaults to 60_000 (one minute). */
  tickMs?: number;
};

/** Public contract of the reminder scheduler. */
export type IReminderScheduler = {
  /** Run an immediate catch-up pass, then begin ticking. Idempotent. */
  start(): Promise<void>;
  /** Stop ticking. */
  stop(): void;
  /** Run a single sweep now (also used internally by the ticker). */
  sweep(): Promise<void>;
  /** Snooze a reminder until `untilMs`. */
  snooze(taskId: string, reminderId: string, untilMs: number): Promise<void>;
  /** Dismiss a reminder (mark fired so it won't fire again). */
  dismiss(taskId: string, reminderId: string): Promise<void>;
};

/** Whether a reminder is due to fire at `now` (Property 5). */
const isDue = (r: Reminder, now: number): boolean => {
  if (r.firedAt != null) return false; // already fired — never again
  if (r.snoozedTo != null && r.snoozedTo > now) return false; // snoozed
  const at = r.snoozedTo != null ? r.snoozedTo : r.fireAt;
  return at <= now;
};

/** Build a short notification body for a task reminder. */
const buildNotification = (task: Task): ReminderNotification => ({
  title: task.title,
  body: task.dueAt != null ? `Reminder · due ${new Date(task.dueAt).toLocaleString()}` : 'Reminder',
});

/**
 * Create a reminder scheduler bound to a {@link IManagerStore}.
 */
export const createReminderScheduler = (deps: ReminderSchedulerDeps): IReminderScheduler => {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? 60_000;
  const scheduleInterval =
    deps.setInterval ??
    ((handler: () => void, ms: number) => {
      const id = setInterval(handler, ms);
      return { clear: () => clearInterval(id) };
    });

  let handle: { clear: () => void } | undefined;
  let started = false;
  /** Guards against overlapping sweeps (a slow notify shouldn't double-run). */
  let sweeping = false;

  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      const at = now();
      // Re-read from the store each sweep so external edits are respected.
      const data = deps.store.getData();
      for (const task of data.tasks) {
        if (task.status === 'done') continue; // no reminders for completed tasks
        for (const reminder of task.reminders) {
          if (!isDue(reminder, at)) continue;
          try {
            await deps.notify(buildNotification(task));
          } catch (error) {
            console.error('[ReminderScheduler] notify failed:', error);
          }
          // Stamp firedAt so it never fires again (Property 5), even if notify threw.
          await deps.store.updateReminder(task.id, reminder.id, { firedAt: at, snoozedTo: null });
        }
      }
    } finally {
      sweeping = false;
    }
  };

  return {
    sweep,

    async start() {
      if (started) return;
      started = true;
      // Ensure the store cache is populated before the first sweep (catch-up).
      await deps.store.load();
      await sweep(); // catch-up pass for reminders due while the app was closed
      handle = scheduleInterval(() => {
        void sweep();
      }, tickMs);
    },

    stop() {
      handle?.clear();
      handle = undefined;
      started = false;
    },

    async snooze(taskId, reminderId, untilMs) {
      await deps.store.updateReminder(taskId, reminderId, { snoozedTo: untilMs, firedAt: null });
    },

    async dismiss(taskId, reminderId) {
      await deps.store.updateReminder(taskId, reminderId, { firedAt: now() });
    },
  };
};
