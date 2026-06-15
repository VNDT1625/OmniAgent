/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Agent Company **execution pipeline** (spec
 * agent-company-pipeline): the recursive runner (A→B→C/D), the delegation
 * planner parsing/guards, the real executor's turn/timeout/lease behaviour, the
 * approval + test gates, and the pipeline store reducer.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CompanyStructure, RoleNode } from '@/process/company/companyOrchestrator';
import { parsePlannerDecision } from '@/renderer/pages/company/pipeline/delegationPlanner';
import { executeViaConversation, type RoleExecutorDeps } from '@/renderer/pages/company/pipeline/roleExecutor';
import { createRoleRunner, type RoleRunnerDeps } from '@/renderer/pages/company/pipeline/roleRunner';
import { createApprovalGate } from '@/renderer/pages/company/pipeline/approvalGate';
import { runTestGate } from '@/renderer/pages/company/pipeline/testGate';
import { createPipelineStore, reducePipeline, emptySnapshot } from '@/renderer/pages/company/pipeline/pipelineStore';
import type { PipelineEvent } from '@/renderer/pages/company/pipeline/pipelineTypes';

// --- Builders --------------------------------------------------------------

const leaf = (id: string, name: string): RoleNode => ({ id, role: 'worker', name, children: [] });

/** President → [head A → (C, D)], head B (leaf). */
const makeStructure = (): CompanyStructure => ({
  companyId: 'co',
  root: {
    id: 'co:president',
    role: 'president',
    name: 'President',
    children: [
      {
        id: 'co:head:a',
        role: 'division-head',
        name: 'A',
        children: [leaf('co:worker:c', 'C'), leaf('co:worker:d', 'D')],
      },
      leaf('co:head:b', 'B'),
    ],
  },
});

// --- Planner ---------------------------------------------------------------

describe('delegationPlanner.parsePlannerDecision', () => {
  const directIds = new Set(['co:head:a', 'co:head:b']);

  it('parses a delegate decision and keeps only direct children', () => {
    const reply =
      '```json\n{"mode":"delegate","directives":[{"childId":"co:head:a","task":"design"},{"childId":"co:worker:c","task":"sneaky"}]}\n```';
    const decision = parsePlannerDecision(reply, directIds);
    expect(decision.mode).toBe('delegate');
    if (decision.mode === 'delegate') {
      expect(decision.directives).toHaveLength(1);
      expect(decision.directives[0].childId).toBe('co:head:a');
    }
  });

  it('parses dependsOn, keeping only direct-child deps and dropping self/unknown', () => {
    const reply =
      '```json\n{"mode":"delegate","directives":[{"childId":"co:head:b","task":"qa","dependsOn":["co:head:a","co:head:b","ghost"]}]}\n```';
    const decision = parsePlannerDecision(reply, directIds);
    expect(decision.mode).toBe('delegate');
    if (decision.mode === 'delegate') {
      // self-ref (co:head:b) and unknown (ghost) dropped; only co:head:a kept.
      expect(decision.directives[0].dependsOn).toEqual(['co:head:a']);
    }
  });

  it('parses execute / approval / test / permission / finish', () => {
    expect(parsePlannerDecision('```json\n{"mode":"execute","task":"build"}\n```', directIds).mode).toBe('execute');
    expect(
      parsePlannerDecision('```json\n{"mode":"request_approval","artifact":"C4","summary":"review"}\n```', directIds)
        .mode
    ).toBe('request_approval');
    expect(
      parsePlannerDecision('```json\n{"mode":"request_test","scenarioName":"smoke","steps":["goto x"]}\n```', directIds)
        .mode
    ).toBe('request_test');
    expect(parsePlannerDecision('```json\n{"mode":"request_permission","action":"deploy"}\n```', directIds).mode).toBe(
      'request_permission'
    );
    expect(parsePlannerDecision('```json\n{"mode":"finish","result":"done"}\n```', directIds).mode).toBe('finish');
  });

  it('degrades a delegate with no valid children to finish', () => {
    const reply = '```json\n{"mode":"delegate","directives":[{"childId":"ghost","task":"x"}]}\n```';
    expect(parsePlannerDecision(reply, directIds).mode).toBe('finish');
  });

  it('treats malformed JSON as finish (never stalls)', () => {
    expect(parsePlannerDecision('not json at all', directIds).mode).toBe('finish');
  });
});

