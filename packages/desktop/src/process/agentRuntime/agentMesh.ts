/**
 * Provider-agnostic agent mesh for Company/Team execution.
 * Providers supply an executor; the mesh owns scheduling, mailbox policy,
 * queue mutation, cancellation and observability.
 */

export type AgentId = string;
export type TaskId = string;
export type MessageId = string;
export type AgentMessageKind = 'task' | 'question' | 'progress' | 'result' | 'handoff' | 'control';
export type DeliveryMode = 'queue' | 'graceful-interrupt' | 'interrupt' | 'cancel-and-replace';
export type AgentTaskStatus =
  | 'queued'
  | 'waiting_dependency'
  | 'starting'
  | 'working'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type AgentCommunicationGrant = { fromAgentId: AgentId; toAgentId: AgentId | '*'; actions: AgentMessageKind[] };
export type AgentMeshAgent = { agentId: AgentId; parentAgentId?: AgentId; grants?: AgentCommunicationGrant[] };
export type AgentMeshTask = {
  taskId: TaskId;
  agentId: AgentId;
  parentAgentId?: AgentId;
  objective: string;
  dependsOn?: TaskId[];
  estimatedTokens?: number;
  priority?: number;
};
export type AgentAction = {
  actionId: string;
  taskId: TaskId;
  name: string;
  status: 'started' | 'completed' | 'failed';
  detail?: string;
  startedAt: number;
  finishedAt?: number;
};
export type AgentMessage = {
  messageId: MessageId;
  taskId?: TaskId;
  fromAgentId: AgentId;
  toAgentId: AgentId;
  kind: AgentMessageKind;
  content: string;
  deliveryMode: DeliveryMode;
  status: 'queued' | 'delivered' | 'removed' | 'cancelled';
  sequence: number;
  createdAt: number;
  deliveredAt?: number;
};
export type AgentTaskResult = { summary: string; tokensUsed?: number };
export type AgentTaskContext = {
  signal: AbortSignal;
  emitAction(
    name: string,
    detail?: string
  ): { complete(detail?: string): void; fail(detail?: string): void; check(): void };
  getQueuedMessages(): AgentMessage[];
  checkControl(): void;
};
export type AgentTaskExecutor = (task: AgentMeshTask, context: AgentTaskContext) => Promise<AgentTaskResult>;
export type AgentMeshEvent =
  | { type: 'task-status'; task: AgentMeshTask; status: AgentTaskStatus; detail?: string }
  | { type: 'action'; action: AgentAction }
  | { type: 'message'; message: AgentMessage }
  | { type: 'queue-changed'; agentId: AgentId; messages: AgentMessage[] }
  | { type: 'watchdog'; agentId: AgentId; taskId?: TaskId; stuck: boolean; idleMs: number };
export type AgentInspection = {
  agent: AgentMeshAgent;
  task?: AgentMeshTask;
  status: AgentTaskStatus | 'idle';
  currentAction?: AgentAction;
  actionHistory: AgentAction[];
  queue: AgentMessage[];
  lastProgressAt?: number;
  stuck: boolean;
};
export type AgentMeshOptions = {
  totalTokenBudget?: number;
  watchdogMs?: number;
  maxConcurrent?: number;
  now?: () => number;
  id?: (prefix: string) => string;
  onEvent?: (event: AgentMeshEvent) => void;
};

class AgentTaskControlError extends Error {
  constructor(public readonly status: 'interrupted' | 'cancelled') {
    super(status);
    this.name = 'AgentTaskControlError';
  }
}

