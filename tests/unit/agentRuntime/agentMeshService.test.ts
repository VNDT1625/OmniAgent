import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { createAgentMeshController } from '@process/agentRuntime/agentMesh/controller';
import { createAgentMeshService } from '@process/agentRuntime/agentMesh/service';

import { JsonlDurableEventStore, MemoryDurableEventStore } from '@process/services/agentChat/durability';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('AgentMeshService', () => {
  it('creates durable-session controllers and exposes snapshots/grants', () => {
    const service = createAgentMeshService();
    const controller = service.create('session-1');
    controller.registerAgent({
      agentId: 'leader',
      grants: [{ fromAgentId: 'leader', toAgentId: '*', actions: ['task', 'question', 'control'] }],
    });
    controller.registerAgent({ agentId: 'worker' });

    expect(service.listSessions()).toEqual(['session-1']);
    expect(service.canSend('session-1', 'leader', 'worker', 'question')).toBe(true);
    expect(service.canSend('session-1', 'worker', 'leader', 'question')).toBe(false);
    expect(service.snapshot('session-1').inspections.map((item) => item.agent.agentId)).toEqual(['leader', 'worker']);
  });

  it('rehydrates agents, grants, tasks, worklog and an unacknowledged mailbox after restart', async () => {
    const journal = new MemoryDurableEventStore();
    const first = createAgentMeshService({ eventStoreFactory: () => journal });
    const original = first.create('restart-session');
    original.registerAgent({
      agentId: 'leader',
      grants: [{ fromAgentId: 'leader', toAgentId: '*', actions: ['task', 'question', 'control'] }],
    });
    original.registerAgent({ agentId: 'worker' });
    const gate = deferred();
    original.submitTask({ taskId: 'active-task', agentId: 'worker', objective: 'survive restart' }, async () => {
      await gate.promise;
      return { summary: 'old process unexpectedly completed' };
    });
    await Promise.resolve();
    const sent = original.sendMessage({
      fromAgentId: 'leader',
      toAgentId: 'worker',
      kind: 'task',
      content: 'message that must survive restart',
      delivery: 'send-now',
    });
    await original.flush();

    const restarted = createAgentMeshService({ eventStoreFactory: () => journal });
    const recovered = await restarted.recover('restart-session');

    expect(recovered.getStatus('active-task')).toBe('interrupted');
    expect(restarted.canSend('restart-session', 'leader', 'worker', 'task')).toBe(true);
    expect(recovered.getQueue('worker')).toContainEqual(
      expect.objectContaining({
        messageId: sent.messageId,
        content: 'message that must survive restart',
        status: 'queued',
      })
    );
    expect(recovered.getWorklog('worker').at(-1)?.summary).toBe('Task interrupted by process restart');

    original.stopTask('leader', 'active-task', 'interrupt');
    gate.resolve();
    await original.waitForIdle();
  });

  it('recovers the latest checkpoint from a newly opened JSONL store', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tomny-agent-mesh-'));
    const filePath = path.join(directory, 'session.jsonl');
    try {
      const writerService = createAgentMeshService({
        eventStoreFactory: () => new JsonlDurableEventStore(filePath),
      });
      const writer = writerService.create('jsonl-session');
      writer.registerAgent({
        agentId: 'leader',
        grants: [{ fromAgentId: 'leader', toAgentId: 'worker', actions: ['task'] }],
      });
      writer.registerAgent({ agentId: 'worker' });
      writer.sendMessage({
        fromAgentId: 'leader',
        toAgentId: 'worker',
        kind: 'task',
        content: 'persisted JSONL payload',
        delivery: 'enqueue-after-task',
      });
      await writer.flush();

      const readerService = createAgentMeshService({
        eventStoreFactory: () => new JsonlDurableEventStore(filePath),
      });
      const reader = await readerService.recover('jsonl-session');

      expect(reader.listAgents().map((agent) => agent.agentId)).toEqual(['leader', 'worker']);
      expect(reader.getQueue('worker')[0]?.content).toBe('persisted JSONL payload');
      await readerService.disposeAll();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects duplicate registration and unknown sessions', () => {
    const service = createAgentMeshService();
    service.register('session-1', createAgentMeshController({ sessionId: 'session-1' }));
    expect(() => service.register('session-1', createAgentMeshController({ sessionId: 'other' }))).toThrow(
      /already exists/i
    );
    expect(() => service.snapshot('missing')).toThrow(/unknown.*session/i);
  });
});
