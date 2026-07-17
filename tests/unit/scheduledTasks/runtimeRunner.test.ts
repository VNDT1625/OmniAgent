import { describe, expect, it, vi } from 'vitest';
import {
  bindScheduledCoreRuntime,
  createScheduledCoreRuntimeRunner,
  type CoreScheduleRunInput,
  type ScheduledCoreRuntimeEvent,
  type ScheduledCoreRuntimePort,
} from '@/process/cron/scheduledTasks';

const input = (overrides?: Partial<CoreScheduleRunInput>): CoreScheduleRunInput => ({
  runId: 'run-1',
  taskId: 'task-1',
  scheduledFor: 100,
  attempt: 1,
  signal: new AbortController().signal,
  target: {
    targetId: 'tomny',
    prompt: 'Inspect the project',
    workspace: 'C:\\workspace',
    modelKey: 'model-1',
    permissionMode: 'workspace-write',
    unattendedPermissionPolicy: 'allow-granted',
    surface: 'ide',
    agentId: 'coder',
    personalId: 'owner',
    permissionScopes: ['tomny_read', 'tomny_edit.*'],
    capabilityGrants: ['ide.read'],
    availableCapabilities: ['ide.read'],
    modelCapabilities: ['tools'],
  },
  ...overrides,
});

const runtimePort = () => {
  const listeners = new Set<(event: ScheduledCoreRuntimeEvent) => void>();
  const port: ScheduledCoreRuntimePort = {
    start: vi.fn((request) => ({ requestId: request.requestId, sessionId: request.sessionId ?? 'session-1' })),
    cancel: vi.fn(async () => true),
    resolvePermission: vi.fn(() => true),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return {
    port,
    emit: (event: ScheduledCoreRuntimeEvent): void => listeners.forEach((listener) => listener(event)),
  };
};

describe('scheduled core runtime runner', () => {
  it('binds the current positional ExperimentalCoreRuntime API without modifying it', async () => {
    const direct = {
      start: vi.fn(() => ({ requestId: 'run-1', sessionId: 'session-1' })),
      cancel: vi.fn(async () => true),
      resolvePermission: vi.fn(() => true),
    };
    const listeners = new Set<(event: ScheduledCoreRuntimeEvent) => void>();
    const port = bindScheduledCoreRuntime(direct, (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const runner = createScheduledCoreRuntimeRunner(port);

    const running = runner.run(input());
    listeners.forEach((listener) => listener({ requestId: 'run-1', type: 'completed' }));
    await running;

    expect(direct.start).toHaveBeenCalledWith(
      'run-1',
      'tomny',
      'Inspect the project',
      'C:\\workspace',
      'model-1',
      'workspace-write',
      undefined,
      undefined,
      expect.objectContaining({ surface: 'ide' })
    );
  });

  it('maps the durable target snapshot into a direct runtime start', async () => {
    const runtime = runtimePort();
    const runner = createScheduledCoreRuntimeRunner(runtime.port);

    const running = runner.run(input());
    runtime.emit({ requestId: 'run-1', type: 'completed' });
    await running;

    expect(runtime.port.start).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'run-1',
        targetId: 'tomny',
        workspace: 'C:\\workspace',
        modelKey: 'model-1',
        contextIdentity: expect.objectContaining({ surface: 'ide', personalId: 'owner' }),
      })
    );
  });

  it('only auto-approves tools covered by the unattended permission snapshot', async () => {
    const runtime = runtimePort();
    const runner = createScheduledCoreRuntimeRunner(runtime.port);

    const running = runner.run(input());
    runtime.emit({ requestId: 'run-1', type: 'permission', permissionId: 'p1', tool: 'tomny_edit.file' });
    runtime.emit({ requestId: 'run-1', type: 'permission', permissionId: 'p2', tool: 'shell.exec' });
    runtime.emit({ requestId: 'run-1', type: 'completed' });
    await running;

    expect(runtime.port.resolvePermission).toHaveBeenNthCalledWith(1, 'p1', true);
    expect(runtime.port.resolvePermission).toHaveBeenNthCalledWith(2, 'p2', false);
  });

  it('denies every unattended permission when policy is deny', async () => {
    const runtime = runtimePort();
    const runner = createScheduledCoreRuntimeRunner(runtime.port);
    const denied = input({ target: { ...input().target, unattendedPermissionPolicy: 'deny' } });

    const running = runner.run(denied);
    runtime.emit({ requestId: 'run-1', type: 'permission', permissionId: 'p1', tool: 'tomny_read' });
    runtime.emit({ requestId: 'run-1', type: 'completed' });
    await running;

    expect(runtime.port.resolvePermission).toHaveBeenCalledWith('p1', false);
  });

  it('cancels the direct runtime and rejects immediately when the scheduler aborts', async () => {
    const runtime = runtimePort();
    const runner = createScheduledCoreRuntimeRunner(runtime.port);
    const controller = new AbortController();

    const running = runner.run(input({ signal: controller.signal }));
    controller.abort();

    await expect(running).rejects.toThrow('cancelled');
    expect(runtime.port.cancel).toHaveBeenCalledWith('run-1');
  });

  it('fails fast when the runtime returns a mismatched request id', async () => {
    const runtime = runtimePort();
    vi.mocked(runtime.port.start).mockReturnValue({ requestId: 'other-run', sessionId: 'session-1' });
    const runner = createScheduledCoreRuntimeRunner(runtime.port);

    await expect(runner.run(input())).rejects.toThrow('mismatched request id');
  });
  it('propagates a terminal runtime error to scheduler retry policy', async () => {
    const runtime = runtimePort();
    const runner = createScheduledCoreRuntimeRunner(runtime.port);

    const running = runner.run(input());
    runtime.emit({ requestId: 'run-1', type: 'error', text: 'provider overloaded' });

    await expect(running).rejects.toThrow('provider overloaded');
  });
});
