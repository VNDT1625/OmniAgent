import { describe, expect, it } from 'vitest';

import type { ContextStore } from '@/process/agentRuntime/contextStore';
import type { ContextDocument } from '@/process/agentRuntime/contextTypes';
import { MemoryCoreSessionStore } from '@/process/experimentalCore/sessionCheckpointStore';
import { MemoryPermissionRepository, type PermissionStoreState } from '@/process/services/agentChat/permission';
import {
  CoreCutoverService,
  createCoreCutoverPorts,
  MemoryDurableEventStore,
  parseCoreCutoverBundle,
  serializeCoreCutoverBundle,
  type CoreCutoverPayload,
  type CoreCutoverPorts,
} from '@/process/services/agentChat/durability';

const emptyContext = (): ContextDocument => ({ version: 1, agents: [], people: [] });
const emptyPayload = (): CoreCutoverPayload => ({
  sessions: [],
  events: [],
  context: emptyContext(),
  permissions: { version: 1, grants: [], audit: [] },
});

const memoryContextStore = (initial: ContextDocument): ContextStore => {
  let document = structuredClone(initial);
  return {
    getAgent: async (id) => structuredClone(document.agents.find((item) => item.id === id)),
    getPersonal: async (id) => structuredClone(document.people.find((item) => item.id === id)),
    upsertAgent: async (value) => {
      document.agents = [...document.agents.filter((item) => item.id !== value.id), structuredClone(value)];
    },
    upsertPersonal: async (value) => {
      document.people = [...document.people.filter((item) => item.id !== value.id), structuredClone(value)];
    },
    learnPersonalFact: async () => false,
    exportDocument: async () => structuredClone(document),
    replaceDocument: async (value) => {
      document = structuredClone(value);
    },
  };
};

const memoryPorts = (
  initial: CoreCutoverPayload,
  failSection?: keyof CoreCutoverPorts
): { ports: CoreCutoverPorts; state: CoreCutoverPayload } => {
  const state = structuredClone(initial);
  const section = <K extends keyof CoreCutoverPayload>(key: K): CoreCutoverPorts[K] => ({
    read: async () => structuredClone(state[key]),
    replace: async (value) => {
      if (failSection === key) throw new Error(`${key} unavailable`);
      state[key] = structuredClone(value) as CoreCutoverPayload[K];
    },
  });
  return {
    state,
    ports: {
      sessions: section('sessions'),
      events: section('events'),
      context: section('context'),
      permissions: section('permissions'),
    },
  };
};

