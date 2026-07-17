import { describe, expect, it } from 'vitest';

import { createAgentMeshController, type AgentMeshTask, type AgentTaskContext } from '@/process/agentRuntime/agentMesh';
import { MemoryDurableEventStore } from '@/process/services/agentChat/durability';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const completeActionTask = async (_task: AgentMeshTask, context: AgentTaskContext) => {
  context.emitAction('safe action').complete();
  return { summary: 'done' };
};

const controllerWithAgents = (options: Parameters<typeof createAgentMeshController>[0] = { sessionId: 'session' }) => {
  const controller = createAgentMeshController(options);
  controller.registerAgent({
    agentId: 'leader',
    grants: [{ fromAgentId: 'leader', toAgentId: '*', actions: ['task', 'question', 'control'] }],
  });
  controller.registerAgent({
    agentId: 'developer',
    parentAgentId: 'leader',
    grants: [{ fromAgentId: 'developer', toAgentId: 'qa', actions: ['question', 'progress', 'result'] }],
  });
  controller.registerAgent({ agentId: 'qa', parentAgentId: 'leader' });
  return controller;
};

describe('AgentMeshController delivery and grants', () => {
  it('allows granted agent-to-agent messages and rejects undelegated control', () => {
    const controller = controllerWithAgents();
    expect(
      controller.sendMessage({
        fromAgentId: 'developer',
        toAgentId: 'qa',
        kind: 'question',
        content: 'Can you verify the API?',
        delivery: 'enqueue-after-task',
      }).status
    ).toBe('queued');
    const messageId = controller.getQueue('qa')[0]!.messageId;
    expect(() => controller.updateQueuedMessage('developer', 'qa', messageId, { content: 'changed' })).toThrow(
      'Permission denied'
    );
    expect(controller.updateQueuedMessage('leader', 'qa', messageId, { content: 'approved change' })?.content).toBe(
      'approved change'
    );
  });

  it('distinguishes immediate delivery from delivery after the current task', async () => {
    const controller = controllerWithAgents();
    const gate = deferred();
    controller.submitTask({ taskId: 'task', agentId: 'developer', objective: 'build' }, async () => {
      await gate.promise;
      return { summary: 'done' };
    });
    await Promise.resolve();

    const immediate = controller.sendMessage({
      fromAgentId: 'leader',
      toAgentId: 'developer',
      kind: 'question',
      content: 'Status?',
      delivery: 'send-now',
    });
    const queued = controller.sendMessage({
      fromAgentId: 'leader',
      toAgentId: 'developer',
      kind: 'task',
      content: 'Run tests next',
      delivery: 'enqueue-after-task',
    });

    expect(immediate.status).toBe('delivered');
    expect(controller.getQueue('developer').find((message) => message.messageId === queued.messageId)?.status).toBe(
      'queued'
    );
    gate.resolve();
    await controller.waitForIdle();
    expect(controller.getQueue('developer').find((message) => message.messageId === queued.messageId)?.status).toBe(
      'delivered'
    );
    expect(controller.getStatus('task')).toBe('completed');
  });

  it('interrupts the current task and puts the control message first', async () => {
    const controller = controllerWithAgents();
    const gate = deferred();
    controller.submitTask({ taskId: 'task', agentId: 'developer', objective: 'old plan' }, async (_task, context) => {
      await gate.promise;
      context.checkControl();
      return { summary: 'unexpected' };
    });
    await Promise.resolve();

    const message = controller.sendMessage({
      fromAgentId: 'leader',
      toAgentId: 'developer',
      kind: 'control',
      content: 'Stop and inspect the failing test',
      delivery: 'interrupt-and-send',
    });
    gate.resolve();
    await controller.waitForIdle();

    expect(controller.getStatus('task')).toBe('interrupted');
    expect(controller.getQueue('developer')[0]?.messageId).toBe(message.messageId);
  });
});

