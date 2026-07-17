import type { DurableEventKind, DurableEventPayload, DurableEventStore } from '@process/services/agentChat/durability';

import {
  createAgentMesh,
  type AgentId,
  type AgentInspection,
  type AgentMeshEvent,
  type AgentMeshOptions,
  type AgentMeshRecoveredState,
  type AgentMeshTask,
  type AgentMessage,
  type AgentMessageKind,
  type AgentTaskExecutor,
  type MessageId,
  type TaskId,
} from './mesh';

export type AgentDeliveryIntent =
  | 'send-now'
  | 'enqueue-after-task'
  | 'graceful-interrupt-and-send'
  | 'interrupt-and-send'
  | 'cancel-and-replace';

export type AgentControllerMessageInput = Omit<
  AgentMessage,
  'messageId' | 'status' | 'sequence' | 'createdAt' | 'deliveredAt' | 'deliveryMode'
> & {
  delivery: AgentDeliveryIntent;
};

export type AgentWorklogEntry = {
  sequence: number;
  timestamp: number;
  agentId: AgentId;
  taskId?: TaskId;
  kind: 'task' | 'action' | 'message' | 'queue' | 'watchdog' | 'control';
  summary: string;
};

export type AgentMeshControllerOptions = Omit<AgentMeshOptions, 'onEvent'> & {
  sessionId: string;
  eventStore?: DurableEventStore;
  onEvent?: (event: AgentMeshEvent) => void;
  watchdogIntervalMs?: number;
  maxConsecutiveStalls?: number;
  stallAction?: 'graceful' | 'interrupt' | 'cancel';
  maxWorklogEntries?: number;
};

const deliveryMode = (intent: AgentDeliveryIntent): AgentMessage['deliveryMode'] => {
  if (intent === 'send-now') return 'immediate';
  if (intent === 'enqueue-after-task') return 'queue';
  if (intent === 'graceful-interrupt-and-send') return 'graceful-interrupt';
  if (intent === 'interrupt-and-send') return 'interrupt';
  return 'cancel-and-replace';
};

const durableKind = (event: AgentMeshEvent): DurableEventKind => {
  if (event.type === 'task-status') return 'run.status';
  if (event.type === 'message') return 'agent.message';
  if (event.type === 'queue-changed') return 'message.updated';
  return 'custom';
};

const durablePayload = (event: AgentMeshEvent): DurableEventPayload => {
  if (event.type === 'task-status') {
    return { agentId: event.task.agentId, taskId: event.task.taskId, status: event.status };
  }
  if (event.type === 'action') {
    return {
      taskId: event.action.taskId,
      actionId: event.action.actionId,
      name: event.action.name,
      status: event.action.status,
    };
  }
  if (event.type === 'message') {
    return {
      messageId: event.message.messageId,
      taskId: event.message.taskId ?? null,
      fromAgentId: event.message.fromAgentId,
      toAgentId: event.message.toAgentId,
      messageKind: event.message.kind,
      deliveryMode: event.message.deliveryMode,
      status: event.message.status,
    };
  }
  if (event.type === 'queue-changed') {
    return { agentId: event.agentId, messageIds: event.messages.map((message) => message.messageId) };
  }
  return {
    agentId: event.agentId,
    taskId: event.taskId ?? null,
    stuck: event.stuck,
    idleMs: event.idleMs,
  };
};

const CHECKPOINT_REQUEST_ID = 'agent-mesh/checkpoint/v1';

type AgentMeshCheckpoint = {
  schema: 'tomny.agent-mesh.checkpoint.v1';
  state: AgentMeshRecoveredState;
  worklog: AgentWorklogEntry[];
};

const toDurablePayload = (value: AgentMeshCheckpoint): DurableEventPayload => {
  const checkpoint = structuredClone(value);
  const tasks = checkpoint.state.tasks as Array<{
    task: AgentMeshTask & { estimatedBudgetUnits?: number };
    status: string;
  }>;
  for (const entry of tasks) {
    entry.task.estimatedBudgetUnits = entry.task.estimatedTokens;
    delete entry.task.estimatedTokens;
  }
  return JSON.parse(JSON.stringify(checkpoint)) as DurableEventPayload;
};

