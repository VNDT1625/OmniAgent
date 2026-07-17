import { describe, expect, it, vi } from 'vitest';
import { createCoreScheduledTaskIpcHandlers, type CoreScheduledTaskService } from '@/process/cron/scheduledTasks';

describe('scheduled task IPC contract', () => {
  it('routes serializable commands to the direct-core service', async () => {
    const service = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      save: vi.fn(),
      remove: vi.fn(async () => undefined),
      runNow: vi.fn(async () => undefined),
      cancel: vi.fn(async () => true),
      listAudit: vi.fn(async () => []),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    } as unknown as CoreScheduledTaskService;
    const handlers = createCoreScheduledTaskIpcHandlers(service);

    await handlers.runNow({ id: 'task-1' });
    await handlers.cancel({ id: 'task-1' });
    await handlers.listAudit({ taskId: 'task-1' });

    expect(service.runNow).toHaveBeenCalledWith('task-1');
    expect(service.cancel).toHaveBeenCalledWith('task-1');
    expect(service.listAudit).toHaveBeenCalledWith('task-1');
  });
});