describe('AgentMeshController supervision and audit', () => {
  it('stops a repeatedly stalled task and exposes current action history', async () => {
    let clock = 0;
    const gate = deferred();
    const controller = controllerWithAgents({
      sessionId: 'session',
      now: () => clock,
      watchdogMs: 50,
      maxConsecutiveStalls: 2,
      stallAction: 'graceful',
    });
    controller.submitTask({ taskId: 'task', agentId: 'developer', objective: 'long task' }, async (_task, context) => {
      const action = context.emitAction('implement module');
      await gate.promise;
      action.check();
      action.complete();
      return { summary: 'unexpected' };
    });
    await Promise.resolve();
    clock = 100;

    controller.runWatchdogCheck();
    controller.runWatchdogCheck();
    gate.resolve();
    await controller.waitForIdle();

    expect(controller.getStatus('task')).toBe('interrupted');
    expect(controller.inspect('developer').actionHistory[0]?.name).toBe('implement module');
    expect(controller.getWorklog('developer').some((entry) => entry.summary.includes('Watchdog applied'))).toBe(true);
  });

  it('keeps queued work leased but unacknowledged when a worker is killed', async () => {
    const controller = controllerWithAgents();
    const gate = deferred();
    controller.submitTask(
      { taskId: 'killed-task', agentId: 'developer', objective: 'work' },
      async (_task, context) => {
        await gate.promise;
        context.checkControl();
        return { summary: 'unexpected' };
      }
    );
    await Promise.resolve();

    const queued = controller.sendMessage({
      fromAgentId: 'leader',
      toAgentId: 'developer',
      kind: 'task',
      content: 'recover this message',
      delivery: 'enqueue-after-task',
    });
    controller.stopTask('leader', 'killed-task', 'interrupt');
    gate.resolve();
    await controller.waitForIdle();

    expect(controller.getStatus('killed-task')).toBe('interrupted');
    expect(controller.getQueue('developer').find((message) => message.messageId === queued.messageId)?.status).toBe(
      'queued'
    );

    let recoveredContent = '';
    controller.submitTask(
      { taskId: 'recovery-task', agentId: 'developer', objective: 'resume' },
      async (_task, context) => {
        recoveredContent =
          context.getQueuedMessages().find((message) => message.messageId === queued.messageId)?.content ?? '';
        return { summary: 'recovered' };
      }
    );
    await controller.waitForIdle();

    expect(recoveredContent).toBe('recover this message');
    expect(controller.getQueue('developer').find((message) => message.messageId === queued.messageId)?.status).toBe(
      'delivered'
    );
  });

  it('survives a deterministic kill/retry soak without losing messages or replay order', async () => {
    const events = new MemoryDurableEventStore();
    let idSequence = 0;
    const controller = controllerWithAgents({
      sessionId: 'soak-session',
      eventStore: events,
      id: (prefix) => prefix + '-' + ++idSequence,
    });
    const recovered = new Set<string>();

    // oxlint-disable no-await-in-loop -- Ordered rounds model repeated crash/recovery on one mailbox.
    for (let round = 0; round < 50; round += 1) {
      const agentId = round % 2 === 0 ? 'developer' : 'leader';
      const killedTaskId = 'killed-' + round;
      const retryTaskId = 'retry-' + round;
      const gate = deferred();
      controller.submitTask({ taskId: killedTaskId, agentId, objective: 'fault injection' }, async (_task, context) => {
        await gate.promise;
        context.checkControl();
        return { summary: 'unexpected' };
      });
      await Promise.resolve();
      const message = controller.sendMessage({
        fromAgentId: 'leader',
        toAgentId: agentId,
        kind: 'task',
        content: 'payload-' + round,
        delivery: 'enqueue-after-task',
      });

      controller.stopTask('leader', killedTaskId, round % 3 === 0 ? 'cancel' : 'interrupt');
      gate.resolve();
      await controller.waitForIdle();
      expect(controller.getQueue(agentId).find((item) => item.messageId === message.messageId)?.status).toBe('queued');

      controller.submitTask({ taskId: retryTaskId, agentId, objective: 'recover' }, async (_task, context) => {
        const replayed = context.getQueuedMessages().find((item) => item.messageId === message.messageId);
        if (replayed?.content === 'payload-' + round) recovered.add(replayed.messageId);
        return { summary: 'recovered' };
      });
      await controller.waitForIdle();
    }
    // oxlint-enable no-await-in-loop
    await controller.flush();

    const replay = await events.query({ sessionId: 'soak-session' });
    expect(recovered.size).toBe(50);
    expect(new Set(replay.map((event) => event.sequence)).size).toBe(replay.length);
    expect(replay.map((event) => event.sequence)).toEqual(replay.map((_, index) => index + 1));
  });

  it('writes metadata-only durable audit events without message content', async () => {
    const events = new MemoryDurableEventStore();
    const controller = controllerWithAgents({ sessionId: 'session', eventStore: events });

    controller.sendMessage({
      fromAgentId: 'leader',
      toAgentId: 'developer',
      kind: 'task',
      content: 'password=must-not-be-in-audit',
      delivery: 'enqueue-after-task',
    });
    await controller.flush();

    const audit = await events.query({ kinds: ['agent.message'] });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('must-not-be-in-audit');
  });

  it('keeps worklog summaries bounded and free of task objectives', async () => {
    const controller = controllerWithAgents({ sessionId: 'session', maxWorklogEntries: 2 });
    controller.submitTask({ taskId: 'task', agentId: 'developer', objective: 'secret objective' }, completeActionTask);
    await controller.waitForIdle();

    const worklog = controller.getWorklog();
    expect(worklog).toHaveLength(2);
    expect(JSON.stringify(worklog)).not.toContain('secret objective');
  });
});
