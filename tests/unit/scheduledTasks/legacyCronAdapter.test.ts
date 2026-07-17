import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  LegacyCronAdapter,
  MemoryCoreScheduleStore,
  createCoreScheduledTaskService,
  type CoreScheduledTaskService,
} from '@/process/cron/scheduledTasks';
import type { ICreateCronJobParams } from '@/common/adapter/ipcBridge';

const params = (overrides?: Partial<ICreateCronJobParams>): ICreateCronJobParams => ({
  name: 'Workspace review',
  description: 'Review every morning',
  schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Ho_Chi_Minh', description: 'Daily' },
  message: 'Review this workspace',
  conversation_id: 'conversation-1',
  conversation_title: 'Review',
  agent_type: 'codex',
  created_by: 'user',
  execution_mode: 'new_conversation',
  agent_config: {
    backend: 'codex',
    name: 'Codex',
    mode: 'full-access',
    model_id: 'gpt-test',
    workspace: 'C:\\workspace',
  },
  ...overrides,
});

describe('legacy Cron compatibility over Tomny scheduledTasks', () => {
  let directory: string;
  let service: CoreScheduledTaskService;
  let adapter: LegacyCronAdapter;
  const created = vi.fn();
  const updated = vi.fn();
  const removed = vi.fn();
  const executed = vi.fn();

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'tomny-cron-'));
    service = createCoreScheduledTaskService({
      store: new MemoryCoreScheduleStore(),
      runner: { run: vi.fn(async () => undefined) },
      now: () => 1_000,
      newId: (() => {
        let id = 0;
        return () => `id-${++id}`;
      })(),
    });
    await service.start();
    adapter = new LegacyCronAdapter({
      service,
      skillsDirectory: directory,
      defaultWorkspace: 'C:\\default',
      timezone: () => 'UTC',
      events: { created, updated, removed, executed },
    });
  });

  afterEach(async () => {
    await service.stop();
    await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('round-trips the existing UI contract through the Tomny store', async () => {
    const added = await adapter.addJob(params());

    expect(added).toMatchObject({
      name: 'Workspace review',
      schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Ho_Chi_Minh' },
      metadata: {
        conversation_id: 'conversation-1',
        agent_type: 'codex',
        agent_config: { model_id: 'gpt-test', workspace: 'C:\\workspace' },
      },
    });
    expect((await service.get(added.id))?.target).toMatchObject({
      targetId: 'codex',
      workspace: 'C:\\workspace',
      modelKey: 'gpt-test',
      permissionMode: 'full-access',
    });
    expect(created).toHaveBeenCalledWith(expect.objectContaining({ id: added.id }));
  });

  it('preserves manual and interval schedules without depending on AionCore cron', async () => {
    const manual = await adapter.addJob(params({ schedule: { kind: 'cron', expr: '', description: 'Manual only' } }));
    const interval = await adapter.addJob(
      params({
        name: 'Interval',
        conversation_id: 'conversation-2',
        schedule: { kind: 'every', everyMs: 60_000, description: 'Every minute' },
      })
    );

    expect((await service.get(manual.id))?.schedule).toEqual({ kind: 'manual', timezone: 'UTC' });
    expect((await service.get(interval.id))?.schedule).toEqual({
      kind: 'interval',
      everyMs: 60_000,
      timezone: 'UTC',
    });
    expect((await adapter.getJob({ job_id: interval.id }))?.schedule).toMatchObject({
      kind: 'every',
      everyMs: 60_000,
    });
  });

  it('maps the built-in aionrs identity to Tomny while retaining provider metadata', async () => {
    const job = await adapter.addJob(
      params({
        agent_type: 'aionrs',
        agent_config: {
          backend: 'provider-row-id',
          name: '9Router',
          mode: 'yolo',
          model_id: 'cx/gpt',
        },
      })
    );

    expect((await service.get(job.id))?.target).toMatchObject({
      targetId: 'tomny',
      workspace: 'C:\\default',
      modelKey: 'app-provider:provider-row-id:cx%2Fgpt',
    });
    expect(job.metadata.agent_config?.backend).toBe('provider-row-id');
  });

  it('updates, filters and removes through one durable source of truth', async () => {
    const first = await adapter.addJob(params());
    await adapter.addJob(params({ name: 'Other', conversation_id: 'conversation-2' }));

    const changed = await adapter.updateJob({
      job_id: first.id,
      updates: { name: 'Renamed', enabled: false },
    });

    expect(changed).toMatchObject({ id: first.id, name: 'Renamed', enabled: false });
    expect(await adapter.listJobsByConversation({ conversation_id: 'conversation-1' })).toHaveLength(1);
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ id: first.id, enabled: false }));

    await adapter.removeJob({ job_id: first.id });

    expect(await adapter.getJob({ job_id: first.id })).toBeNull();
    expect(removed).toHaveBeenCalledWith(first.id);
  });

  it('runs a manual task and emits the legacy execution result', async () => {
    const job = await adapter.addJob(params({ schedule: { kind: 'cron', expr: '', description: 'Manual only' } }));

    const result = await adapter.runNow({ job_id: job.id });

    expect(result).toEqual({ conversation_id: 'conversation-1' });
    expect(executed).toHaveBeenCalledWith({ job_id: job.id, status: 'ok' });
    expect((await adapter.getJob({ job_id: job.id }))?.state.run_count).toBe(1);
  });

  it('keeps per-task skill content in the Tomny-owned skill directory', async () => {
    const job = await adapter.addJob(params());

    expect(await adapter.hasSkill({ job_id: job.id })).toBe(false);
    await adapter.saveSkill({ job_id: job.id, content: '# Review skill' });
    expect(await adapter.hasSkill({ job_id: job.id })).toBe(true);
    await adapter.deleteSkill({ job_id: job.id });
    expect(await adapter.hasSkill({ job_id: job.id })).toBe(false);
  });

  it('rejects updates for tasks that do not exist', async () => {
    await expect(adapter.updateJob({ job_id: 'missing', updates: { name: 'Nope' } })).rejects.toThrow(
      'Scheduled task not found'
    );
  });
});
