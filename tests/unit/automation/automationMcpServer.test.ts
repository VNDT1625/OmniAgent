/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Automation MCP server — drives the tools through an in-memory
 * MCP client over the SDK's linked in-process transport, against fake deps.
 */

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAutomationServer, type AutomationServerDeps } from '@/process/automation/automationMcpServer';
import type { Workflow } from '@/process/automation/automationTypes';

const wf = (id: string, name: string): Workflow => ({
  id,
  name,
  nodes: [{ id: 'n1', kind: 'trigger.manual', name: 'Start', config: {} }],
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
});

const makeDeps = (overrides: Partial<AutomationServerDeps> = {}): AutomationServerDeps => ({
  listWorkflows: vi.fn().mockResolvedValue([wf('w1', 'Alpha')]),
  getWorkflow: vi.fn().mockResolvedValue(wf('w1', 'Alpha')),
  saveWorkflow: vi.fn(async (input) => ({ ...wf('w-new', input.name), ...input, id: 'w-new' })),
  removeWorkflow: vi.fn().mockResolvedValue([]),
  runWorkflow: vi.fn().mockResolvedValue({ runId: 'run-1' }),
  cancelRun: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

/** Connect a client to the server over a linked in-memory transport pair. */
const connect = async (deps: AutomationServerDeps) => {
  const server = createAutomationServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

/** Pull the text out of an MCP tool result. */
const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
};

describe('automationMcpServer', () => {
  it('exposes the expected tool set', async () => {
    const client = await connect(makeDeps());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      'automation_cancel_run',
      'automation_create_workflow',
      'automation_delete_workflow',
      'automation_enable_workflow',
      'automation_get_workflow',
      'automation_list_workflows',
      'automation_run_workflow',
    ]);
  });

  it('lists workflows as compact summaries', async () => {
    const client = await connect(makeDeps());
    const result = await client.callTool({ name: 'automation_list_workflows', arguments: {} });
    const parsed = JSON.parse(textOf(result)) as Array<{ id: string; name: string; nodeCount: number }>;
    expect(parsed[0]).toMatchObject({ id: 'w1', name: 'Alpha', nodeCount: 1, triggerKind: 'trigger.manual' });
  });

  it('creates a workflow from a JSON node spec', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const nodes = JSON.stringify([
      { id: 'n1', kind: 'trigger.manual', name: 'Start', config: {} },
      { id: 'n2', kind: 'action.log', name: 'Log', config: {} },
    ]);
    const result = await client.callTool({ name: 'automation_create_workflow', arguments: { name: 'My Flow', nodes } });
    expect(deps.saveWorkflow).toHaveBeenCalledWith(expect.objectContaining({ name: 'My Flow', enabled: true }));
    expect(textOf(result)).toContain('created');
  });

  it('rejects invalid nodes JSON', async () => {
    const client = await connect(makeDeps());
    const result = await client.callTool({
      name: 'automation_create_workflow',
      arguments: { name: 'Bad', nodes: 'not-json' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/invalid nodes/i);
  });

  it('runs a workflow and returns the runId', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: 'automation_run_workflow', arguments: { workflowId: 'w1' } });
    expect(deps.runWorkflow).toHaveBeenCalledWith('w1');
    expect(textOf(result)).toContain('run-1');
  });

  it('enables/disables a workflow', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    await client.callTool({ name: 'automation_enable_workflow', arguments: { workflowId: 'w1', enabled: false } });
    expect(deps.saveWorkflow).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1', enabled: false }));
  });
});
