import { randomUUID } from 'node:crypto';
import { team } from '@/common/adapter/ipcBridge';
import type { IAddTeamAgentParams, ICreateTeamParams } from '@/common/adapter/teamMapper';
import type { TeamAgent, TeammateStatus, TTeam } from '@/common/types/team/teamTypes';
import type { AgentMeshService } from '@process/agentRuntime/agentMesh/service';
import type { AgentMeshEvent, AgentMessageKind } from '@process/agentRuntime/agentMesh/mesh';
import { JsonTeamStore } from './teamStore';

const ALL_MESSAGE_KINDS: AgentMessageKind[] = ['task', 'question', 'progress', 'result', 'handoff', 'control'];
const PEER_MESSAGE_KINDS: AgentMessageKind[] = ['question', 'progress', 'result', 'handoff'];
const sessionIdFor = (teamId: string): string => `team:${teamId}`;

export type TeamBridgeDependencies = {
  store: JsonTeamStore;
  mesh: AgentMeshService;
  now?: () => number;
  id?: (prefix: string) => string;
};

const requireText = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
};

const statusFromMesh = (status: string): TeammateStatus => {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'queued' || status === 'waiting_dependency') return 'pending';
  return 'active';
};

/** Native Team CRUD + AgentMesh lifecycle. No HTTP or AionCore process is involved. */
export const createTeamBridgeHandlers = (deps: TeamBridgeDependencies) => {
  const now = deps.now ?? (() => Date.now());
  const makeId = deps.id ?? ((prefix: string) => `${prefix}-${randomUUID()}`);

  const materializeAgent = (agent: ICreateTeamParams['agents'][number]): TeamAgent => ({
    ...agent,
    slot_id: makeId('agent'),
    conversation_id: makeId('conversation'),
    agent_name: requireText(agent.agent_name, 'Agent name'),
    status: 'idle',
  });

  const emitMeshEvent = (teamId: string, event: AgentMeshEvent): void => {
    if (event.type === 'task-status') {
      const status = statusFromMesh(event.status);
      team.agentStatusChanged.emit({
        team_id: teamId,
        slot_id: event.task.agentId,
        status,
        last_message: event.detail,
      });
      void deps.store.transact((teams) => {
        const current = teams.find((candidate) => candidate.id === teamId);
        const agent = current?.agents.find((candidate) => candidate.slot_id === event.task.agentId);
        if (current && agent) {
          agent.status = status;
          current.updated_at = now();
        }
      });
      return;
    }
    if (event.type === 'message' && event.message.status === 'delivered') {
      void deps.store.get(teamId).then((current) => {
        const sender = current?.agents.find((agent) => agent.slot_id === event.message.fromAgentId);
        const target = current?.agents.find((agent) => agent.slot_id === event.message.toAgentId);
        team.teammateMessage.emit({
          conversation_id: target?.conversation_id ?? '',
          content: event.message.content,
          from_slot_id: event.message.fromAgentId,
          from_name: sender?.agent_name ?? event.message.fromAgentId,
        });
      });
    }
  };

  const hydrateSession = (current: TTeam): void => {
    const sessionId = sessionIdFor(current.id);
    if (deps.mesh.listSessions().includes(sessionId)) return;
    deps.mesh.create(sessionId, { onEvent: (event) => emitMeshEvent(current.id, event) });
    const leaderId = current.leader_agent_id;
    for (const agent of current.agents) {
      const isLeader = agent.slot_id === leaderId || agent.role === 'leader';
      deps.mesh.registerAgent(sessionId, {
        agentId: agent.slot_id,
        ...(isLeader ? {} : { parentAgentId: leaderId }),
        grants: isLeader
          ? [{ fromAgentId: agent.slot_id, toAgentId: '*', actions: ALL_MESSAGE_KINDS }]
          : [
              { fromAgentId: agent.slot_id, toAgentId: leaderId, actions: ALL_MESSAGE_KINDS },
              { fromAgentId: agent.slot_id, toAgentId: '*', actions: PEER_MESSAGE_KINDS },
            ],
      });
    }
  };

  const rebuildSession = async (teamId: string): Promise<void> => {
    const sessionId = sessionIdFor(teamId);
    if (deps.mesh.listSessions().includes(sessionId)) await deps.mesh.dispose(sessionId);
    const current = await deps.store.get(teamId);
    if (current) hydrateSession(current);
  };

  return {
    async create(input: ICreateTeamParams): Promise<TTeam> {
      const name = requireText(input.name, 'Team name');
      const userId = requireText(input.user_id, 'User id');
      if (input.agents.length === 0) throw new Error('A team requires at least one agent.');
      const agents = input.agents.map(materializeAgent);
      const leader = agents.find((agent) => agent.role === 'leader') ?? agents[0];
      leader.role = 'leader';
      const timestamp = now();
      const created: TTeam = {
        id: makeId('team'),
        user_id: userId,
        name,
        workspace: input.workspace.trim(),
        workspace_mode: input.workspace_mode,
        leader_agent_id: leader.slot_id,
        agents,
        created_at: timestamp,
        updated_at: timestamp,
      };
      await deps.store.transact((teams) => teams.push(created));
      hydrateSession(created);
      team.created.emit({ team_id: created.id, team_name: created.name });
      team.listChanged.emit({ team_id: created.id, action: 'created' });
      return created;
    },

    async list({ user_id }: { user_id: string }): Promise<TTeam[]> {
      return (await deps.store.list())
        .filter((candidate) => candidate.user_id === user_id)
        .sort((left, right) => right.updated_at - left.updated_at);
    },

    get({ id }: { id: string }): Promise<TTeam | null> {
      return deps.store.get(id);
    },

    async remove({ id }: { id: string }): Promise<void> {
      await deps.store.transact((teams) => {
        const index = teams.findIndex((candidate) => candidate.id === id);
        if (index >= 0) teams.splice(index, 1);
      });
      const sessionId = sessionIdFor(id);
      if (deps.mesh.listSessions().includes(sessionId)) await deps.mesh.dispose(sessionId);
      team.listChanged.emit({ team_id: id, action: 'removed' });
    },

    async addAgent({ team_id, agent }: IAddTeamAgentParams): Promise<TeamAgent> {
      const created = materializeAgent(agent);
      await deps.store.transact((teams) => {
        const current = teams.find((candidate) => candidate.id === team_id);
        if (!current) throw new Error(`Unknown team: ${team_id}`);
        current.agents.push(created);
        current.updated_at = now();
      });
      await rebuildSession(team_id);
      team.agentSpawned.emit({ team_id, agent: created });
      team.listChanged.emit({ team_id, action: 'agent_added' });
      return created;
    },

    async removeAgent({ team_id, slot_id }: { team_id: string; slot_id: string }): Promise<void> {
      await deps.store.transact((teams) => {
        const current = teams.find((candidate) => candidate.id === team_id);
        if (!current) return;
        if (slot_id === current.leader_agent_id) throw new Error('The team leader cannot be removed.');
        current.agents = current.agents.filter((agent) => agent.slot_id !== slot_id);
        current.updated_at = now();
      });
      await rebuildSession(team_id);
      team.agentRemoved.emit({ team_id, slot_id });
      team.listChanged.emit({ team_id, action: 'agent_removed' });
    },

    async stop({ team_id }: { team_id: string }): Promise<void> {
      const sessionId = sessionIdFor(team_id);
      if (deps.mesh.listSessions().includes(sessionId)) await deps.mesh.dispose(sessionId);
    },

    async ensureSession({ team_id }: { team_id: string }): Promise<void> {
      const current = await deps.store.get(team_id);
      if (!current) throw new Error(`Unknown team: ${team_id}`);
      hydrateSession(current);
    },

    async renameAgent(input: { team_id: string; slot_id: string; new_name: string }): Promise<void> {
      const name = requireText(input.new_name, 'Agent name');
      let oldName = '';
      await deps.store.transact((teams) => {
        const current = teams.find((candidate) => candidate.id === input.team_id);
        const agent = current?.agents.find((candidate) => candidate.slot_id === input.slot_id);
        if (!current || !agent) throw new Error(`Unknown team agent: ${input.slot_id}`);
        oldName = agent.agent_name;
        agent.agent_name = name;
        current.updated_at = now();
      });
      team.agentRenamed.emit({ team_id: input.team_id, slot_id: input.slot_id, old_name: oldName, new_name: name });
    },

    async renameTeam({ id, name: rawName }: { id: string; name: string }): Promise<void> {
      const name = requireText(rawName, 'Team name');
      await deps.store.transact((teams) => {
        const current = teams.find((candidate) => candidate.id === id);
        if (!current) throw new Error(`Unknown team: ${id}`);
        current.name = name;
        current.updated_at = now();
      });
      team.listChanged.emit({ team_id: id, action: 'created' });
    },

    async setSessionMode(input: { team_id: string; session_mode: string }): Promise<void> {
      await deps.store.transact((teams) => {
        const current = teams.find((candidate) => candidate.id === input.team_id);
        if (!current) throw new Error(`Unknown team: ${input.team_id}`);
        current.session_mode = input.session_mode;
        current.updated_at = now();
      });
    },
  };
};

export type TeamBridgeHandlers = ReturnType<typeof createTeamBridgeHandlers>;

/** Register typed Electron providers used by the renderer `ipcBridge.team` facade. */
export const registerTeamBridge = (deps: TeamBridgeDependencies): TeamBridgeHandlers => {
  const handlers = createTeamBridgeHandlers(deps);
  team.create.provider(handlers.create);
  team.list.provider(handlers.list);
  team.get.provider(handlers.get);
  team.remove.provider(handlers.remove);
  team.addAgent.provider(handlers.addAgent);
  team.removeAgent.provider(handlers.removeAgent);
  team.stop.provider(handlers.stop);
  team.ensureSession.provider(handlers.ensureSession);
  team.renameAgent.provider(handlers.renameAgent);
  team.renameTeam.provider(handlers.renameTeam);
  team.setSessionMode.provider(handlers.setSessionMode);
  return handlers;
};
