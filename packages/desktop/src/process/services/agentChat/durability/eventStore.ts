import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  AppendDurableEventInput,
  DurableAgentEvent,
  DurableEventIntegrityIssue,
  DurableEventPayload,
  DurableEventQuery,
  DurableEventStore,
} from './types';

const GENESIS_HASH = '0'.repeat(64);
const MAX_QUERY_LIMIT = 10_000;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key)/i;
const SENSITIVE_TEXT: ReadonlyArray<RegExp> = [
  /\b(?:sk|rk|pk)-[a-z0-9_-]{12,}\b/gi,
  /\bBearer\s+[a-z0-9._~+/-]+=*\b/gi,
  /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
];

const clone = <T>(value: T): T => structuredClone(value);

const redactText = (value: string): string =>
  SENSITIVE_TEXT.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);

const sanitizePayload = (payload: DurableEventPayload, secret: boolean): DurableEventPayload => {
  if (secret) return { redacted: true };
  if (typeof payload === 'string') return redactText(payload);
  if (Array.isArray(payload)) return payload.map((item) => sanitizePayload(item, false));
  if (payload && typeof payload === 'object') {
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizePayload(value, false),
      ])
    );
  }
  return payload;
};

const hashInput = (event: Omit<DurableAgentEvent, 'hash'>): string =>
  JSON.stringify({
    id: event.id,
    sessionId: event.sessionId,
    requestId: event.requestId ?? null,
    sequence: event.sequence,
    timestamp: event.timestamp,
    kind: event.kind,
    visibility: event.visibility,
    payload: event.payload,
    previousHash: event.previousHash,
  });

const eventHash = (event: Omit<DurableAgentEvent, 'hash'>): string =>
  createHash('sha256').update(hashInput(event)).digest('hex');

export const validateDurableEventChain = (events: DurableAgentEvent[]): void => {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isEvent(event) || event.sequence !== index + 1 || event.previousHash !== previousHash) {
      throw new Error('Durable event bundle contains a broken chain.');
    }
    const { hash, ...base } = event;
    if (eventHash(base) !== hash) throw new Error('Durable event bundle contains an invalid hash.');
    previousHash = hash;
  }
};

const isPayload = (value: unknown): value is DurableEventPayload => {
  if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isPayload);
  return Boolean(value) && typeof value === 'object' && Object.values(value).every(isPayload);
};

const isEvent = (value: unknown): value is DurableAgentEvent => {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<DurableAgentEvent>;
  return (
    typeof event.id === 'string' &&
    typeof event.sessionId === 'string' &&
    (event.requestId === undefined || typeof event.requestId === 'string') &&
    Number.isSafeInteger(event.sequence) &&
    Number.isFinite(event.timestamp) &&
    typeof event.kind === 'string' &&
    ['public', 'private', 'secret'].includes(event.visibility ?? '') &&
    isPayload(event.payload) &&
    typeof event.previousHash === 'string' &&
    typeof event.hash === 'string'
  );
};

const normalizeLimit = (limit?: number): number => {
  if (limit === undefined) return MAX_QUERY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('Durable event query limit must be a positive integer.');
  return Math.min(limit, MAX_QUERY_LIMIT);
};

const matches = (event: DurableAgentEvent, query: DurableEventQuery): boolean =>
  (query.sessionId === undefined || event.sessionId === query.sessionId) &&
  (query.requestId === undefined || event.requestId === query.requestId) &&
  (query.afterSequence === undefined || event.sequence > query.afterSequence) &&
  (query.kinds === undefined || query.kinds.includes(event.kind));

/** In-memory journal used by tests and ephemeral runtimes. */
export class MemoryDurableEventStore implements DurableEventStore {
  protected readonly events: DurableAgentEvent[] = [];
  protected appendQueue: Promise<void> = Promise.resolve();

  public async initialize(): Promise<void> {}

  public async append(input: AppendDurableEventInput): Promise<DurableAgentEvent> {
    let appended: DurableAgentEvent | undefined;
    const operation = this.appendQueue.then(async () => {
      appended = this.createEvent(input);
      await this.persist(appended);
      this.events.push(appended);
    });
    this.appendQueue = operation.catch((): void => undefined);
    await operation;
    if (!appended) throw new Error('Durable event append did not produce an event.');
    return clone(appended);
  }

  public async query(query: DurableEventQuery = {}): Promise<DurableAgentEvent[]> {
    await this.appendQueue;
    const limit = normalizeLimit(query.limit);
    return this.events
      .filter((event) => matches(event, query))
      .slice(0, limit)
      .map(clone);
  }

  public async latestSequence(): Promise<number> {
    await this.appendQueue;
    return this.events.at(-1)?.sequence ?? 0;
  }

  public async replaceAll(events: DurableAgentEvent[]): Promise<void> {
    await this.appendQueue;
    validateDurableEventChain(events);
    const replacement = events.map(clone);
    await this.persistReplacement(replacement);
    this.events.splice(0, this.events.length, ...replacement);
  }

  protected createEvent(input: AppendDurableEventInput): DurableAgentEvent {
    if (!input.sessionId.trim()) throw new Error('Durable event sessionId is required.');
    const base: Omit<DurableAgentEvent, 'hash'> = {
      id: input.id?.trim() || randomUUID(),
      sessionId: input.sessionId,
      requestId: input.requestId,
      sequence: (this.events.at(-1)?.sequence ?? 0) + 1,
      timestamp: input.timestamp ?? Date.now(),
      kind: input.kind,
      visibility: input.visibility,
      payload: sanitizePayload(input.payload, input.visibility === 'secret'),
      previousHash: this.events.at(-1)?.hash ?? GENESIS_HASH,
    };
    return { ...base, hash: eventHash(base) };
  }

  protected async persist(_event: DurableAgentEvent): Promise<void> {}

  protected async persistReplacement(_events: DurableAgentEvent[]): Promise<void> {}
}

/** Append-only JSONL journal with hash-chain integrity checks and crash-tail recovery. */
export class JsonlDurableEventStore extends MemoryDurableEventStore {
  private readonly issues: DurableEventIntegrityIssue[] = [];
  private initialized = false;

  public constructor(private readonly filePath: string) {
    super();
  }

  public override async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    let previousHash = GENESIS_HASH;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.issues.push({ line: index + 1, reason: 'invalid-json' });
        break;
      }
      if (!isEvent(parsed)) {
        this.issues.push({ line: index + 1, reason: 'invalid-record' });
        break;
      }
      if (parsed.previousHash !== previousHash || parsed.sequence !== this.events.length + 1) {
        this.issues.push({ line: index + 1, reason: 'broken-chain' });
        break;
      }
      const { hash, ...base } = parsed;
      if (eventHash(base) !== hash) {
        this.issues.push({ line: index + 1, reason: 'invalid-hash' });
        break;
      }
      this.events.push(clone(parsed));
      previousHash = parsed.hash;
    }
  }

  public getIntegrityIssues(): DurableEventIntegrityIssue[] {
    return this.issues.map(clone);
  }

  protected override async persist(event: DurableAgentEvent): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flush: true });
  }

  protected override async persistReplacement(events: DurableAgentEvent[]): Promise<void> {
    const temporaryPath = `${this.filePath}.${process.pid}.cutover.tmp`;
    const content = events.map((event) => JSON.stringify(event)).join('\n');
    await writeFile(temporaryPath, content ? `${content}\n` : '', { encoding: 'utf8', mode: 0o600, flush: true });
    await rename(temporaryPath, this.filePath);
  }
}