describe('CoreCutoverService', () => {
  it('exports a checksummed, text-only bundle and imports every durable section', async () => {
    const source = emptyPayload();
    source.sessions.push({
      id: 'session-1',
      targetId: 'tomny',
      workspace: 'C:/workspace',
      permissionMode: 'default',
      status: 'completed',
      createdAt: 10,
      updatedAt: 20,
      messages: [{ role: 'assistant', text: 'done', timestamp: 20 }],
    });
    source.context.agents.push({
      id: 'tomny',
      name: 'Tomny',
      role: 'assistant',
      identity: 'coding agent',
      traits: [],
      capabilities: [],
      instructions: [],
      updatedAt: 20,
    });
    const sourceMemory = memoryPorts(source);
    const exported = await new CoreCutoverService(sourceMemory.ports, {
      now: () => 30,
      createId: () => 'bundle-1',
      sourceCoreVersion: '2.0.0',
    }).exportBundle();

    const serialized = serializeCoreCutoverBundle(exported);
    expect(parseCoreCutoverBundle(serialized)).toEqual(exported);

    const targetMemory = memoryPorts(emptyPayload());
    const result = await new CoreCutoverService(targetMemory.ports, {
      now: () => 40,
      createId: () => 'rollback-1',
    }).importBundle(exported);

    expect(targetMemory.state).toEqual(source);
    expect(result.imported).toEqual({ sessions: 1, events: 0, agents: 1, people: 0, grants: 0 });
    expect(result.rollbackBundle.payload).toEqual(emptyPayload());
  });

  it('uses the production store adapters to preserve event-chain and permission state', async () => {
    const sourceSessions = new MemoryCoreSessionStore();
    const sourceEvents = new MemoryDurableEventStore();
    const sourceContext = memoryContextStore(emptyContext());
    const sourcePermissions = new MemoryPermissionRepository();
    await sourceEvents.initialize();
    await sourceSessions.save({
      id: 'session-1',
      targetId: 'tomny',
      workspace: 'C:/workspace',
      permissionMode: 'default',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      messages: [],
    });
    await sourceEvents.append({
      sessionId: 'session-1',
      kind: 'run.completed',
      visibility: 'public',
      payload: { message: 'done' },
      timestamp: 2,
    });
    await sourcePermissions.save({
      version: 1,
      grants: [],
      audit: [],
    });
    const bundle = await new CoreCutoverService(
      createCoreCutoverPorts({
        sessionStore: sourceSessions,
        eventStore: sourceEvents,
        contextStore: sourceContext,
        permissionRepository: sourcePermissions,
      })
    ).exportBundle();

    const targetSessions = new MemoryCoreSessionStore();
    const targetEvents = new MemoryDurableEventStore();
    const targetContext = memoryContextStore(emptyContext());
    const targetPermissions = new MemoryPermissionRepository();
    await targetEvents.initialize();
    await new CoreCutoverService(
      createCoreCutoverPorts({
        sessionStore: targetSessions,
        eventStore: targetEvents,
        contextStore: targetContext,
        permissionRepository: targetPermissions,
      })
    ).importBundle(bundle);

    expect(await targetSessions.list()).toEqual(await sourceSessions.list());
    expect(await targetEvents.query()).toEqual(await sourceEvents.query());
  });

  it('rejects a tampered bundle before replacing any section', async () => {
    const sourceMemory = memoryPorts(emptyPayload());
    const service = new CoreCutoverService(sourceMemory.ports, {
      now: () => 30,
      createId: () => 'bundle-1',
    });
    const bundle = await service.exportBundle();
    bundle.payload.sessions.push({
      id: 'injected',
      targetId: 'tomny',
      workspace: 'C:/workspace',
      permissionMode: 'default',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    });

    await expect(service.importBundle(bundle)).rejects.toThrow('integrity check failed');
    expect(sourceMemory.state.sessions).toEqual([]);
  });

  it('rejects raw secrets and encoded attachment bytes', async () => {
    const secretPayload = emptyPayload();
    secretPayload.sessions.push({
      id: 'session-1',
      targetId: 'tomny',
      workspace: 'C:/workspace',
      permissionMode: 'default',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      messages: [{ role: 'user', text: 'api_key=sk-abcdefghijklmnop', timestamp: 1 }],
    });
    await expect(new CoreCutoverService(memoryPorts(secretPayload).ports).exportBundle()).rejects.toThrow(
      'raw secrets'
    );

    const bytePayload = emptyPayload();
    (bytePayload.permissions as PermissionStoreState & { attachment?: unknown }).attachment = {
      type: 'Buffer',
      data: [1, 2, 3],
    };
    await expect(new CoreCutoverService(memoryPorts(bytePayload).ports).exportBundle()).rejects.toThrow(
      'encoded bytes'
    );
  });

  it('restores already replaced sections when a later section fails', async () => {
    const original = emptyPayload();
    original.sessions.push({
      id: 'old',
      targetId: 'tomny',
      workspace: 'C:/old',
      permissionMode: 'default',
      status: 'idle',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    });
    const incoming = emptyPayload();
    incoming.sessions.push({
      id: 'new',
      targetId: 'codex',
      workspace: 'C:/new',
      permissionMode: 'read-only',
      status: 'idle',
      createdAt: 2,
      updatedAt: 2,
      messages: [],
    });
    const source = new CoreCutoverService(memoryPorts(incoming).ports, {
      now: () => 3,
      createId: () => 'incoming',
    });
    const target = memoryPorts(original, 'permissions');

    await expect(new CoreCutoverService(target.ports).importBundle(await source.exportBundle())).rejects.toThrow(
      'was rolled back'
    );
    expect(target.state).toEqual(original);
  });
});