// --- Executor --------------------------------------------------------------

describe('roleExecutor.executeViaConversation', () => {
  const baseDeps = (): RoleExecutorDeps => {
    const listeners: Array<(e: { conversationId: string; finished: boolean; content: string }) => void> = [];
    return {
      resolveConversation: vi.fn(async () => ({ conversationId: 'c1', workspace: '/ws' })),
      sendMessage: vi.fn(async () => {
        // Fire completion on the next tick.
        setTimeout(() => listeners.forEach((l) => l({ conversationId: 'c1', finished: true, content: 'done it' })), 0);
      }),
      onTurnCompleted: (listener) => {
        listeners.push(listener);
        return () => {};
      },
    };
  };

  it('sends the task and resolves with the turn result', async () => {
    const deps = baseDeps();
    const outcome = await executeViaConversation(deps, { nodeId: 'n', briefing: 'b', task: 't' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result).toBe('done it');
    expect(deps.sendMessage).toHaveBeenCalled();
  });

  it('times out and reports failure (no hang)', async () => {
    const deps: RoleExecutorDeps = {
      resolveConversation: async () => ({ conversationId: 'c1', workspace: '' }),
      sendMessage: async () => {},
      onTurnCompleted: () => () => {},
    };
    const outcome = await executeViaConversation(deps, { nodeId: 'n', briefing: 'b', task: 't', timeoutMs: 10 });
    expect(outcome.ok).toBe(false);
  });

  it('balances lease: one release per request', async () => {
    let requested = 0;
    let released = 0;
    const deps = baseDeps();
    deps.requestLease = async () => {
      requested += 1;
      return { id: `l${requested}` };
    };
    deps.releaseLease = () => {
      released += 1;
    };
    await executeViaConversation(deps, { nodeId: 'n', briefing: 'b', task: 't' });
    expect(requested).toBe(1);
    expect(released).toBe(1);
  });

  it('falls back to simulate when no executor is assigned', async () => {
    const deps: RoleExecutorDeps = {
      resolveConversation: async () => null,
      sendMessage: async () => {},
      onTurnCompleted: () => () => {},
      simulate: async () => 'simulated plan',
    };
    const outcome = await executeViaConversation(deps, { nodeId: 'n', briefing: 'b', task: 't' });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.simulated).toBe(true);
      expect(outcome.result).toBe('simulated plan');
    }
  });
});

// --- Recursive runner ------------------------------------------------------

