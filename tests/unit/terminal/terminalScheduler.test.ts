/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/terminal/terminalScheduler — arms saved schedules and
 * fires their scripts into freshly-created sessions. The cron/one-shot timers
 * and the manager are injected so firing is deterministic (no real timers).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ITerminalManager } from '@/process/terminal/terminalManager';
import type { ITerminalScheduleStore } from '@/process/terminal/terminalScheduleStore';
import { createTerminalScheduler } from '@/process/terminal/terminalScheduler';
import type { TerminalSchedule } from '@/process/terminal/terminalTypes';

const makeSchedule = (over?: Partial<TerminalSchedule>): TerminalSchedule => ({
  id: 's1',
  name: 'Launch 9router',
  script: '9router start',
  kind: 'cron',
  cron: '0 9 * * *',
  enabled: true,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const makeManager = () => {
  const create = vi.fn((opts?: unknown) => ({ id: 'sess-1', ...(opts as object) }) as never);
  const write = vi.fn();
  return { create, write } as unknown as ITerminalManager & { create: typeof create; write: typeof write };
};

const makeStore = (schedules: TerminalSchedule[]) => {
  const patch = vi.fn(async () => undefined);
  const store = {
    list: vi.fn(async () => schedules),
    get: vi.fn(async (id: string) => schedules.find((s) => s.id === id)),
    patch,
  } as unknown as ITerminalScheduleStore & { patch: typeof patch };
  return store;
};

describe('terminalScheduler', () => {
  it('arms enabled cron schedules and fires them into a new session', async () => {
    let cronTick: (() => void) | null = null;
    const manager = makeManager();
    const store = makeStore([makeSchedule()]);
    const scheduler = createTerminalScheduler({
      store,
      manager,
      armCron: (_expr, _tz, onTick) => {
        cronTick = onTick;
        return { stop: vi.fn() };
      },
    });

    await scheduler.start();
    expect(cronTick).toBeTypeOf('function');

    cronTick!();
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Launch 9router', scheduled: true }));
    // The script is fed to the session stdin, newline-terminated.
    expect(manager.write).toHaveBeenCalledWith('sess-1', '9router start\n');
    expect(store.patch).toHaveBeenCalledWith('s1', expect.objectContaining({ lastStatus: 'ok' }));
  });

  it('does not arm disabled schedules', async () => {
    const armCron = vi.fn(() => ({ stop: vi.fn() }));
    const scheduler = createTerminalScheduler({
      store: makeStore([makeSchedule({ enabled: false })]),
      manager: makeManager(),
      armCron,
    });

    await scheduler.start();

    expect(armCron).not.toHaveBeenCalled();
  });

  it('skips one-shot schedules whose time is already in the past', async () => {
    const armOnce = vi.fn(() => ({ stop: vi.fn() }));
    const scheduler = createTerminalScheduler({
      store: makeStore([makeSchedule({ kind: 'once', cron: undefined, at: 50 })]),
      manager: makeManager(),
      now: () => 100,
      armOnce,
    });

    await scheduler.start();

    expect(armOnce).not.toHaveBeenCalled();
  });

  it('arms a future one-shot schedule', async () => {
    const armOnce = vi.fn(() => ({ stop: vi.fn() }));
    const scheduler = createTerminalScheduler({
      store: makeStore([makeSchedule({ kind: 'once', cron: undefined, at: 5000 })]),
      manager: makeManager(),
      now: () => 100,
      armOnce,
    });

    await scheduler.start();

    expect(armOnce).toHaveBeenCalledWith(5000, expect.any(Function));
  });

  it('records an error status when firing throws', async () => {
    const manager = makeManager();
    (manager.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('spawn failed');
    });
    const store = makeStore([makeSchedule()]);
    const scheduler = createTerminalScheduler({ store, manager, armCron: (_e, _t, _cb) => ({ stop: vi.fn() }) });

    await scheduler.runNow('s1');

    expect(store.patch).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ lastStatus: 'error', lastError: 'spawn failed' })
    );
  });
});