export function createAgentMesh(options: AgentMeshOptions = {}) {
  const now = options.now ?? (() => Date.now());
  const makeId = options.id ?? ((prefix: string) => prefix + '-' + Math.random().toString(36).slice(2, 10));
  const agents = new Map<AgentId, AgentMeshAgent>();
  const tasks = new Map<TaskId, AgentMeshTask>();
  const statuses = new Map<TaskId, AgentTaskStatus>();
  const executors = new Map<TaskId, AgentTaskExecutor>();
  const controllers = new Map<TaskId, AbortController>();
  const actions = new Map<TaskId, AgentAction[]>();
  const queues = new Map<AgentId, AgentMessage[]>();
  const controls = new Map<TaskId, { graceful: boolean; cancelled: boolean }>();
  const progressAt = new Map<AgentId, number>();
  const pending = new Set<Promise<void>>();
  let sequence = 0;
  let running = 0;
  let spentTokens = 0;
  let reservedTokens = 0;
  const emit = (event: AgentMeshEvent) => options.onEvent?.(event);
  const getQueue = (agentId: AgentId) => queues.get(agentId) ?? [];
  const replaceQueue = (agentId: AgentId, messages: AgentMessage[]) => {
    queues.set(agentId, messages);
    emit({ type: 'queue-changed', agentId, messages: [...messages] });
  };
  const setStatus = (task: AgentMeshTask, status: AgentTaskStatus, detail?: string) => {
    statuses.set(task.taskId, status);
    progressAt.set(task.agentId, now());
    emit({ type: 'task-status', task, status, detail });
  };
  const depsDone = (task: AgentMeshTask) => (task.dependsOn ?? []).every((id) => statuses.get(id) === 'completed');
  const canStart = (task: AgentMeshTask) => ['queued', 'waiting_dependency'].includes(statuses.get(task.taskId) ?? '');
  const hasGrant = (message: AgentMessage) =>
    agents
      .get(message.fromAgentId)
      ?.grants?.some(
        (grant) =>
          grant.fromAgentId === message.fromAgentId &&
          (grant.toAgentId === '*' || grant.toAgentId === message.toAgentId) &&
          grant.actions.includes(message.kind)
      ) ?? false;

  const runTask = async (task: AgentMeshTask) => {
    if (!canStart(task) || running >= (options.maxConcurrent ?? Number.POSITIVE_INFINITY)) return;
    if (!depsDone(task)) {
      setStatus(task, 'waiting_dependency');
      return;
    }
    const estimate = task.estimatedTokens ?? 0;
    if (options.totalTokenBudget !== undefined && spentTokens + reservedTokens + estimate > options.totalTokenBudget) {
      setStatus(task, 'failed', 'token budget exhausted');
      return;
    }
    running += 1;
    reservedTokens += estimate;
    const controller = new AbortController();
    controllers.set(task.taskId, controller);
    controls.set(task.taskId, { graceful: false, cancelled: false });
    const taskActions = actions.get(task.taskId) ?? [];
    actions.set(task.taskId, taskActions);
    setStatus(task, 'starting');
    const context: AgentTaskContext = {
      signal: controller.signal,
      emitAction: (name, detail) => {
        const action: AgentAction = {
          actionId: makeId('action'),
          taskId: task.taskId,
          name,
          detail,
          status: 'started',
          startedAt: now(),
        };
        taskActions.push(action);
        progressAt.set(task.agentId, now());
        emit({ type: 'action', action });
        return {
          check: () => context.checkControl(),
          complete: (value?: string) => {
            action.status = 'completed';
            action.detail = value ?? action.detail;
            action.finishedAt = now();
            emit({ type: 'action', action });
          },
          fail: (value?: string) => {
            action.status = 'failed';
            action.detail = value ?? action.detail;
            action.finishedAt = now();
            emit({ type: 'action', action });
          },
        };
      },
      getQueuedMessages: () => getQueue(task.agentId).filter((message) => message.status === 'delivered'),
      checkControl: () => {
        const control = controls.get(task.taskId);
        if (controller.signal.aborted)
          throw new AgentTaskControlError(control?.cancelled ? 'cancelled' : 'interrupted');
        if (control?.graceful) throw new AgentTaskControlError('interrupted');
      },
    };
    setStatus(task, 'working');
    try {
      const result = await executors.get(task.taskId)?.(task, context);
      spentTokens += result?.tokensUsed ?? estimate;
      setStatus(task, 'completed', result?.summary);
    } catch (error) {
      if (error instanceof AgentTaskControlError) setStatus(task, error.status);
      else if (controller.signal.aborted)
        setStatus(task, controls.get(task.taskId)?.cancelled ? 'cancelled' : 'interrupted');
      else setStatus(task, 'failed', error instanceof Error ? error.message : String(error));
    } finally {
      reservedTokens -= estimate;
      running -= 1;
      controllers.delete(task.taskId);
      controls.delete(task.taskId);
      progressAt.set(task.agentId, now());
    }
  };
  const pump = () => {
    for (const task of tasks.values()) {
      if (
        canStart(task) &&
        (task.dependsOn ?? []).some((id) => ['failed', 'cancelled', 'interrupted'].includes(statuses.get(id) ?? ''))
      ) {
        setStatus(task, 'failed', 'dependency failed');
        continue;
      }
      if (canStart(task) && depsDone(task) && running < (options.maxConcurrent ?? Number.POSITIVE_INFINITY)) {
        const promise = runTask(task).finally(() => {
          pending.delete(promise);
          pump();
        });
        pending.add(promise);
      }
    }
  };
  const registerAgent = (agent: AgentMeshAgent) => {
    agents.set(agent.agentId, { ...agent, grants: agent.grants ?? [] });
    progressAt.set(agent.agentId, now());
  };
  const submitTask = (task: AgentMeshTask, executor: AgentTaskExecutor) => {
    if (!agents.has(task.agentId)) throw new Error('Unknown agent: ' + task.agentId);
    if (tasks.has(task.taskId)) throw new Error('Duplicate task: ' + task.taskId);
    tasks.set(task.taskId, task);
    executors.set(task.taskId, executor);
    statuses.set(task.taskId, 'queued');
    emit({ type: 'task-status', task, status: 'queued' });
    pump();
    return task.taskId;
  };
  const sendMessage = (input: Omit<AgentMessage, 'messageId' | 'status' | 'sequence' | 'createdAt'>) => {
    const message: AgentMessage = {
      ...input,
      messageId: makeId('message'),
      status: 'queued',
      sequence: ++sequence,
      createdAt: now(),
    };
    if (!hasGrant(message)) throw new Error('Permission denied: ' + message.fromAgentId + ' -> ' + message.toAgentId);
    const queue = [...getQueue(message.toAgentId)];
    for (const [taskId, task] of tasks)
      if (task.agentId === message.toAgentId && controllers.has(taskId)) {
        if (message.deliveryMode === 'interrupt' || message.deliveryMode === 'cancel-and-replace') {
          controls.get(taskId)!.cancelled = message.deliveryMode === 'cancel-and-replace';
          controllers.get(taskId)!.abort();
        }
        if (message.deliveryMode === 'graceful-interrupt') controls.get(taskId)!.graceful = true;
      }
    const delivered = message.deliveryMode === 'interrupt' || message.deliveryMode === 'cancel-and-replace';
    const next = {
      ...message,
      status: delivered ? ('delivered' as const) : ('queued' as const),
      deliveredAt: delivered ? now() : undefined,
    };
    replaceQueue(
      message.toAgentId,
      message.deliveryMode === 'queue' || message.deliveryMode === 'graceful-interrupt'
        ? [...queue, next]
        : [next, ...queue]
    );
    emit({ type: 'message', message: next });
    return next;
  };
  const updateQueue = (
    agentId: AgentId,
    messageId: MessageId,
    patch: Partial<Pick<AgentMessage, 'content' | 'deliveryMode'>>
  ) => {
    const updated = getQueue(agentId).map((message) =>
      message.messageId === messageId ? { ...message, ...patch } : message
    );
    replaceQueue(agentId, updated);
    return updated.find((message) => message.messageId === messageId);
  };
  const removeMessage = (agentId: AgentId, messageId: MessageId) => {
    const message = getQueue(agentId).find((item) => item.messageId === messageId);
    replaceQueue(
      agentId,
      getQueue(agentId).filter((item) => item.messageId !== messageId)
    );
    return message ? { ...message, status: 'removed' as const } : undefined;
  };
  const reorderMessage = (agentId: AgentId, messageId: MessageId, beforeMessageId?: MessageId) => {
    const queue = [...getQueue(agentId)];
    const index = queue.findIndex((item) => item.messageId === messageId);
    if (index < 0) return queue;
    const [message] = queue.splice(index, 1);
    const target = beforeMessageId ? queue.findIndex((item) => item.messageId === beforeMessageId) : queue.length;
    queue.splice(target < 0 ? queue.length : target, 0, message);
    replaceQueue(agentId, queue);
    return queue;
  };
  const stopTask = (taskId: TaskId, mode: 'graceful' | 'interrupt' | 'cancel') => {
    const control = controls.get(taskId);
    const controller = controllers.get(taskId);
    if (!control || !controller) {
      if (statuses.get(taskId) === 'queued') statuses.set(taskId, mode === 'cancel' ? 'cancelled' : 'interrupted');
      return;
    }
    if (mode === 'graceful') control.graceful = true;
    else {
      control.cancelled = mode === 'cancel';
      controller.abort();
    }
  };
  const inspect = (agentId: AgentId): AgentInspection => {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('Unknown agent: ' + agentId);
    const active = [...tasks.values()].find(
      (item) =>
        item.agentId === agentId &&
        !['completed', 'failed', 'cancelled', 'interrupted'].includes(statuses.get(item.taskId) ?? '')
    );
    const task =
      active ??
      Array.from(tasks.values())
        .toReversed()
        .find((item) => item.agentId === agentId);
    const lastProgressAt = progressAt.get(agentId);
    const idleMs = lastProgressAt === undefined ? 0 : Math.max(0, now() - lastProgressAt);
    const stuck = Boolean(active && options.watchdogMs !== undefined && idleMs >= options.watchdogMs);
    if (options.watchdogMs !== undefined) emit({ type: 'watchdog', agentId, taskId: active?.taskId, stuck, idleMs });
    return {
      agent,
      task,
      status: task ? statuses.get(task.taskId)! : 'idle',
      currentAction: active ? actions.get(task.taskId)?.find((action) => action.status === 'started') : undefined,
      actionHistory: task ? [...(actions.get(task.taskId) ?? [])] : [],
      queue: [...getQueue(agentId)],
      lastProgressAt,
      stuck,
    };
  };
  const waitForIdle = async (): Promise<void> => {
    await Promise.all(pending);
    pump();
    if (pending.size > 0 || [...tasks.values()].some((task) => canStart(task))) await waitForIdle();
  };
  return {
    registerAgent,
    submitTask,
    sendMessage,
    updateQueue,
    removeMessage,
    reorderMessage,
    stopTask,
    inspect,
    waitForIdle,
    getStatus: (taskId: TaskId) => statuses.get(taskId),
    getQueue: (agentId: AgentId) => [...getQueue(agentId)],
    getTokenUsage: () => ({ spentTokens, reservedTokens, budget: options.totalTokenBudget }),
  };
}
