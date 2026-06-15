/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the new control-flow engine features: if/switch/loop/parallel/
 * tryCatch/filter/stop, plus conditions, data nodes, and the scheduler.
 */

import { describe, expect, it, vi } from 'vitest';
import { createWorkflowEngine } from '@/process/automation/workflowEngine';
import { evaluateCondition, resolveValue } from '@/process/automation/conditions';
import { runSet, runCode, createFilesystemAction } from '@/process/automation/connectors/dataActions';
import { createAutomationScheduler } from '@/process/automation/automationScheduler';
import type { NodeExecutorMap } from '@/process/automation/nodeExecutors';
import type { RunEvent, Workflow, WorkflowNode } from '@/process/automation/automationTypes';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const wf = (nodes: WorkflowNode[]): Workflow => ({
  id: 'w1',
  name: 'T',
  nodes,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
});
const node = (
  id: string,
  kind: WorkflowNode['kind'],
  config: Record<string, unknown> = {},
  branches?: Record<string, WorkflowNode[]>
): WorkflowNode => ({ id, kind, name: id, config, branches });

const makeExecutors = (overrides: Partial<NodeExecutorMap> = {}): NodeExecutorMap => {
  const pass = (_n: WorkflowNode, ctx: { input: unknown }) => Promise.resolve(ctx.input);
  const kinds: Array<keyof NodeExecutorMap> = [
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
  const map: Partial<NodeExecutorMap> = {};
  for (const k of kinds) map[k] = pass;
  return { ...map, ...overrides } as NodeExecutorMap;
};

const makeEngine = (overrides: Partial<NodeExecutorMap> = {}) => {
  const events: RunEvent[] = [];
  const engine = createWorkflowEngine({
    executors: makeExecutors(overrides),
    emit: (e) => events.push(e),
    now: () => 1,
    newRunId: () => 'r1',
  });
  return { engine, events };
};

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

describe('evaluateCondition', () => {
  it('eq / neq', () => {
    expect(evaluateCondition({ left: '{{input}}', operator: 'eq', right: 'hello' }, 'hello')).toBe(true);
    expect(evaluateCondition({ left: '{{input}}', operator: 'neq', right: 'hello' }, 'world')).toBe(true);
  });
  it('contains / startsWith / endsWith', () => {
    expect(evaluateCondition({ left: '{{input}}', operator: 'contains', right: 'ell' }, 'hello')).toBe(true);
    expect(evaluateCondition({ left: '{{input}}', operator: 'startsWith', right: 'he' }, 'hello')).toBe(true);
    expect(evaluateCondition({ left: '{{input}}', operator: 'endsWith', right: 'lo' }, 'hello')).toBe(true);
  });
  it('gt / lt / gte / lte', () => {
    expect(evaluateCondition({ left: '5', operator: 'gt', right: '3' }, null)).toBe(true);
    expect(evaluateCondition({ left: '2', operator: 'lt', right: '3' }, null)).toBe(true);
  });
  it('isEmpty / isNotEmpty', () => {
    expect(evaluateCondition({ left: '', operator: 'isEmpty' }, null)).toBe(true);
    expect(evaluateCondition({ left: 'x', operator: 'isNotEmpty' }, null)).toBe(true);
  });
  it('regex', () => {
    expect(evaluateCondition({ left: 'hello123', operator: 'regex', right: '\\d+' }, null)).toBe(true);
    expect(evaluateCondition({ left: 'hello', operator: 'regex', right: '\\d+' }, null)).toBe(false);
  });
  it('resolveValue reads dotted path from object input', () => {
    expect(resolveValue('{{input.name}}', { name: 'Alice' })).toBe('Alice');
    expect(resolveValue('{{input.a.b}}', { a: { b: 42 } })).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// Data nodes
// ---------------------------------------------------------------------------

describe('action.set', () => {
  it('builds an object from fields with {{input}} substitution', () => {
    const result = runSet(
      {
        fields: [
          { key: 'msg', value: 'hi {{input}}' },
          { key: 'n', value: '42' },
        ],
      },
      'world'
    );
    expect(result).toEqual({ msg: 'hi world', n: '42' });
  });
  it('merges into input when keepInput is true', () => {
    const result = runSet({ keepInput: true, fields: [{ key: 'extra', value: 'yes' }] }, { existing: 1 });
    expect(result).toMatchObject({ existing: 1, extra: 'yes' });
  });
});

describe('action.code', () => {
  it('renders a template', () => {
    expect(runCode({ template: 'value={{input}}' }, 'abc')).toBe('value=abc');
  });
  it('parses JSON when parseJson is true', () => {
    expect(runCode({ template: '{"x":{{input}}}', parseJson: true }, '1')).toEqual({ x: 1 });
  });
  it('throws on invalid JSON when parseJson is true', () => {
    expect(() => runCode({ template: 'not-json', parseJson: true }, null)).toThrow(/JSON/i);
  });
});

describe('action.filesystem', () => {
  it('writes content and returns byte count', async () => {
    const writes: { path: string; data: string }[] = [];
    const action = createFilesystemAction({
      mkdir: () => Promise.resolve(undefined),
      writeFile: (p, d) => {
        writes.push({ path: p, data: d });
        return Promise.resolve();
      },
      appendFile: () => Promise.resolve(),
      readFile: () => Promise.resolve(''),
      readdir: () => Promise.resolve([]),
    });
    const result = await action.run(
      { operation: 'write', path: '/tmp/x.txt', content: 'hello {{input}}' },
      'world',
      'FS'
    );
    expect(writes[0]).toEqual({ path: '/tmp/x.txt', data: 'hello world' });
    expect(result).toMatchObject({ operation: 'write', bytes: 11 });
  });
  it('reads a file', async () => {
    const action = createFilesystemAction({
      mkdir: () => Promise.resolve(undefined),
      writeFile: () => Promise.resolve(),
      appendFile: () => Promise.resolve(),
      readFile: () => Promise.resolve('file content'),
      readdir: () => Promise.resolve([]),
    });
    const result = await action.run({ operation: 'read', path: '/tmp/x.txt' }, null, 'FS');
    expect(result).toMatchObject({ operation: 'read', content: 'file content' });
  });
});

// ---------------------------------------------------------------------------
// Control flow — control.if
// ---------------------------------------------------------------------------

describe('control.if', () => {
  it('takes the then branch when condition is true', async () => {
    const { engine } = makeEngine({ 'action.log': (_n, ctx) => Promise.resolve(`then:${String(ctx.input)}`) });
    const result = await engine.run(
      wf([
        node(
          'if',
          'control.if',
          { left: '{{input}}', operator: 'eq', right: 'yes' },
          {
            then: [node('t', 'action.log')],
            else: [node('e', 'action.log')],
          }
        ),
      ]),
      { input: 'yes' }
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe('then:yes');
  });

  it('takes the else branch when condition is false', async () => {
    const { engine } = makeEngine({ 'action.log': (_n, ctx) => Promise.resolve(`else:${String(ctx.input)}`) });
    const result = await engine.run(
      wf([
        node(
          'if',
          'control.if',
          { left: '{{input}}', operator: 'eq', right: 'yes' },
          {
            then: [node('t', 'action.log')],
            else: [node('e', 'action.log')],
          }
        ),
      ]),
      { input: 'no' }
    );
    expect(result.output).toBe('else:no');
  });
});

// ---------------------------------------------------------------------------
// Control flow — control.loop
// ---------------------------------------------------------------------------

describe('control.loop', () => {
  it('iterates over an array input (forEach)', async () => {
    const seen: unknown[] = [];
    const { engine } = makeEngine({
      'action.log': (_n, ctx) => {
        seen.push(ctx.input);
        return Promise.resolve(ctx.input);
      },
    });
    const result = await engine.run(
      wf([node('loop', 'control.loop', { mode: 'forEach' }, { body: [node('b', 'action.log')] })]),
      { input: ['a', 'b', 'c'] }
    );
    expect(result.ok).toBe(true);
    expect((result.output as { count: number }).count).toBe(3);
    expect(seen).toHaveLength(3);
  });

  it('repeats a fixed number of times (times mode)', async () => {
    let count = 0;
    const { engine } = makeEngine({
      'action.log': () => {
        count++;
        return Promise.resolve(count);
      },
    });
    const result = await engine.run(
      wf([node('loop', 'control.loop', { mode: 'times', times: 4 }, { body: [node('b', 'action.log')] })])
    );
    expect(count).toBe(4);
    expect((result.output as { count: number }).count).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Control flow — control.tryCatch
// ---------------------------------------------------------------------------

describe('control.tryCatch', () => {
  it('runs the try branch on success', async () => {
    const { engine } = makeEngine({ 'action.log': (_n, ctx) => Promise.resolve(`ok:${String(ctx.input)}`) });
    const result = await engine.run(
      wf([
        node(
          'tc',
          'control.tryCatch',
          {},
          {
            try: [node('t', 'action.log')],
            catch: [node('c', 'action.log')],
          }
        ),
      ]),
      { input: 'x' }
    );
    expect(result.output).toBe('ok:x');
  });

  it('runs the catch branch on failure', async () => {
    const { engine } = makeEngine({
      'action.http': () => Promise.reject(new Error('boom')),
      'action.log': (_n, ctx) => Promise.resolve(`caught:${(ctx.input as { error: string }).error}`),
    });
    const result = await engine.run(
      wf([
        node(
          'tc',
          'control.tryCatch',
          {},
          {
            try: [node('t', 'action.http')],
            catch: [node('c', 'action.log')],
          }
        ),
      ])
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe('caught:boom');
  });
});

// ---------------------------------------------------------------------------
// Control flow — control.filter / control.stop
// ---------------------------------------------------------------------------

describe('control.filter', () => {
  it('passes through when condition is true', async () => {
    const { engine } = makeEngine();
    const result = await engine.run(wf([node('f', 'control.filter', { left: '{{input}}', operator: 'isNotEmpty' })]), {
      input: 'hi',
    });
    expect(result.ok).toBe(true);
  });

  it('stops the run when condition is false', async () => {
    const { engine } = makeEngine();
    const result = await engine.run(wf([node('f', 'control.filter', { left: '{{input}}', operator: 'isNotEmpty' })]), {
      input: '',
    });
    expect(result.ok).toBe(true); // deliberate stop = success
  });
});

describe('control.stop', () => {
  it('ends the run early and marks it ok', async () => {
    const ran = vi.fn();
    const { engine } = makeEngine({
      'action.log': () => {
        ran();
        return Promise.resolve(null);
      },
    });
    const result = await engine.run(wf([node('s', 'control.stop'), node('l', 'action.log')]));
    expect(result.ok).toBe(true);
    expect(ran).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Per-node error policy (onError)
// ---------------------------------------------------------------------------

describe('onError policy', () => {
  it('retries a failing node the configured number of times', async () => {
    let calls = 0;
    const { engine } = makeEngine({
      'action.http': () => {
        calls++;
        return calls < 3 ? Promise.reject(new Error('fail')) : Promise.resolve('ok');
      },
    });
    const n = { ...node('h', 'action.http'), onError: { retries: 2, retryDelayMs: 0 } };
    const result = await engine.run(wf([n]));
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });

  it('continues the pipeline when continueOnError is true', async () => {
    const { engine } = makeEngine({
      'action.http': () => Promise.reject(new Error('fail')),
      'action.log': (_n, ctx) => Promise.resolve(`after:${String(ctx.input)}`),
    });
    const n = { ...node('h', 'action.http'), onError: { continueOnError: true } };
    const result = await engine.run(wf([n, node('l', 'action.log')]));
    expect(result.ok).toBe(true);
    expect(result.output).toBe('after:null');
  });
});

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

describe('createAutomationScheduler', () => {
  it('arms a workflow with everyMinutes and fires it', async () => {
    const fired: string[] = [];
    let tick: (() => void) | null = null;
    const scheduler = createAutomationScheduler({
      store: {
        list: () =>
          Promise.resolve([
            {
              id: 'w1',
              name: 'W',
              nodes: [{ id: 'n1', kind: 'trigger.schedule', name: 'S', config: { everyMinutes: 5 } }],
              enabled: true,
              createdAt: 0,
              updatedAt: 0,
            },
          ]),
        get: () => Promise.resolve(undefined),
        load: () => Promise.resolve([]),
        save: () => Promise.resolve({} as Workflow),
        remove: () => Promise.resolve([]),
        onChange: () => () => undefined,
      },
      runWorkflow: (id) => {
        fired.push(id);
        return Promise.resolve();
      },
      armCron: (_expr, onTick) => {
        tick = onTick;
        return { stop: () => undefined };
      },
    });
    await scheduler.start();
    expect(tick).not.toBeNull();
    tick!();
    expect(fired).toEqual(['w1']);
    scheduler.stop();
  });

  it('does not arm a disabled workflow', async () => {
    let armed = false;
    const scheduler = createAutomationScheduler({
      store: {
        list: () =>
          Promise.resolve([
            {
              id: 'w1',
              name: 'W',
              nodes: [{ id: 'n1', kind: 'trigger.schedule', name: 'S', config: { everyMinutes: 1 } }],
              enabled: false,
              createdAt: 0,
              updatedAt: 0,
            },
          ]),
        get: () => Promise.resolve(undefined),
        load: () => Promise.resolve([]),
        save: () => Promise.resolve({} as Workflow),
        remove: () => Promise.resolve([]),
        onChange: () => () => undefined,
      },
      runWorkflow: () => Promise.resolve(),
      armCron: () => {
        armed = true;
        return { stop: () => undefined };
      },
    });
    await scheduler.start();
    expect(armed).toBe(false);
    scheduler.stop();
  });
});
