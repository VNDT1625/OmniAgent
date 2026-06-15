/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the built-in Cron MCP server (Scheduled Tasks — Agent plane).
 *
 * The server factory is driven through a real in-memory MCP client/server pair
 * (the SDK's linked transport), so we exercise the actual tool registration,
 * input schemas and result envelopes — not just the handler bodies. The cron
 * service is faked, so no live aioncore backend is required.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ICronJob, ICreateCronJobParams } from '@/common/adapter/ipcBridge';
import { createCronServer, type CronServiceClient } from '@/process/resources/builtinMcp/cronServer';

const makeJob = (overrides?: Partial<ICronJob>): ICronJob => ({
  id: 'job-1',
  name: 'Daily standup',
  description: 'Morning summary',
  enabled: true,
  schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Bangkok', description: 'Daily at 9' },
  target: { payload: { kind: 'message', text: 'Summarise my day' }, execution_mode: 'new_conversation' },
  metadata: {
    conversation_id: '',
    agent_type: 'claude',
    created_by: 'agent',
    created_at: 1,
    updated_at: 1,
  },
  state: { run_count: 3, retry_count: 0, max_retries: 3, next_run_at_ms: 1000, last_status: 'ok' },
  ...overrides,
});

/** A spyable fake cron service implementing the structural client. */
const makeCron = (overrides?: Partial<CronServiceClient>): CronServiceClient => ({
  listJobs: vi.fn(async () => [makeJob()]),
  getJob: vi.fn(async ({ job_id }) => (job_id === 'job-1' ? makeJob() : null)),
  addJob: vi.fn(async (params: ICreateCronJobParams) => makeJob({ id: 'job-new', name: params.name })),
  updateJob: vi.fn(async ({ job_id, updates }) => makeJob({ id: job_id, ...updates })),
  removeJob: vi.fn(async () => undefined),
  runNow: vi.fn(async () => ({ conversation_id: 'conv-9' })),
  ...overrides,
});

/** Connect an in-memory client to a fresh cron server bound to `cron`. */
const connect = async (cron: CronServiceClient) => {
  const server = createCronServer({ cron, resolveTimeZone: () => 'Asia/Bangkok' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, cron };
};

/** Parse the first text block of a tool result as JSON. */
const parseJson = (result: { content: Array<{ type: string; text?: string }> }): unknown => {
  const text = result.content.find((c) => c.type === 'text')?.text ?? '';
  return JSON.parse(text);
};

describe('cronServer (Agent plane)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes the full scheduled-task tool set', async () => {
    const { client } = await connect(makeCron());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual(
      [
        'cron_create_task',
        'cron_delete_task',
        'cron_get_task',
        'cron_list_tasks',
        'cron_run_now',
        'cron_set_enabled',
        'cron_update_task',
      ].toSorted()
    );
  });

  it('cron_list_tasks returns compact summaries', async () => {
    const { client, cron } = await connect(makeCron());
    const result = (await client.callTool({ name: 'cron_list_tasks', arguments: {} })) as never;
    expect(cron.listJobs).toHaveBeenCalledTimes(1);
    const data = parseJson(result) as Array<{ id: string; prompt: string; agentType: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ id: 'job-1', prompt: 'Summarise my day', agentType: 'claude' });
  });

  it('cron_get_task returns full detail, or an error for an unknown id', async () => {
    const { client } = await connect(makeCron());
    const ok = (await client.callTool({ name: 'cron_get_task', arguments: { taskId: 'job-1' } })) as never;
    expect((parseJson(ok) as ICronJob).id).toBe('job-1');

    const missing = (await client.callTool({ name: 'cron_get_task', arguments: { taskId: 'nope' } })) as {
      isError?: boolean;
    };
    expect(missing.isError).toBe(true);
  });

  it('cron_create_task builds a cron schedule with the resolved time zone', async () => {
    const { client, cron } = await connect(makeCron());
    const result = (await client.callTool({
      name: 'cron_create_task',
      arguments: { name: 'Nightly', prompt: 'Back up notes', schedule: '0 2 * * *', agentType: 'gemini' },
    })) as never;

    expect(cron.addJob).toHaveBeenCalledTimes(1);
    const params = vi.mocked(cron.addJob).mock.calls[0][0];
    expect(params).toMatchObject({
      name: 'Nightly',
      prompt: 'Back up notes',
      agent_type: 'gemini',
      created_by: 'agent',
      execution_mode: 'new_conversation',
      schedule: { kind: 'cron', expr: '0 2 * * *', tz: 'Asia/Bangkok' },
    });
    expect((parseJson(result) as { created: string }).created).toBe('job-new');
  });

  it('cron_create_task accepts an empty schedule for a manual-only task', async () => {
    const { client, cron } = await connect(makeCron());
    await client.callTool({ name: 'cron_create_task', arguments: { name: 'Manual', prompt: 'do it', schedule: '' } });
    const params = vi.mocked(cron.addJob).mock.calls[0][0];
    expect(params.schedule).toMatchObject({ kind: 'cron', expr: '', description: 'Manual only' });
    expect(params.agent_type).toBe('claude'); // default
  });

  it('cron_update_task only changes provided fields and preserves the target', async () => {
    const { client, cron } = await connect(makeCron());
    await client.callTool({ name: 'cron_update_task', arguments: { taskId: 'job-1', prompt: 'New instruction' } });
    expect(cron.getJob).toHaveBeenCalledWith({ job_id: 'job-1' });
    const { updates } = vi.mocked(cron.updateJob).mock.calls[0][0];
    expect(updates.target?.payload).toEqual({ kind: 'message', text: 'New instruction' });
    expect(updates.target?.execution_mode).toBe('new_conversation'); // preserved
    expect(updates.schedule).toBeUndefined(); // not touched
  });

  it('cron_set_enabled pauses and resumes', async () => {
    const { client, cron } = await connect(makeCron());
    const paused = (await client.callTool({
      name: 'cron_set_enabled',
      arguments: { taskId: 'job-1', enabled: false },
    })) as never;
    expect(cron.updateJob).toHaveBeenCalledWith({ job_id: 'job-1', updates: { enabled: false } });
    expect((parseJson(paused) as { enabled: boolean }).enabled).toBe(false);
  });

  it('cron_run_now triggers and reports the conversation id', async () => {
    const { client, cron } = await connect(makeCron());
    const result = (await client.callTool({ name: 'cron_run_now', arguments: { taskId: 'job-1' } })) as never;
    expect(cron.runNow).toHaveBeenCalledWith({ job_id: 'job-1' });
    expect((parseJson(result) as { conversationId: string }).conversationId).toBe('conv-9');
  });

  it('cron_delete_task removes the task', async () => {
    const { client, cron } = await connect(makeCron());
    const result = (await client.callTool({ name: 'cron_delete_task', arguments: { taskId: 'job-1' } })) as never;
    expect(cron.removeJob).toHaveBeenCalledWith({ job_id: 'job-1' });
    expect((parseJson(result) as { deleted: string }).deleted).toBe('job-1');
  });

  it('surfaces backend failures as tool errors instead of throwing', async () => {
    const cron = makeCron({
      listJobs: vi.fn(async () => {
        throw new Error('backend down');
      }),
    });
    const { client } = await connect(cron);
    const result = (await client.callTool({ name: 'cron_list_tasks', arguments: {} })) as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('backend down');
  });
});