describe('roleRunner.runRole (recursion A→B→C/D)', () => {
  /** A planner script keyed by role name. */
  const scriptedRunner = (script: Record<string, string>, executed: string[]) => {
    const chat = vi.fn(async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      // The system prompt contains the role name as `You are "X"`.
      const sys = messages.find((m) => m.role === 'system')?.content ?? '';
      const match = sys.match(/You are "([^"]+)"/);
      const roleName = match?.[1] ?? '';
      // Synthesis call (no decision protocol) → just echo.
      if (sys.includes('Synthesize')) return `synthesis-of-${roleName}`;
      return script[roleName] ?? '```json\n{"mode":"execute","task":"x"}\n```';
    });
    const deps: RoleRunnerDeps = {
      companyId: 'co',
      rules: [],
      loadMind: async () => ({ soul: '', memory: '' }),
      chat: chat as never,
      buildBriefing: () => 'briefing',
      execute: async ({ node }) => {
        executed.push(node.name);
        return { ok: true, result: `${node.name}-output`, conversationId: 'c', workspace: '/ws' };
      },
      approvalGate: createApprovalGate(),
      emit: () => {},
      runId: 'run',
      newId: (p) => `${p}-${Math.random().toString(36).slice(2, 7)}`,
      now: () => 1,
    };
    return { deps, chat };
  };

  it('delegates down two levels and synthesizes results upward', async () => {
    const executed: string[] = [];
    const script: Record<string, string> = {
      President:
        '```json\n{"mode":"delegate","directives":[{"childId":"co:head:a","task":"build feature"},{"childId":"co:head:b","task":"do b"}]}\n```',
      A: '```json\n{"mode":"delegate","directives":[{"childId":"co:worker:c","task":"sub c"},{"childId":"co:worker:d","task":"sub d"}]}\n```',
      // C, D, B are leaves → they execute.
    };
    const { deps } = scriptedRunner(script, executed);
    const { runRole } = createRoleRunner(deps);
    const structure = makeStructure();

    const result = await runRole({ node: structure.root, parentId: undefined }, 'goal', 0, new Set());

    expect(result.ok).toBe(true);
    // C, D, B all really executed (the leaves).
    expect(executed.toSorted()).toEqual(['B', 'C', 'D']);
  });

  it('a leaf executes directly (no children to delegate to)', async () => {
    const executed: string[] = [];
    const { deps } = scriptedRunner({}, executed);
    const { runRole } = createRoleRunner(deps);
    const result = await runRole({ node: leaf('co:worker:c', 'C'), parentId: 'co:head:a' }, 'task', 2, new Set());
    expect(result.ok).toBe(true);
    expect(executed).toEqual(['C']);
  });

  it('enforces the max-depth guard', async () => {
    const executed: string[] = [];
    const { deps } = scriptedRunner({}, executed);
    const { runRole } = createRoleRunner({ ...deps, config: { maxDepth: 1 } });
    const structure = makeStructure();
    // Start at depth 5 > maxDepth 1 → guarded.
    const result = await runRole({ node: structure.root, parentId: undefined }, 'goal', 5, new Set());
    expect(result.ok).toBe(false);
  });

  it('detects a cycle (role visited twice)', async () => {
    const executed: string[] = [];
    const { deps } = scriptedRunner({}, executed);
    const { runRole } = createRoleRunner(deps);
    const node = leaf('co:worker:c', 'C');
    const visited = new Set(['co:worker:c']);
    const result = await runRole({ node, parentId: 'x' }, 'task', 1, visited);
    expect(result.ok).toBe(false);
  });

  it('a failed child branch does not crash the parent', async () => {
    const executed: string[] = [];
    const script: Record<string, string> = {
      President: '```json\n{"mode":"delegate","directives":[{"childId":"co:head:b","task":"do b"}]}\n```',
    };
    const { deps } = scriptedRunner(script, executed);
    // Make B's execution fail.
    deps.execute = async ({ node }) =>
      node.name === 'B' ? { ok: false, error: 'boom' } : { ok: true, result: 'ok', conversationId: 'c', workspace: '' };
    const { runRole } = createRoleRunner(deps);
    const structure = makeStructure();
    const result = await runRole({ node: structure.root, parentId: undefined }, 'goal', 0, new Set());
    // President still synthesizes (ok) even though the child failed.
    expect(result.ok).toBe(true);
  });
});

