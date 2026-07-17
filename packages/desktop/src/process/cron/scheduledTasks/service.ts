/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getNextCoreScheduleRunAt, validateCoreSchedule } from './schedule';
import type {
  CoreScheduleAuditEvent,
  CoreScheduleAuditKind,
  CoreScheduleDraft,
  CoreScheduleRunner,
  CoreScheduleRuntime,
  CoreScheduleStore,
  CoreScheduledTask,
} from './types';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

type TimerHandle = { cancel(): void };
type ActiveRun = { runId: string; controller: AbortController };

export type CoreScheduledTaskServiceDeps = {
  store: CoreScheduleStore;
  runner: CoreScheduleRunner;
  now?: () => number;
  newId?: () => string;
  armTimer?: (at: number, onFire: () => void) => TimerHandle;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  onAudit?: (event: CoreScheduleAuditEvent) => void;
};

export type CoreScheduledTaskService = {
  start(): Promise<void>;
  stop(): Promise<void>;
  list(): Promise<CoreScheduledTask[]>;
  get(id: string): Promise<CoreScheduledTask | undefined>;

  listAudit(taskId?: string): Promise<CoreScheduleAuditEvent[]>;
  save(draft: CoreScheduleDraft): Promise<CoreScheduledTask>;
  remove(id: string): Promise<void>;
  runNow(id: string): Promise<void>;
  cancel(id: string): Promise<boolean>;
};

const defaultArmTimer = (at: number, onFire: () => void): TimerHandle => {
  const delay = Math.min(2_147_483_647, Math.max(0, at - Date.now()));
  const timer = setTimeout(onFire, delay);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
};

const defaultWait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('The scheduled run was cancelled.'));
      return;
    }
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const complete = (): void => {
      cleanup();
      resolve();
    };
    const timer = setTimeout(complete, ms);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('The scheduled run was cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
  });

const emptyRuntime = (): CoreScheduleRuntime => ({
  nextRunAt: null,
  lastRunAt: null,
  lastCompletedAt: null,
  lastStatus: 'idle' as const,
  lastError: null,
  activeRunId: null,
  consecutiveFailures: 0,
});

const assertDraft = (draft: CoreScheduleDraft): void => {
  if (!draft.name.trim()) throw new Error('Schedule name cannot be empty.');
  if (!draft.target.prompt.trim()) throw new Error('Scheduled prompt cannot be empty.');
  if (!draft.target.workspace.trim()) throw new Error('Scheduled task requires an explicit workspace.');
  if (!draft.target.targetId.trim()) throw new Error('Scheduled task requires a core target.');
  if (!Number.isInteger(draft.retry.maxAttempts) || draft.retry.maxAttempts < 1)
    throw new Error('Retry maxAttempts must be at least one.');
  if (draft.retry.initialDelayMs < 0 || draft.retry.maxDelayMs < draft.retry.initialDelayMs)
    throw new Error('Invalid scheduled retry delay range.');
  if (draft.retry.backoffMultiplier < 1) throw new Error('Retry backoffMultiplier must be at least one.');
  validateCoreSchedule(draft.schedule);
};

