/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/manager/managerBridge — the always-resolve envelope +
 * error classification.
 *
 * The `@office-ai/platform` bridge providers are registered onto channel names;
 * we capture the registered handler functions via a mock so we can invoke them
 * directly and assert the {@link ManagerResult} envelope shape (never a reject).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture providers registered onto each channel name.
const registered = new Map<string, (req: unknown) => Promise<unknown>>();

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: (channel: string) => ({
      provider: (handler: (req: unknown) => Promise<unknown>) => registered.set(channel, handler),
      invoke: vi.fn(),
    }),
    buildEmitter: (_channel: string) => ({ emit: vi.fn(), on: vi.fn() }),
  },
}));

// Avoid importing Electron via notificationBridge / weatherProvider network.
vi.mock('@/process/manager/weatherProvider', () => ({ getForecast: vi.fn(async () => null) }));

import type { IManagerStore } from '@/process/manager/managerStore';
import type { IManagerAi } from '@/process/manager/managerAi';
import type { IReminderScheduler } from '@/process/manager/reminderScheduler';
import { emptyManagerData } from '@/process/manager/managerTypes';
import { MANAGER_CHANNELS, registerManagerBridge, type ManagerResult } from '@/process/manager/managerBridge';

const invoke = async <T>(channel: string, req: unknown = undefined): Promise<ManagerResult<T>> => {
  const handler = registered.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return (await handler(req)) as ManagerResult<T>;
};

const makeStore = (over?: Partial<IManagerStore>): IManagerStore =>
  ({
    load: vi.fn(async () => emptyManagerData()),
    getData: vi.fn(() => emptyManagerData()),
    addTask: vi.fn(async () => ({ id: 't' }) as never),
    updateTask: vi.fn(async () => emptyManagerData()),
    removeTask: vi.fn(async () => emptyManagerData()),
    toggleSubtask: vi.fn(async () => emptyManagerData()),
    setTaskStatus: vi.fn(async () => emptyManagerData()),
    addNote: vi.fn(async () => ({ id: 'n' }) as never),
    updateNote: vi.fn(async () => emptyManagerData()),
    removeNote: vi.fn(async () => emptyManagerData()),
    addEvent: vi.fn(async () => ({ id: 'e' }) as never),
    updateEvent: vi.fn(async () => emptyManagerData()),
    removeEvent: vi.fn(async () => emptyManagerData()),
    setEvents: vi.fn(async () => emptyManagerData()),
    updateSettings: vi.fn(async () => emptyManagerData()),
    updateReminder: vi.fn(async () => emptyManagerData()),
    onChange: vi.fn(() => () => undefined),
    ...over,
  }) as unknown as IManagerStore;

const makeScheduler = (): IReminderScheduler =>
  ({
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    sweep: vi.fn(async () => undefined),
    snooze: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
  }) as unknown as IReminderScheduler;

beforeEach(() => registered.clear());

describe('managerBridge envelope', () => {
  it('wraps a successful mutation as { ok: true, data }', async () => {
    registerManagerBridge({ services: { store: makeStore(), scheduler: makeScheduler() } });
    const result = await invoke(MANAGER_CHANNELS.getData);
    expect(result.ok).toBe(true);
  });

  it('wraps a store failure as { ok: false, code: "error" } and never rejects', async () => {
    const store = makeStore({
      updateTask: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    registerManagerBridge({ services: { store, scheduler: makeScheduler() } });
    const result = await invoke(MANAGER_CHANNELS.updateTask, { id: 'x', patch: {} });
    expect(result).toEqual({ ok: false, error: 'disk full', code: 'error' });
  });

  it('classifies missing AI as code "no-model"', async () => {
    registerManagerBridge({ services: { store: makeStore(), scheduler: makeScheduler() /* no ai */ } });
    const result = await invoke(MANAGER_CHANNELS.aiParseTasks, { description: 'do stuff' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no-model');
  });

  it('classifies a vision-related failure as code "no-vision"', async () => {
    const ai = {
      parseScheduleImage: vi.fn(async () => {
        throw new Error('The selected model cannot read images (no vision).');
      }),
    } as unknown as IManagerAi;
    registerManagerBridge({ services: { store: makeStore(), ai, scheduler: makeScheduler() } });
    const result = await invoke(MANAGER_CHANNELS.aiParseImage, { imageDataUrl: 'data:...' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no-vision');
  });

  it('routes snooze through the scheduler', async () => {
    const scheduler = makeScheduler();
    registerManagerBridge({ services: { store: makeStore(), scheduler } });
    const result = await invoke(MANAGER_CHANNELS.snoozeReminder, { taskId: 't', reminderId: 'r', untilMs: 999 });
    expect(result.ok).toBe(true);
    expect(scheduler.snooze).toHaveBeenCalledWith('t', 'r', 999);
  });
});