describe('roleRunner.runRole — dependency-aware delegation (pipeline ordering)', () => {
  /** A runner that records the order/timing in which leaves execute. */
  const orderedRunner = (script: Record<string, string>) => {
    const startOrder: string[] = [];
    const directivesSeen: Array<{ to: string; task: string }> = [];
    const chat = vi.fn(async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      const sys = messages.find((m) => m.role === 'system')?.content ?? '';
      const roleName = sys.match(/You are "([^"]+)"/)?.[1] ?? '';
      if (sys.includes('Synthesize')) return `synthesis-of-${roleName}`;
      return script[roleName] ?? '```json\n{"mode":"execute","task":"x"}\n```';
    });
    const deps: RoleRunnerDeps = {
      companyId: 'co',
      rules: [],
      loadMind: async () => ({ soul: '', memory: '' }),
      chat: chat as never,
      buildBriefing: () => 'briefing',
      execute: async ({ node, task }) => {
        startOrder.push(node.name);
        directivesSeen.push({ to: node.name, task });
        await new Promise((r) => setTimeout(r, 10)); // simulate work so ordering is observable
        return { ok: true, result: `${node.name}-output`, conversationId: 'c', workspace: '/ws' };
      },
      approvalGate: createApprovalGate(),
      emit: () => {},
      runId: 'run',
      newId: (p) => `${p}-${Math.random().toString(36).slice(2, 7)}`,
      now: () => 1,
    };
    return { deps, startOrder, directivesSeen };
  };

  it('runs a dependent directive AFTER its prerequisite and feeds the result as context', async () => {
    // President → A and B, where B dependsOn A. A and B are leaves (execute).
    // B executes with an empty task so it falls back to its incoming briefing
    // (which carries A's result as prerequisite context).
    const script: Record<string, string> = {
      President:
        '```json\n{"mode":"delegate","directives":[{"childId":"co:head:b","task":"QA test","dependsOn":["co:head:a"]},{"childId":"co:head:a","task":"build"}]}\n```',
      A: '```json\n{"mode":"execute","task":""}\n```',
      B: '```json\n{"mode":"execute","task":""}\n```',
    };
    // Make head:a a leaf for this test by using a structure where both are leaves.
    const structure: CompanyStructure = {
      companyId: 'co',
      root: {
        id: 'co:president',
        role: 'president',
        name: 'President',
        children: [leaf('co:head:a', 'A'), leaf('co:head:b', 'B')],
      },
    };
    const { deps, startOrder, directivesSeen } = orderedRunner(script);
    const { runRole } = createRoleRunner(deps);

    const result = await runRole({ node: structure.root, parentId: undefined }, 'goal', 0, new Set());
    expect(result.ok).toBe(true);
    // A (prerequisite) executes before B (dependent), despite B being listed first.
    expect(startOrder).toEqual(['A', 'B']);
    // B's task carries A's result as prerequisite context.
    const bTask = directivesSeen.find((d) => d.to === 'B')?.task ?? '';
    expect(bTask).toContain('Context from prerequisite work');
    expect(bTask).toContain('A-output');
  });

  it('runs independent directives in parallel (no deps)', async () => {
    const script: Record<string, string> = {
      President:
        '```json\n{"mode":"delegate","directives":[{"childId":"co:head:a","task":"x"},{"childId":"co:head:b","task":"y"}]}\n```',
    };
    const structure: CompanyStructure = {
      companyId: 'co',
      root: {
        id: 'co:president',
        role: 'president',
        name: 'President',
        children: [leaf('co:head:a', 'A'), leaf('co:head:b', 'B')],
      },
    };
    const { deps, startOrder } = orderedRunner(script);
    const { runRole } = createRoleRunner(deps);
    const result = await runRole({ node: structure.root, parentId: undefined }, 'goal', 0, new Set());
    expect(result.ok).toBe(true);
    expect(startOrder.toSorted()).toEqual(['A', 'B']); // both ran
  });

  it('does not hang on a dependency cycle (breaks it and completes)', async () => {
    const script: Record<string, string> = {
      President:
        '```json\n{"mode":"delegate","directives":[{"childId":"co:head:a","task":"x","dependsOn":["co:head:b"]},{"childId":"co:head:b","task":"y","dependsOn":["co:head:a"]}]}\n```',
    };
    const structure: CompanyStructure = {
      companyId: 'co',
      root: {
        id: 'co:president',
        role: 'president',
        name: 'President',
        children: [leaf('co:head:a', 'A'), leaf('co:head:b', 'B')],
      },
    };
    const { deps, startOrder } = orderedRunner(script);
    const { runRole } = createRoleRunner(deps);
    const result = await runRole({ node: structure.root, parentId: undefined }, 'goal', 0, new Set());
    expect(result.ok).toBe(true);
    expect(startOrder.toSorted()).toEqual(['A', 'B']); // both still ran despite the cycle
  });
});

// --- Approval gate ---------------------------------------------------------

describe('approvalGate', () => {
  it('pauses until resolved, then settles with the decision', async () => {
    const gate = createApprovalGate();
    const promise = gate.request('r1');
    expect(gate.pendingCount()).toBe(1);
    expect(gate.resolve({ requestId: 'r1', approved: true, note: 'ok' })).toBe(true);
    const decision = await promise;
    expect(decision.approved).toBe(true);
    expect(gate.pendingCount()).toBe(0);
  });

  it('resolve of an unknown id returns false', () => {
    const gate = createApprovalGate();
    expect(gate.resolve({ requestId: 'nope', approved: true })).toBe(false);
  });

  it('cancelAll denies every pending request', async () => {
    const gate = createApprovalGate();
    const p = gate.request('r1');
    gate.cancelAll('stopped');
    const decision = await p;
    expect(decision.approved).toBe(false);
  });
});

