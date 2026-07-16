/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/manager/reminderScheduler.
 *
 * Covers:
 * - Catch-up on start fires reminders that came due while the app was closed
 *   (criterion 3.3).
 * - Property 5: a fired reminder never fires again.
 * - Snoozed reminders are skipped until the snooze elapses, then fire once.
 * - Completed tasks' reminders are ignored.
 *
 * Uses an in-memory store (real createManagerStore + in-memory fs) and a manual
 * clock + notify spy — no real timers or OS notifications.
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ManagerFs } from '@/process/manager/managerStore';
import { createManagerStore } from '@/process/manager/managerStore';
import { createReminderScheduler } from '@/process/manager/reminderScheduler';

const createMemFs = (): ManagerFs => {
  const files = new Map<string, string>();
  return {
    readFile: async (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    },
    writeFile: async (filePath, data) => void files.set(filePath, data),
    rename: async (oldPath, newPath) => {
      files.set(newPath, files.get(oldPath)!);
      files.delete(oldPath);
    },
    mkdir: async (dirPath) => dirPath,
  };
};

const ROOT = path.join('rem-root');

const setup = (clock: { t: number }) => {
  let seq = 0;
  const store = createManagerStore({ dir: ROOT, fs: createMemFs(), now: () => clock.t, newId: () => `id-${++seq}` });
  const notify = vi.fn();
  const scheduler = createReminderScheduler({
    store,
    notify,
    now: () => clock.t,
    // Manual interval: we drive sweeps explicitly, so never auto-tick.
    setInterval: () => ({ clear: () => undefined }),
  });
  return { store, notify, scheduler };
};

describe('reminderScheduler', () => {
  it('catch-up fires a reminder that came due while closed, then never again (Property 5)', async () => {
    const clock = { t: 1000 };
    const { store, notify, scheduler } = setup(clock);

    // A task with a reminder already past due (fireAt 500 < now 1000).
    await store.addTask({ title: 'Pay rent', reminders: [{ fireAt: 500 }] });

    await scheduler.start(); // runs catch-up sweep
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].title).toBe('Pay rent');

    // Subsequent sweeps must not re-fire.
    await scheduler.sweep();
    await scheduler.sweep();
    expect(notify).toHaveBeenCalledTimes(1);

    // firedAt is stamped on disk/state.
    const task = store.getData().tasks[0];
    expect(task.reminders[0].firedAt).toBe(1000);
  });

  it('does not fire a future reminder until it is due', async () => {
    const clock = { t: 1000 };
    const { store, notify, scheduler } = setup(clock);
    await store.addTask({ title: 'Future', reminders: [{ fireAt: 5000 }] });

    await scheduler.start();
    expect(notify).not.toHaveBeenCalled();

    clock.t = 5000;
    await scheduler.sweep();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('skips a snoozed reminder until the snooze elapses, then fires once', async () => {
    const clock = { t: 1000 };
    const { store, notify, scheduler } = setup(clock);
    const task = await store.addTask({ title: 'Snoozable', reminders: [{ fireAt: 900 }] });
    const reminderId = task.reminders[0].id;

    await scheduler.start();
    expect(notify).toHaveBeenCalledTimes(1); // due at start

    // Snooze for later (resets firedAt).
    await scheduler.snooze(task.id, reminderId, 3000);
    await scheduler.sweep();
    expect(notify).toHaveBeenCalledTimes(1); // still snoozed

    clock.t = 3000;
    await scheduler.sweep();
    expect(notify).toHaveBeenCalledTimes(2); // snooze elapsed → fires
  });

  it('ignores reminders on completed tasks', async () => {
    const clock = { t: 1000 };
    const { store, notify, scheduler } = setup(clock);
    const task = await store.addTask({ title: 'Done already', reminders: [{ fireAt: 500 }] });
    await store.setTaskStatus(task.id, 'done');

    await scheduler.start();
    expect(notify).not.toHaveBeenCalled();
  });

  it('dismiss marks the reminder fired so it never fires', async () => {
    const clock = { t: 1000 };
    const { store, notify, scheduler } = setup(clock);
    const task = await store.addTask({ title: 'Dismiss me', reminders: [{ fireAt: 5000 }] });
    await scheduler.dismiss(task.id, task.reminders[0].id);

    clock.t = 6000;
    await scheduler.start();
    expect(notify).not.toHaveBeenCalled();
  });
});
