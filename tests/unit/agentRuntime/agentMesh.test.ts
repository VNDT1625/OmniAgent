import { describe, expect, it } from 'vitest';

import { createAgentMesh, type AgentMeshTask, type AgentTaskContext } from '@/process/agentRuntime/agentMesh';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('agent mesh', () => {
  it('runs independent tasks concurrently and respects dependencies', async () => {
    const started: string[] = [];
    const mesh = createAgentMesh({ maxConcurrent: 2, totalTokenBudget: 300 });
    mesh.registerAgent({ agentId: 'leader', grants: [] });
    mesh.registerAgent({ agentId: 'frontend', parentAgentId: 'leader' });
    mesh.registerAgent({ agentId: 'backend', parentAgentId: 'leader' });
    mesh.registerAgent({ agentId: 'qa', parentAgentId: 'leader' });
    const run = (name: string) => async (_task: AgentMeshTask, context: AgentTaskContext) => {
      started.push(name);
      const action = context.emitAction(name);
      await wait(10);
      action.complete();
      return { summary: name, tokensUsed: 40 };
    };
    mesh.submitTask(
      { taskId: 'front-task', agentId: 'frontend', objective: 'UI', estimatedTokens: 40 },
      run('frontend')
    );
    mesh.submitTask({ taskId: 'back-task', agentId: 'backend', objective: 'API', estimatedTokens: 40 }, run('backend'));
    mesh.submitTask(
      {
        taskId: 'qa-task',
        agentId: 'qa',
        objective: 'test',
        dependsOn: ['front-task', 'back-task'],
        estimatedTokens: 40,
      },
      run('qa')
    );
    await mesh.waitForIdle();
    expect(started.slice(0, 2).toSorted()).toEqual(['backend', 'frontend']);
    expect(started[2]).toBe('qa');
    expect(mesh.getStatus('qa-task')).toBe('completed');
  });

  it('enforces leader grants and supports editable mailbox queues', () => {
    let id = 0;
    const mesh = createAgentMesh({ id: (prefix) => prefix + '-' + ++id });
    mesh.registerAgent({
      agentId: 'leader',
      grants: [{ fromAgentId: 'leader', toAgentId: '*', actions: ['question', 'control', 'task'] }],
    });
    mesh.registerAgent({ agentId: 'worker' });
    expect(() =>
      mesh.sendMessage({
        fromAgentId: 'worker',
        toAgentId: 'leader',
        kind: 'question',
        content: 'no',
        deliveryMode: 'queue',
      })
    ).toThrow('Permission denied');
    const first = mesh.sendMessage({
      fromAgentId: 'leader',
      toAgentId: 'worker',
      kind: 'task',
      content: 'one',
      deliveryMode: 'queue',
    });
    const second = mesh.sendMessage({
      fromAgentId: 'leader',
      toAgentId: 'worker',
      kind: 'task',
      content: 'two',
      deliveryMode: 'queue',
    });
    mesh.updateQueue('worker', first.messageId, { content: 'updated' });
    mesh.reorderMessage('worker', second.messageId, first.messageId);
    expect(mesh.getQueue('worker').map((message) => message.content)).toEqual(['two', 'updated']);
    expect(mesh.removeMessage('worker', first.messageId)?.status).toBe('removed');
  });

  it('interrupts a running task and exposes action history/watchdog state', async () => {
    let clock = 0;
    const mesh = createAgentMesh({ now: () => clock, watchdogMs: 50 });
    mesh.registerAgent({
      agentId: 'leader',
      grants: [{ fromAgentId: 'leader', toAgentId: 'worker', actions: ['control'] }],
    });
    mesh.registerAgent({ agentId: 'worker' });
    mesh.submitTask({ taskId: 'task', agentId: 'worker', objective: 'long' }, async (_task, context) => {
      const action = context.emitAction('long-step');
      await wait(30);
      context.checkControl();
      action.complete();
      return { summary: 'done' };
    });
    await wait(1);
    clock = 100;
    expect(mesh.inspect('worker').stuck).toBe(true);
    mesh.sendMessage({
      fromAgentId: 'leader',
      toAgentId: 'worker',
      kind: 'control',
      content: 'stop',
      deliveryMode: 'interrupt',
    });
    await mesh.waitForIdle();
    expect(mesh.getStatus('task')).toBe('interrupted');
    expect(mesh.inspect('worker').actionHistory[0]?.name).toBe('long-step');
  });
});