// --- Test gate -------------------------------------------------------------

describe('testGate.runTestGate', () => {
  it('passes through on the first passing run', async () => {
    const runner = { run: vi.fn(async () => ({ sessionId: 's', status: 'passed' as const, reportPath: '/r.md' })) };
    const outcome = await runTestGate(runner, { scenarioName: 'smoke', steps: ['goto x'] });
    expect(outcome.passed).toBe(true);
    expect(outcome.rounds).toBe(1);
  });

  it('retries with the fixer on failure, up to maxRounds', async () => {
    let calls = 0;
    const runner = {
      run: vi.fn(async () => {
        calls += 1;
        return {
          sessionId: 's',
          status: (calls >= 2 ? 'passed' : 'failed') as 'passed' | 'failed',
          reportPath: '/r.md',
        };
      }),
    };
    const fix = vi.fn(async () => {});
    const outcome = await runTestGate(runner, { scenarioName: 'smoke', steps: ['goto x'], maxRounds: 3, fix });
    expect(outcome.passed).toBe(true);
    expect(outcome.rounds).toBe(2);
    expect(fix).toHaveBeenCalledTimes(1);
  });

  it('reports failure after exhausting rounds', async () => {
    const runner = { run: vi.fn(async () => ({ sessionId: 's', status: 'failed' as const })) };
    const outcome = await runTestGate(runner, { scenarioName: 'smoke', steps: [], maxRounds: 2 });
    expect(outcome.passed).toBe(false);
    expect(outcome.rounds).toBe(2);
  });
});

// --- Store reducer ---------------------------------------------------------

describe('pipelineStore.reducePipeline', () => {
  it('run-started seeds states and running phase', () => {
    const next = reducePipeline(emptySnapshot(), {
      type: 'run-started',
      runId: 'r',
      rootId: 'co:president',
      states: [{ nodeId: 'co:president', name: 'President', role: 'president', activity: 'idle', updatedAt: 1 }],
    });
    expect(next.phase).toBe('running');
    expect(next.states['co:president']).toBeDefined();
  });

  it('message/artifact/approval events accumulate; approval-resolved removes pending', () => {
    let s = reducePipeline(emptySnapshot(), { type: 'run-started', runId: 'r', rootId: 'x', states: [] });
    s = reducePipeline(s, {
      type: 'message',
      runId: 'r',
      message: { id: 'm1', fromId: 'a', toId: 'b', content: 'hi', kind: 'directive', at: 1 },
    });
    s = reducePipeline(s, {
      type: 'artifact',
      runId: 'r',
      artifact: { id: 'a1', nodeId: 'a', kind: 'doc', title: 'C4', at: 1 },
    });
    s = reducePipeline(s, {
      type: 'approval',
      runId: 'r',
      request: { id: 'p1', fromId: 'a', gate: 'approval', summary: 'review', at: 1 },
    });
    expect(s.messages).toHaveLength(1);
    expect(s.artifacts).toHaveLength(1);
    expect(s.pending).toHaveLength(1);
    s = reducePipeline(s, { type: 'approval-resolved', runId: 'r', decision: { requestId: 'p1', approved: true } });
    expect(s.pending).toHaveLength(0);
  });

  it('run-finished/run-error set terminal phase', () => {
    const finished = reducePipeline(emptySnapshot(), {
      type: 'run-finished',
      runId: 'r',
      status: 'done',
      summary: 'ok',
    } as PipelineEvent);
    expect(finished.phase).toBe('finished');
    const errored = reducePipeline(emptySnapshot(), { type: 'run-error', runId: 'r', message: 'bad' } as PipelineEvent);
    expect(errored.phase).toBe('error');
  });

  it('store notifies subscribers on dispatch', () => {
    const store = createPipelineStore();
    const seen: string[] = [];
    const unsub = store.subscribe((snap) => seen.push(snap.phase));
    store.dispatch({ type: 'run-started', runId: 'r', rootId: 'x', states: [] });
    expect(seen).toContain('running');
    unsub();
  });
});
