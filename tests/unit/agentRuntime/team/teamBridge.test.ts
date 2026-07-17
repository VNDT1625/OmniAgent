import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const teamEvents = vi.hoisted(() => {
  const event = () => ({ emit: vi.fn() });
  return {
    agentStatusChanged: event(),
    agentSpawned: event(),
    agentRemoved: event(),
    agentRenamed: event(),
    listChanged: event(),
    created: event(),
    teammateMessage: event(),
  };
});

vi.mock('@/common/adapter/ipcBridge', () => ({
  team: {
    ...teamEvents,
    create: { provider: vi.fn() },
    list: { provider: vi.fn() },
    get: { provider: vi.fn() },
    remove: { provider: vi.fn() },
    addAgent: { provider: vi.fn() },
    removeAgent: { provider: vi.fn() },
    stop: { provider: vi.fn() },
    ensureSession: { provider: vi.fn() },
    renameAgent: { provider: vi.fn() },
    renameTeam: { provider: vi.fn() },
    setSessionMode: { provider: vi.fn() },
  },
}));

import { AgentMeshService } from '@process/agentRuntime/agentMesh/service';
import { createTeamBridgeHandlers, registerTeamBridge } from '@process/team/teamBridge';
import { JsonTeamStore } from '@process/team/teamStore';

const directories: string[] = [];
const makeHarness = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tomny-team-'));
  directories.push(directory);
  let sequence = 0;
  const store = new JsonTeamStore(path.join(directory, 'teams.json'));
  const mesh = new AgentMeshService();
  const handlers = createTeamBridgeHandlers({
    store,
    mesh,
    now: () => 1_000 + sequence,
    id: (prefix) => `${prefix}-${++sequence}`,
  });
  return { directory, store, mesh, handlers };
};

const input = {
  user_id: 'user-1',
  name: 'Release team',
  workspace: 'C:/repo',
  workspace_mode: 'shared' as const,
  agents: [
    {
      role: 'leader' as const,
      agent_type: 'tomny',
      agent_name: 'Lead',
      conversation_type: 'aionrs',
      status: 'pending' as const,
    },
    {
      role: 'teammate' as const,
      agent_type: 'codex',
      agent_name: 'QA',
      conversation_type: 'acp',
      status: 'pending' as const,
    },
  ],
};

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('native Team compatibility gateway', () => {
  it('persists a team and hydrates the shared AgentMesh with leader-controlled peer communication', async () => {
    const { handlers, mesh, directory } = await makeHarness();
    const created = await handlers.create(input);

    expect((await handlers.list({ user_id: 'user-1' }))[0]?.id).toBe(created.id);
    expect(mesh.listSessions()).toContain(`team:${created.id}`);
    const [leader, teammate] = created.agents;
    expect(mesh.canSend(`team:${created.id}`, leader.slot_id, teammate.slot_id, 'control')).toBe(true);
    expect(mesh.canSend(`team:${created.id}`, teammate.slot_id, leader.slot_id, 'result')).toBe(true);

    const reloaded = await new JsonTeamStore(path.join(directory, 'teams.json')).get(created.id);
    expect(reloaded?.agents).toHaveLength(2);
  });

  it('updates agents durably and refuses to remove the leader', async () => {
    const { handlers } = await makeHarness();
    const created = await handlers.create(input);
    const leader = created.agents.find((agent) => agent.role === 'leader')!;
    const teammate = created.agents.find((agent) => agent.role === 'teammate')!;

    await handlers.renameAgent({ team_id: created.id, slot_id: teammate.slot_id, new_name: 'Verifier' });
    await handlers.removeAgent({ team_id: created.id, slot_id: teammate.slot_id });

    expect((await handlers.get({ id: created.id }))?.agents.map((agent) => agent.agent_name)).toEqual(['Lead']);
    await expect(handlers.removeAgent({ team_id: created.id, slot_id: leader.slot_id })).rejects.toThrow(
      'leader cannot be removed'
    );
  });

  it('registers every renderer Team operation on typed Electron providers', async () => {
    const { store, mesh } = await makeHarness();

    registerTeamBridge({ store, mesh });

    for (const operation of [
      'create',
      'list',
      'get',
      'remove',
      'addAgent',
      'removeAgent',
      'stop',
      'ensureSession',
      'renameAgent',
      'renameTeam',
      'setSessionMode',
    ] as const) {
      expect((await import('@/common/adapter/ipcBridge')).team[operation].provider).toHaveBeenCalledOnce();
    }
  });

  it('recovers from a corrupt metadata file without exposing partial data', async () => {
    const { directory } = await makeHarness();
    const filePath = path.join(directory, 'corrupt.json');
    await writeFile(filePath, '{broken', 'utf8');

    expect(await new JsonTeamStore(filePath).list()).toEqual([]);
  });
});
