/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createWorkflowEngine } from '@/process/automation/workflowEngine';
import type { NodeExecutorMap } from '@/process/automation/nodeExecutors';
import type { RunEvent, Workflow, WorkflowNode } from '@/process/automation/automationTypes';

/** Build a workflow from a list of nodes. */
const workflow = (nodes: WorkflowNode[]): Workflow => ({
  id: 'wf-1',
  name: 'Test workflow',
  nodes,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
});

const node = (id: string, kind: WorkflowNode['kind'], name = id): WorkflowNode => ({ id, kind, name, config: {} });

/** Passthrough executor table; individual kinds overridden per test. */
const passthroughExecutors = (): NodeExecutorMap => {
  const pass = (_n: WorkflowNode, ctx: { input: unknown }) => Promise.resolve(ctx.input);
  const map: Partial<NodeExecutorMap> = {};
  // Fill every leaf kind with a passthrough so the map is complete.
  const leafKinds: Array<keyof NodeExecutorMap> = [
    'trigger.manual',
    'trigger.schedule',
    'trigger.webhook',
    'action.http',
    'action.ai',
    'action.transform',
    'action.delay',
    'action.log',
    'action.set',
    'action.code',
    'action.filesystem',
    'action.app.makeVideo',
    'action.app.editor',
    'action.notify',
    'action.manager',
    'action.browser',
    'action.conversation',
    'action.cron',
    'action.subworkflow',
    'action.cloud.upload',
    'action.email.send',
    'action.social.facebook',
    'action.social.tiktok',
    'action.company',
  ];
  for (const kind of leafKinds) map[kind] = pass;
  return map as NodeExecutorMap;
};

describe('createWorkflowEngine', () => {
  it('runs a linear pipeline and threads output between nodes', async () => {
    const events: RunEvent[] = [];
    const executors = passthroughExecutors();
    executors['trigger.manual'] = () => Promise.resolve('seed');
    executors['action.transform'] = (_n, ctx) => Promise.resolve(`${String(ctx.input)}->t`);
    executors['action.log'] = (_n, ctx) => Promise.resolve(ctx.input);

    const engine = createWorkflowEngine({
      executors,
      emit: (e) => events.push(e),
      now: () => 42,
      newRunId: () => 'run-1',
    });
    const result = await engine.run(
      workflow([node('a', 'trigger.manual'), node('b', 'action.transform'), node('c', 'action.log')])
    );

    expect(result).toMatchObject({ runId: 'run-1', ok: true });
    const finishes = events.filter((e): e is Extract<RunEvent, { type: 'node-finish' }> => e.type === 'node-finish');
    expect(finishes.map((f) => f.output)).toEqual(['seed', 'seed->t', 'seed->t']);
  });

  it('emits the full event sequence in order', async () => {
    const events: RunEvent[] = [];
    const engine = createWorkflowEngine({
      executors: passthroughExecutors(),
      emit: (e) => events.push(e),
      now: () => 1,
      newRunId: () => 'run-1',
    });

    await engine.run(workflow([node('a', 'trigger.manual'), node('b', 'action.log')]));

    expect(events.map((e) => e.type)).toEqual([
      'run-start',
      'node-start',
      'node-finish',
      'node-start',
      'node-finish',
      'run-finish',
    ]);
    expect(events.every((e) => e.runId === 'run-1')).toBe(true);
  });

  it('fails fast: a thrown node emits ok:false and stops later nodes', async () => {
    const events: RunEvent[] = [];
    const executors = passthroughExecutors();
    const thirdRan = vi.fn();
    executors['action.http'] = () => Promise.reject(new Error('boom'));
    executors['action.log'] = (n, ctx) => {
      thirdRan();
      return Promise.resolve(ctx.input);
    };

    const engine = createWorkflowEngine({
      executors,
      emit: (e) => events.push(e),
      now: () => 1,
      newRunId: () => 'run-1',
    });
    const result = await engine.run(
      workflow([node('a', 'trigger.manual'), node('b', 'action.http'), node('c', 'action.log')])
    );

    expect(result.ok).toBe(false);
    expect(thirdRan).not.toHaveBeenCalled();

    const failed = events.find(
      (e): e is Extract<RunEvent, { type: 'node-finish' }> => e.type === 'node-finish' && !e.ok
    );
    expect(failed?.nodeId).toBe('b');
    expect(failed?.error).toBe('boom');

    const runFinish = events.find((e): e is Extract<RunEvent, { type: 'run-finish' }> => e.type === 'run-finish');
    expect(runFinish?.ok).toBe(false);
  });

  it('does not emit a node-start for nodes after the failing one', async () => {
    const events: RunEvent[] = [];
    const executors = passthroughExecutors();
    executors['action.http'] = () => Promise.reject(new Error('boom'));

    const engine = createWorkflowEngine({
      executors,
      emit: (e) => events.push(e),
      now: () => 1,
      newRunId: () => 'run-1',
    });
    await engine.run(workflow([node('a', 'action.http'), node('b', 'action.log')]));

    const starts = events.filter((e): e is Extract<RunEvent, { type: 'node-start' }> => e.type === 'node-start');
    expect(starts.map((s) => s.nodeId)).toEqual(['a']);
  });

  it('stops between nodes when the signal is already aborted', async () => {
    const events: RunEvent[] = [];
    const controller = new AbortController();
    controller.abort();

    const engine = createWorkflowEngine({
      executors: passthroughExecutors(),
      emit: (e) => events.push(e),
      now: () => 1,
      newRunId: () => 'run-1',
    });
    const result = await engine.run(workflow([node('a', 'trigger.manual')]), { signal: controller.signal });

    expect(result.ok).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['run-start', 'run-finish']);
  });

  it('stops mid-pipeline when aborted after the first node', async () => {
    const events: RunEvent[] = [];
    const controller = new AbortController();
    const executors = passthroughExecutors();
    executors['action.transform'] = (_n, ctx) => {
      controller.abort();
      return Promise.resolve(ctx.input);
    };

    const engine = createWorkflowEngine({
      executors,
      emit: (e) => events.push(e),
      now: () => 1,
      newRunId: () => 'run-1',
    });
    const result = await engine.run(workflow([node('a', 'action.transform'), node('b', 'action.log')]), {
      signal: controller.signal,
    });

    expect(result.ok).toBe(false);
    const starts = events.filter((e): e is Extract<RunEvent, { type: 'node-start' }> => e.type === 'node-start');
    expect(starts.map((s) => s.nodeId)).toEqual(['a']);
  });

  it('uses an externally-provided runId when given', async () => {
    const events: RunEvent[] = [];
    const engine = createWorkflowEngine({
      executors: passthroughExecutors(),
      emit: (e) => events.push(e),
      now: () => 1,
      newRunId: () => 'generated',
    });

    const result = await engine.run(workflow([node('a', 'trigger.manual')]), { runId: 'external' });
    expect(result.runId).toBe('external');
    expect(events.every((e) => e.runId === 'external')).toBe(true);
  });

  it('runs an empty pipeline as an immediate success', async () => {
    const events: RunEvent[] = [];
    const engine = createWorkflowEngine({
      executors: passthroughExecutors(),
      emit: (e) => events.push(e),
      now: () => 1,
      newRunId: () => 'run-1',
    });

    const result = await engine.run(workflow([]));
    expect(result.ok).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['run-start', 'run-finish']);
  });
});