const checkpointFromPayload = (payload: DurableEventPayload): AgentMeshCheckpoint | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  if (payload.schema !== 'tomny.agent-mesh.checkpoint.v1') return undefined;
  if (!payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) return undefined;
  if (!Array.isArray(payload.worklog)) return undefined;
  const state = payload.state;
  if (
    !Array.isArray(state.agents) ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.actions) ||
    !Array.isArray(state.queues) ||
    !Array.isArray(state.progress) ||
    typeof state.spentBudgetUnits !== 'number'
  )
    return undefined;
  const checkpoint = structuredClone(payload) as unknown as AgentMeshCheckpoint;
  const tasks = checkpoint.state.tasks as Array<{
    task: AgentMeshTask & { estimatedBudgetUnits?: number };
    status: string;
  }>;
  for (const entry of tasks) {
    entry.task.estimatedTokens = entry.task.estimatedBudgetUnits;
    delete entry.task.estimatedBudgetUnits;
  }
  return checkpoint;
};

/** Host-facing controller for Team and Company orchestration over the provider-neutral mesh. */
export type AgentMeshController = ReturnType<typeof createAgentMeshController>;

export const createAgentMeshController = (options: AgentMeshControllerOptions) => {
  const now = options.now ?? Date.now;
  const agents = new Set<AgentId>();
  const stallCounts = new Map<AgentId, number>();
  const worklog: AgentWorklogEntry[] = [];
  const maxWorklogEntries = options.maxWorklogEntries ?? 5_000;
  const maxConsecutiveStalls = options.maxConsecutiveStalls ?? 3;
  if (!options.sessionId.trim()) throw new Error('AgentMesh controller sessionId is required.');
  if (!Number.isSafeInteger(maxWorklogEntries) || maxWorklogEntries < 1) {
    throw new Error('maxWorklogEntries must be a positive integer.');
  }
  if (!Number.isSafeInteger(maxConsecutiveStalls) || maxConsecutiveStalls < 1) {
    throw new Error('maxConsecutiveStalls must be a positive integer.');
  }
  let worklogSequence = 0;
  let durableQueue = options.eventStore?.initialize() ?? Promise.resolve();
  const taskAgent = new Map<TaskId, AgentId>();

  let snapshotState: (() => AgentMeshRecoveredState) | undefined;

  function queueCheckpoint(): void {
    if (!options.eventStore || !snapshotState) return;
    const checkpoint: AgentMeshCheckpoint = {
      schema: 'tomny.agent-mesh.checkpoint.v1',
      state: snapshotState(),
      worklog: structuredClone(worklog),
    };
    durableQueue = durableQueue
      .then(() =>
        options.eventStore!.append({
          sessionId: options.sessionId,
          requestId: CHECKPOINT_REQUEST_ID,
          kind: 'custom',
          visibility: 'private',
          payload: toDurablePayload(checkpoint),
        })
      )
      .then((): void => undefined);
  }

  const addWorklog = (entry: Omit<AgentWorklogEntry, 'sequence' | 'timestamp'>): void => {
    worklog.push({ ...entry, sequence: ++worklogSequence, timestamp: now() });
    if (worklog.length > maxWorklogEntries) worklog.splice(0, worklog.length - maxWorklogEntries);
  };

  const mesh = createAgentMesh({
    ...options,
    onEvent: (event) => {
      if (event.type === 'task-status') {
        addWorklog({
          agentId: event.task.agentId,
          taskId: event.task.taskId,
          kind: 'task',
          summary: `Task ${event.status}`,
        });
      } else if (event.type === 'action') {
        addWorklog({
          agentId: taskAgent.get(event.action.taskId) ?? 'unknown',
          taskId: event.action.taskId,
          kind: 'action',
          summary: `${event.action.name}: ${event.action.status}`,
        });
      } else if (event.type === 'message') {
        addWorklog({
          agentId: event.message.toAgentId,
          taskId: event.message.taskId,
          kind: 'message',
          summary: `${event.message.fromAgentId} -> ${event.message.toAgentId}: ${event.message.status}`,
        });
      } else if (event.type === 'queue-changed') {
        addWorklog({
          agentId: event.agentId,
          kind: 'queue',
          summary: `Queue contains ${event.messages.length} message(s)`,
        });
      } else {
        addWorklog({
          agentId: event.agentId,
          taskId: event.taskId,
          kind: 'watchdog',
          summary: event.stuck ? 'Agent appears stalled' : 'Agent heartbeat healthy',
        });
      }
      if (options.eventStore) {
        durableQueue = durableQueue
          .then(() =>
            options.eventStore!.append({
              sessionId: options.sessionId,
              requestId:
                event.type === 'task-status' ? event.task.taskId : 'taskId' in event ? event.taskId : undefined,
              kind: durableKind(event),
              visibility: 'private',
              payload: durablePayload(event),
            })
          )
          .then((): void => undefined);
      }
      queueCheckpoint();

      options.onEvent?.(event);
    },
  });

  snapshotState = mesh.exportState;

  const requireControlGrant = (actorId: AgentId, targetId: AgentId): void => {
    if (actorId !== targetId && !mesh.hasCommunicationGrant(actorId, targetId, 'control')) {
      throw new Error(`Permission denied: ${actorId} cannot control ${targetId}`);
    }
  };

  const registerAgent = (agent: Parameters<typeof mesh.registerAgent>[0]): void => {
    mesh.registerAgent(agent);
    agents.add(agent.agentId);
    addWorklog({ agentId: agent.agentId, kind: 'control', summary: 'Agent registered' });

    queueCheckpoint();
  };

  const submitTask = (task: AgentMeshTask, executor: AgentTaskExecutor): TaskId => {
    taskAgent.set(task.taskId, task.agentId);
    return mesh.submitTask(task, executor);
  };

  const sendMessage = (input: AgentControllerMessageInput): AgentMessage =>
    mesh.sendMessage({
      taskId: input.taskId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      kind: input.kind,
      content: input.content,
      deliveryMode: deliveryMode(input.delivery),
    });

  const requireQueuedMessage = (targetId: AgentId, messageId: MessageId): void => {
    const message = mesh.getQueue(targetId).find((item) => item.messageId === messageId);
    if (!message) throw new Error(`Unknown queued message: ${messageId}`);
    if (message.status !== 'queued') throw new Error(`Message is no longer queued: ${messageId}`);
  };

  const updateQueuedMessage = (
    actorId: AgentId,
    targetId: AgentId,
    messageId: MessageId,
    patch: Partial<Pick<AgentMessage, 'content' | 'deliveryMode'>>
  ): AgentMessage | undefined => {
    requireControlGrant(actorId, targetId);
    requireQueuedMessage(targetId, messageId);
    return mesh.updateQueue(targetId, messageId, patch);
  };

  const removeQueuedMessage = (actorId: AgentId, targetId: AgentId, messageId: MessageId) => {
    requireControlGrant(actorId, targetId);
    requireQueuedMessage(targetId, messageId);
    return mesh.removeMessage(targetId, messageId);
  };

  const reorderQueuedMessage = (
    actorId: AgentId,
    targetId: AgentId,
    messageId: MessageId,
    beforeMessageId?: MessageId
  ): AgentMessage[] => {
    requireControlGrant(actorId, targetId);
    requireQueuedMessage(targetId, messageId);
    return mesh.reorderMessage(targetId, messageId, beforeMessageId);
  };

  const stopTask = (actorId: AgentId, taskId: TaskId, mode: 'graceful' | 'interrupt' | 'cancel'): void => {
    const targetId = taskAgent.get(taskId);
    if (!targetId) throw new Error(`Unknown task: ${taskId}`);
    requireControlGrant(actorId, targetId);
    mesh.stopTask(taskId, mode);
    addWorklog({ agentId: targetId, taskId, kind: 'control', summary: `${actorId} requested ${mode}` });
    queueCheckpoint();
  };

  const runWatchdogCheck = (): AgentInspection[] => {
    const inspections = [...agents].map((agentId) => mesh.inspect(agentId));
    for (const inspection of inspections) {
      const agentId = inspection.agent.agentId;
      if (!inspection.stuck || !inspection.task) {
        stallCounts.delete(agentId);
        continue;
      }
      const count = (stallCounts.get(agentId) ?? 0) + 1;
      stallCounts.set(agentId, count);
      if (count >= maxConsecutiveStalls) {
        mesh.stopTask(inspection.task.taskId, options.stallAction ?? 'graceful');
        addWorklog({
          agentId,
          taskId: inspection.task.taskId,
          kind: 'control',
          summary: `Watchdog applied ${options.stallAction ?? 'graceful'}`,
        });
        stallCounts.delete(agentId);
        queueCheckpoint();
      }
    }
    return inspections;
  };

  const rehydrate = async (): Promise<boolean> => {
    if (!options.eventStore) return false;
    await durableQueue;
    const latestSequence = await options.eventStore.latestSequence();
    const events = await options.eventStore.query({
      sessionId: options.sessionId,
      requestId: CHECKPOINT_REQUEST_ID,
      kinds: ['custom'],
      afterSequence: Math.max(0, latestSequence - 10_000),
      limit: 10_000,
    });
    const checkpoint = events
      .toReversed()
      .map((event) => checkpointFromPayload(event.payload))
      .find((entry): entry is AgentMeshCheckpoint => entry !== undefined);
    if (!checkpoint) return false;

    const state = structuredClone(checkpoint.state);
    const interruptedAgents = new Set<AgentId>();
    for (const entry of state.tasks) {
      if (entry.status === 'starting' || entry.status === 'working') {
        entry.status = 'interrupted';
        interruptedAgents.add(entry.task.agentId);
      }
    }
    for (const action of state.actions) {
      if (action.status === 'started') {
        action.status = 'failed';
        action.detail = action.detail
          ? action.detail + ' (interrupted by process restart)'
          : 'Interrupted by process restart';
        action.finishedAt = now();
      }
    }
    for (const entry of state.queues) {
      if (!interruptedAgents.has(entry.agentId)) continue;
      for (const message of entry.messages) {
        if (message.status !== 'delivered') continue;
        message.status = 'queued';
        message.deliveredAt = undefined;
      }
    }

    mesh.restoreState(state);
    for (const agent of state.agents) agents.add(agent.agentId);
    for (const entry of state.tasks) taskAgent.set(entry.task.taskId, entry.task.agentId);
    worklog.splice(0, worklog.length, ...structuredClone(checkpoint.worklog.slice(-maxWorklogEntries)));
    worklogSequence = Math.max(0, ...worklog.map((entry) => entry.sequence));
    for (const entry of state.tasks) {
      if (entry.status === 'interrupted' && interruptedAgents.has(entry.task.agentId)) {
        addWorklog({
          agentId: entry.task.agentId,
          taskId: entry.task.taskId,
          kind: 'control',
          summary: 'Task interrupted by process restart',
        });
      }
    }
    queueCheckpoint();
    await durableQueue;
    return true;
  };

  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  if (options.watchdogIntervalMs !== undefined) {
    if (!Number.isFinite(options.watchdogIntervalMs) || options.watchdogIntervalMs < 10) {
      throw new Error('watchdogIntervalMs must be at least 10ms.');
    }
    watchdogTimer = setInterval(runWatchdogCheck, options.watchdogIntervalMs);
    watchdogTimer.unref?.();
  }

  return {
    listAgents: mesh.listAgents,
    listTasks: mesh.listTasks,
    registerAgent,
    submitTask,
    sendMessage,
    updateQueuedMessage,
    removeQueuedMessage,
    reorderQueuedMessage,

    rehydrate,
    stopTask,
    runWatchdogCheck,
    inspect: mesh.inspect,
    heartbeat: mesh.heartbeat,
    getQueue: mesh.getQueue,
    getStatus: mesh.getStatus,
    getTokenUsage: mesh.getTokenUsage,
    waitForIdle: mesh.waitForIdle,
    canSend: (fromAgentId: AgentId, toAgentId: AgentId, kind: AgentMessageKind) =>
      mesh.hasCommunicationGrant(fromAgentId, toAgentId, kind),
    getWorklog: (agentId?: AgentId) =>
      structuredClone(worklog.filter((entry) => agentId === undefined || entry.agentId === agentId)),
    flush: async (): Promise<void> => durableQueue,
    dispose: async (): Promise<void> => {
      if (watchdogTimer) clearInterval(watchdogTimer);
      await durableQueue;
    },
  };
};
