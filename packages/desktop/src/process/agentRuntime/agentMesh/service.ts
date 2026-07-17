import type {
  AgentId,
  AgentInspection,
  AgentMeshAgent,
  AgentMeshTask,
  AgentMessage,
  AgentMessageKind,
  AgentTaskExecutor,
  MessageId,
  TaskId,
} from './mesh';
import {
  createAgentMeshController,
  type AgentControllerMessageInput,
  type AgentDeliveryIntent,
  type AgentMeshController,
  type AgentMeshControllerOptions,
} from './controller';
import type { DurableEventStore } from '@process/services/agentChat/durability';

export type AgentMeshSnapshot = {
  sessionId: string;
  agents: AgentMeshAgent[];
  inspections: AgentInspection[];
  tasks: Array<{ task: AgentMeshTask; status: string }>;
  tokenUsage: { spentTokens: number; reservedTokens: number; budget?: number };
};

export type AgentMeshServiceOptions = {
  /** Optional persistent journal factory; one event stream is kept per session. */
  eventStoreFactory?: (sessionId: string) => DurableEventStore;
  /** Override controller creation when the host needs custom executors/watchdog policy. */
  createController?: (sessionId: string) => AgentMeshController;
};

/** Durable-session registry for Team/Company orchestration. No AionCore dependency. */
export class AgentMeshService {
  private readonly sessions = new Map<string, AgentMeshController>();
  private readonly createController: (sessionId: string) => AgentMeshController;
  private readonly eventStoreFactory?: (sessionId: string) => DurableEventStore;

  constructor(options: AgentMeshServiceOptions = {}) {
    this.eventStoreFactory = options.eventStoreFactory;
    this.createController =
      options.createController ??
      ((sessionId) => createAgentMeshController({ sessionId, eventStore: options.eventStoreFactory?.(sessionId) }));
  }

  register(sessionId: string, controller: AgentMeshController): void {
    const id = sessionId.trim();
    if (!id) throw new Error('AgentMesh sessionId is required.');
    if (this.sessions.has(id)) throw new Error(`AgentMesh session already exists: ${id}`);
    this.sessions.set(id, controller);
  }

  create(
    sessionId: string,
    options: Omit<AgentMeshControllerOptions, 'sessionId' | 'eventStore'> = {}
  ): AgentMeshController {
    const id = sessionId.trim();
    if (!id) throw new Error('AgentMesh sessionId is required.');
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const controller =
      Object.keys(options).length === 0
        ? this.createController(id)
        : createAgentMeshController({
            ...options,
            sessionId: id,
            eventStore: this.eventStoreFactory?.(id),
          });
    this.sessions.set(id, controller);
    return controller;
  }

  /** Rebuild a durable session before exposing it to Team/Company callers. */
  async recover(
    sessionId: string,
    options: Omit<AgentMeshControllerOptions, 'sessionId' | 'eventStore'> = {}
  ): Promise<AgentMeshController> {
    const id = sessionId.trim();
    if (!id) throw new Error('AgentMesh sessionId is required.');
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const controller = this.create(id, options);
    try {
      await controller.rehydrate();
      return controller;
    } catch (error) {
      this.sessions.delete(id);
      await controller.dispose();
      throw error;
    }
  }

  get(sessionId: string): AgentMeshController {
    const id = sessionId.trim();
    if (!id) throw new Error('AgentMesh sessionId is required.');
    const controller = this.sessions.get(id);
    if (!controller) throw new Error(`Unknown AgentMesh session: ${id}`);
    return controller;
  }

  listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  snapshot(sessionId: string): AgentMeshSnapshot {
    const controller = this.get(sessionId);
    const agents = controller.listAgents();
    return {
      sessionId,
      agents,
      inspections: agents.map((agent) => controller.inspect(agent.agentId)),
      tasks: controller.listTasks(),
      tokenUsage: controller.getTokenUsage(),
    };
  }

  registerAgent(sessionId: string, agent: AgentMeshAgent): void {
    this.get(sessionId).registerAgent(agent);
  }

  submitTask(sessionId: string, task: AgentMeshTask, executor: AgentTaskExecutor): TaskId {
    return this.get(sessionId).submitTask(task, executor);
  }

  send(sessionId: string, input: AgentControllerMessageInput): AgentMessage {
    return this.get(sessionId).sendMessage(input);
  }

  updateQueue(
    sessionId: string,
    actorId: AgentId,
    targetId: AgentId,
    messageId: MessageId,
    patch: Partial<Pick<AgentMessage, 'content' | 'deliveryMode'>>
  ): AgentMessage | undefined {
    return this.get(sessionId).updateQueuedMessage(actorId, targetId, messageId, patch);
  }

  removeQueue(sessionId: string, actorId: AgentId, targetId: AgentId, messageId: MessageId): AgentMessage | undefined {
    return this.get(sessionId).removeQueuedMessage(actorId, targetId, messageId);
  }

  reorderQueue(
    sessionId: string,
    actorId: AgentId,
    targetId: AgentId,
    messageId: MessageId,
    beforeMessageId?: MessageId
  ): AgentMessage[] {
    return this.get(sessionId).reorderQueuedMessage(actorId, targetId, messageId, beforeMessageId);
  }

  stop(sessionId: string, actorId: AgentId, taskId: TaskId, mode: 'graceful' | 'interrupt' | 'cancel'): void {
    this.get(sessionId).stopTask(actorId, taskId, mode);
  }

  heartbeat(sessionId: string, agentId: AgentId): void {
    this.get(sessionId).heartbeat(agentId);
  }

  inspect(sessionId: string, agentId: AgentId): AgentInspection {
    return this.get(sessionId).inspect(agentId);
  }

  getWorklog(sessionId: string, agentId?: AgentId) {
    return this.get(sessionId).getWorklog(agentId);
  }

  canSend(sessionId: string, fromAgentId: AgentId, toAgentId: AgentId, kind: AgentMessageKind): boolean {
    return this.get(sessionId).canSend(fromAgentId, toAgentId, kind);
  }

  watchdog(sessionId: string): AgentInspection[] {
    return this.get(sessionId).runWatchdogCheck();
  }

  async dispose(sessionId: string): Promise<void> {
    const controller = this.sessions.get(sessionId);
    if (!controller) return;
    this.sessions.delete(sessionId);
    await controller.dispose();
  }

  async disposeAll(): Promise<void> {
    const ids = this.listSessions();
    await Promise.all(ids.map((id) => this.dispose(id)));
  }
}

export const createAgentMeshService = (options?: AgentMeshServiceOptions): AgentMeshService =>
  new AgentMeshService(options);

export type { AgentControllerMessageInput, AgentDeliveryIntent };
