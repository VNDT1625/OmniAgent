/** Transport-neutral durable event contracts for Tomny Core conversations. */

export type DurableEventVisibility = 'public' | 'private' | 'secret';

export type DurableEventKind =
  | 'session.created'
  | 'session.updated'
  | 'run.started'
  | 'run.status'
  | 'run.thinking'
  | 'run.step'
  | 'run.delta'
  | 'run.completed'
  | 'run.error'
  | 'run.cancelled'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.error'
  | 'permission.requested'
  | 'permission.resolved'
  | 'message.queued'
  | 'message.updated'
  | 'message.removed'
  | 'message.reordered'
  | 'agent.spawned'
  | 'agent.message'
  | 'agent.stopped'
  | 'custom';

export type DurableEventPayload =
  | null
  | boolean
  | number
  | string
  | DurableEventPayload[]
  | { [key: string]: DurableEventPayload };

export type DurableAgentEvent = {
  id: string;
  sessionId: string;
  requestId?: string;
  sequence: number;
  timestamp: number;
  kind: DurableEventKind;
  visibility: DurableEventVisibility;
  payload: DurableEventPayload;
  previousHash: string;
  hash: string;
};

export type AppendDurableEventInput = Omit<
  DurableAgentEvent,
  'id' | 'sequence' | 'timestamp' | 'previousHash' | 'hash'
> & {
  id?: string;
  timestamp?: number;
};

export type DurableEventQuery = {
  sessionId?: string;
  requestId?: string;
  afterSequence?: number;
  kinds?: DurableEventKind[];
  limit?: number;
};

export type DurableEventStore = {
  initialize: () => Promise<void>;
  append: (input: AppendDurableEventInput) => Promise<DurableAgentEvent>;
  query: (query?: DurableEventQuery) => Promise<DurableAgentEvent[]>;
  latestSequence: () => Promise<number>;
  replaceAll: (events: DurableAgentEvent[]) => Promise<void>;
};

export type DurableEventIntegrityIssue = {
  line: number;
  reason: 'invalid-json' | 'invalid-record' | 'broken-chain' | 'invalid-hash';
};
