import { describe, expect, it, vi } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  JsonCoreScheduleStore,
  MemoryCoreScheduleStore,
  createCoreScheduledTaskService,
  getNextCoreScheduleRunAt,
  type CoreScheduleDraft,
  type CoreScheduledTask,
} from '@/process/cron/scheduledTasks';

const draft = (overrides?: Partial<CoreScheduleDraft>): CoreScheduleDraft => ({
  name: 'Daily code review',
  enabled: true,
  schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Ho_Chi_Minh' },
  overlapPolicy: 'skip',
  missedRunPolicy: 'skip',
  retry: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100, backoffMultiplier: 2 },
  target: {
    targetId: 'codex',
    prompt: 'Review the workspace',
    workspace: 'C:\\workspace',
    modelKey: 'gpt-test',
    permissionMode: 'workspace-write',

    unattendedPermissionPolicy: 'allow-granted',
    surface: 'ide',
    agentId: 'reviewer',
    personalId: 'owner',
    permissionScopes: ['filesystem.write'],
    capabilityGrants: ['ide.read'],
    availableCapabilities: ['ide.read'],
    modelCapabilities: ['tools'],
  },
  ...overrides,
});

const savedTask = (overrides?: Partial<CoreScheduledTask>): CoreScheduledTask => ({
  ...draft(),
  id: 'task-1',
  runtime: {
    nextRunAt: 50,
    lastRunAt: null,
    lastCompletedAt: null,
    lastStatus: 'idle',
    lastError: null,
    activeRunId: null,
    consecutiveFailures: 0,
  },
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('core scheduled task service', () => {
  it('runs with the saved workspace, model, surface, context and permission snapshot', async () => {
    const runner = { run: vi.fn(async () => undefined) };
    const service = createCoreScheduledTaskService({
      store: new MemoryCoreScheduleStore(),
      runner,
      now: () => 1_000,
      newId: () => 'stable-id',
    });
    const task = await service.save(draft());

    await service.runNow(task.id);

    expect(runner.run).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        target: expect.objectContaining({
          workspace: 'C:\\workspace',
          modelKey: 'gpt-test',
          permissionMode: 'workspace-write',
          surface: 'ide',
          personalId: 'owner',
        }),
      })
    );
  });

  it('retries transient runner failures with bounded exponential backoff', async () => {
    const runner = { run: vi.fn().mockRejectedValueOnce(new Error('busy')).mockResolvedValue(undefined) };
    const wait = vi.fn(async () => undefined);
    const store = new MemoryCoreScheduleStore();
    const service = createCoreScheduledTaskService({ store, runner, wait, now: () => 1_000 });
    const task = await service.save(draft());

    await service.runNow(task.id);

    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(10, expect.any(AbortSignal));
    expect((await store.listAudit(task.id)).map((event) => event.kind)).toContain('run.retrying');
  });

  it('queues at most one overlapping run when queue-one is selected', async () => {
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runner = {
      run: vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValue(undefined),
    };
    const service = createCoreScheduledTaskService({ store: new MemoryCoreScheduleStore(), runner });
    const task = await service.save(draft({ overlapPolicy: 'queue-one' }));

    const firstRun = service.runNow(task.id);
    await tick();
    await service.runNow(task.id);
    await service.runNow(task.id);
    releaseFirst?.();
    await firstRun;
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(2));

    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('applies queue-one when a long run crosses the next cron occurrence', async () => {
    let current = Date.parse('2026-07-17T00:00:00.000Z');
    const armed: Array<{ at: number; fire: () => void }> = [];
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runner = {
      run: vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValue(undefined),
    };
    const store = new MemoryCoreScheduleStore();
    const service = createCoreScheduledTaskService({
      store,
      runner,
      now: () => current,
      armTimer: (at, fire) => {
        armed.push({ at, fire });
        return { cancel: vi.fn() };
      },
    });
    await service.save(
      draft({
        schedule: { kind: 'cron', expression: '* * * * *', timezone: 'UTC' },
        overlapPolicy: 'queue-one',
      })
    );
    await service.start();

    current = armed[0].at;
    armed[0].fire();
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    current = armed[1].at;
    armed[1].fire();
    await vi.waitFor(async () => {
      expect((await store.listAudit()).map((event) => event.kind)).toContain('run.queued');
    });
    releaseFirst?.();

    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(2));
    await service.stop();
  });

  it('allows a disabled schedule to be run manually without arming it', async () => {
    const runner = { run: vi.fn(async () => undefined) };
    const service = createCoreScheduledTaskService({ store: new MemoryCoreScheduleStore(), runner });
    const task = await service.save(draft({ enabled: false }));

    await service.runNow(task.id);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(await service.listAudit(task.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'run.completed' })])
    );
  });

  it('cancels an active run and does not retry it', async () => {
    const runner = {
      run: vi.fn(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          })
      ),
    };
    const store = new MemoryCoreScheduleStore();
    const service = createCoreScheduledTaskService({ store, runner });
    const task = await service.save(draft());

    const running = service.runNow(task.id);
    await vi.waitFor(() => expect(runner.run).toHaveBeenCalledTimes(1));
    expect(await service.cancel(task.id)).toBe(true);
    await running;

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect((await store.get(task.id))?.runtime.lastStatus).toBe('cancelled');
  });

  it('recovers an interrupted missed run once after restart', async () => {
    const store = new MemoryCoreScheduleStore();
    await store.save(
      savedTask({
        missedRunPolicy: 'run-once',
        runtime: { ...savedTask().runtime, nextRunAt: 50, lastStatus: 'running', activeRunId: 'old-run' },
      })
    );
    const runner = { run: vi.fn(async () => undefined) };
    const service = createCoreScheduledTaskService({ store, runner, now: () => 100 });

    await service.start();
    await tick();
    await tick();

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect((await store.listAudit('task-1')).map((event) => event.kind)).toContain('run.interrupted');
  });

  it('skips a missed one-shot task when its policy is skip', async () => {
    const store = new MemoryCoreScheduleStore();
    await store.save(
      savedTask({
        schedule: { kind: 'once', at: 50, timezone: 'UTC' },
        missedRunPolicy: 'skip',
      })
    );
    const runner = { run: vi.fn(async () => undefined) };
    const service = createCoreScheduledTaskService({ store, runner, now: () => 100 });

    await service.start();

    expect(runner.run).not.toHaveBeenCalled();
    expect((await store.get('task-1'))?.enabled).toBe(false);
  });

  it('rejects invalid timezone before persisting a task', async () => {
    const service = createCoreScheduledTaskService({
      store: new MemoryCoreScheduleStore(),
      runner: { run: vi.fn(async () => undefined) },
    });

    await expect(
      service.save(draft({ schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' } }))
    ).rejects.toThrow('Invalid schedule timezone');
  });
});

describe('JSON core schedule store', () => {
  it('restores tasks and audit events after a process restart', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tomny-schedules-'));
    const filePath = path.join(directory, 'scheduled-tasks.json');
    try {
      const first = new JsonCoreScheduleStore(filePath);
      await first.initialize();
      await first.save(savedTask());
      await first.appendAudit({ id: 'audit-1', taskId: 'task-1', kind: 'run.started', timestamp: 10 });

      const restored = new JsonCoreScheduleStore(filePath);
      await restored.initialize();

      expect((await restored.get('task-1'))?.target.surface).toBe('ide');
      expect(await restored.listAudit('task-1')).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('core schedule calculation', () => {
  it('calculates cron time in the selected timezone', () => {
    const next = getNextCoreScheduleRunAt(
      { kind: 'cron', expression: '0 9 * * *', timezone: 'Asia/Ho_Chi_Minh' },
      Date.parse('2026-07-17T00:00:00.000Z')
    );

    expect(next).toBe(Date.parse('2026-07-17T02:00:00.000Z'));
  });

  it('returns no next run for an expired one-shot schedule', () => {
    expect(getNextCoreScheduleRunAt({ kind: 'once', at: 50, timezone: 'UTC' }, 100)).toBeNull();
  });
});