/** Direct, durable scheduler whose only execution dependency is an injected Tomny Core runner. */
export const createCoreScheduledTaskService = (deps: CoreScheduledTaskServiceDeps): CoreScheduledTaskService => {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const armTimer = deps.armTimer ?? defaultArmTimer;
  const wait = deps.wait ?? defaultWait;
  const timers = new Map<string, TimerHandle>();
  const active = new Map<string, ActiveRun>();
  const queued = new Set<string>();
  let started = false;

  const audit = async (
    taskId: string,
    kind: CoreScheduleAuditKind,
    options?: { runId?: string; attempt?: number; detail?: string }
  ): Promise<void> => {
    const event: CoreScheduleAuditEvent = {
      id: newId(),
      taskId,
      kind,
      timestamp: now(),
      ...options,
    };
    await deps.store.appendAudit(event);
    deps.onAudit?.(event);
  };

  const disarm = (taskId: string): void => {
    timers.get(taskId)?.cancel();
    timers.delete(taskId);
  };

  const persistNextRun = async (task: CoreScheduledTask, after: number): Promise<CoreScheduledTask> => {
    const nextRunAt = task.enabled ? getNextCoreScheduleRunAt(task.schedule, after) : null;
    const next = { ...task, runtime: { ...task.runtime, nextRunAt }, updatedAt: now() };
    await deps.store.save(next);
    return next;
  };

  const arm = async (task: CoreScheduledTask): Promise<void> => {
    disarm(task.id);
    if (!started || !task.enabled || task.runtime.nextRunAt === null) return;
    const dueAt = task.runtime.nextRunAt;
    timers.set(
      task.id,
      armTimer(dueAt, () => {
        timers.delete(task.id);
        void deps.store.get(task.id).then(async (fresh) => {
          if (!fresh?.enabled) return;
          if (now() < dueAt) {
            await arm(fresh);
            return;
          }
          const advanced = await persistNextRun(fresh, dueAt);
          await arm(advanced);
          await fire(task.id, dueAt);
        });
      })
    );
    await audit(task.id, 'schedule.armed', { detail: String(dueAt) });
  };

  const finish = async (
    taskId: string,
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    lastError: string | null
  ): Promise<void> => {
    const task = await deps.store.get(taskId);
    if (!task) return;
    const completedAt = now();
    const onceCompleted = task.schedule.kind === 'once';
    const updated: CoreScheduledTask = {
      ...task,
      enabled: onceCompleted ? false : task.enabled,
      runtime: {
        ...task.runtime,
        activeRunId: null,
        lastCompletedAt: completedAt,
        lastStatus: status,
        lastError,
        consecutiveFailures: status === 'failed' ? task.runtime.consecutiveFailures + 1 : 0,
      },
      updatedAt: completedAt,
    };
    updated.runtime.nextRunAt = onceCompleted ? null : task.runtime.nextRunAt;
    await deps.store.save(updated);
    await arm(updated);
  };

  const execute = async (task: CoreScheduledTask, scheduledFor: number, run: ActiveRun): Promise<void> => {
    const runAttempt = async (attempt: number, delay: number): Promise<void> => {
      try {
        if (run.controller.signal.aborted) throw new Error('The scheduled run was cancelled.');
        await deps.runner.run({
          runId: run.runId,
          taskId: task.id,
          scheduledFor,
          attempt,
          target: structuredClone(task.target),
          signal: run.controller.signal,
        });
        await audit(task.id, 'run.completed', { runId: run.runId, attempt });
        await finish(task.id, run.runId, 'completed', null);
      } catch (error) {
        const message = errorMessage(error);
        if (run.controller.signal.aborted) {
          await audit(task.id, 'run.cancelled', { runId: run.runId, attempt, detail: message });
          await finish(task.id, run.runId, 'cancelled', message);
          return;
        }
        if (attempt >= task.retry.maxAttempts) {
          await audit(task.id, 'run.failed', { runId: run.runId, attempt, detail: message });
          await finish(task.id, run.runId, 'failed', message);
          return;
        }
        await audit(task.id, 'run.retrying', { runId: run.runId, attempt, detail: message });
        await wait(delay, run.controller.signal).catch((): undefined => undefined);
        const nextDelay = Math.min(task.retry.maxDelayMs, Math.max(delay, 1) * task.retry.backoffMultiplier);
        await runAttempt(attempt + 1, nextDelay);
      }
    };
    await runAttempt(1, task.retry.initialDelayMs);
  };

  const fire = async (taskId: string, scheduledFor: number, force = false): Promise<void> => {
    const task = await deps.store.get(taskId);
    if (!task || (!task.enabled && !force)) return;
    const current = active.get(taskId);
    if (current) {
      if (task.overlapPolicy === 'queue-one') {
        queued.add(taskId);
        await audit(taskId, 'run.queued', { runId: current.runId });
      } else {
        await audit(taskId, 'run.skipped.overlap', { runId: current.runId });
      }
      return;
    }
    const run: ActiveRun = { runId: newId(), controller: new AbortController() };
    active.set(taskId, run);
    const startedAt = now();
    await deps.store.save({
      ...task,
      runtime: {
        ...task.runtime,
        activeRunId: run.runId,
        lastRunAt: startedAt,
        lastStatus: 'running',
        lastError: null,
      },
      updatedAt: startedAt,
    });
    await audit(taskId, 'run.started', { runId: run.runId, attempt: 1 });
    try {
      await execute(task, scheduledFor, run);
    } finally {
      active.delete(taskId);

      if (queued.delete(taskId)) queueMicrotask(() => void fire(taskId, now()));
    }
  };

  const reconcile = async (task: CoreScheduledTask): Promise<void> => {
    let current = task;
    if (current.runtime.lastStatus === 'running') {
      current = {
        ...current,
        runtime: { ...current.runtime, lastStatus: 'interrupted', activeRunId: null },
        updatedAt: now(),
      };
      await deps.store.save(current);
      await audit(current.id, 'run.interrupted', { detail: 'Recovered after process restart.' });
    }
    const dueAt = current.runtime.nextRunAt;
    if (current.enabled && dueAt !== null && dueAt <= now()) {
      if (current.missedRunPolicy === 'run-once') {
        if (current.schedule.kind === 'cron' || current.schedule.kind === 'interval') {
          current = await persistNextRun(current, now());
          await arm(current);
        }
        queueMicrotask(() => void fire(current.id, dueAt));
        return;
      }
      await audit(current.id, 'run.skipped.missed', { detail: String(dueAt) });
      if (current.schedule.kind === 'once') current = { ...current, enabled: false };
      current = await persistNextRun(current, now());
    } else if (current.enabled && dueAt === null) {
      current = await persistNextRun(current, now());
    }
    await arm(current);
  };

  return {
    async start() {
      if (started) return;
      await deps.store.initialize();
      started = true;
      await Promise.all((await deps.store.list()).map(reconcile));
    },
    async stop() {
      started = false;
      for (const handle of timers.values()) handle.cancel();
      timers.clear();
      queued.clear();
      await Promise.all([...active.values()].map(async (run) => run.controller.abort()));
    },
    list: () => deps.store.list(),
    get: (id) => deps.store.get(id),

    listAudit: (taskId) => deps.store.listAudit(taskId),
    async save(draft) {
      assertDraft(draft);
      const timestamp = now();
      const existing = draft.id ? await deps.store.get(draft.id) : undefined;
      const task: CoreScheduledTask = {
        ...structuredClone(draft),
        id: existing?.id ?? draft.id ?? newId(),
        runtime: existing?.runtime ?? emptyRuntime(),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      task.runtime.nextRunAt = task.enabled ? getNextCoreScheduleRunAt(task.schedule, timestamp) : null;
      await deps.store.save(task);
      await audit(task.id, existing ? 'schedule.updated' : 'schedule.created');
      await arm(task);
      return task;
    },
    async remove(id) {
      disarm(id);
      active.get(id)?.controller.abort();
      queued.delete(id);
      await deps.store.remove(id);
      await audit(id, 'schedule.removed');
    },
    async runNow(id) {
      const task = await deps.store.get(id);
      if (!task) throw new Error(`Scheduled core task not found: ${id}`);
      await fire(id, now(), true);
    },
    async cancel(id) {
      const run = active.get(id);
      if (!run) return false;
      queued.delete(id);
      run.controller.abort();
      return true;
    },
  };
};
