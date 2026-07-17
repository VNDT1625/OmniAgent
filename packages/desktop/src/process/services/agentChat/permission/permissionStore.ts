import { randomUUID } from 'node:crypto';

import type {
  CreatePermissionGrantInput,
  DurablePermissionStore,
  PermissionAuditQuery,
  PermissionAuditRecord,
  PermissionDecision,
  PermissionGrant,
  PermissionRequest,
  PermissionScope,
  PermissionStateRepository,
  PermissionStoreState,
} from './types';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/;
const SAFE_TOOL_PATTERN = /^(?:\*|[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}\*?)$/;
const SECRET_SHAPED_IDENTIFIER = /^(?:sk|rk|pk)-[a-zA-Z0-9_-]{12,}$/i;
const DEFAULT_MAX_AUDIT = 5_000;
const DEFAULT_QUERY_LIMIT = 1_000;

const clone = <T>(value: T): T => structuredClone(value);
const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const assertId = (label: string, value: string): void => {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || SECRET_SHAPED_IDENTIFIER.test(value)) {
    throw new Error(`${label} must be a safe, non-secret identifier.`);
  }
};

const validateScope = (scope: PermissionScope, lifetime: CreatePermissionGrantInput['lifetime']): void => {
  assertId('Permission subjectId', scope.subjectId);
  if (scope.sessionId !== '*') assertId('Permission sessionId', scope.sessionId);
  if (lifetime !== 'persistent' && scope.sessionId === '*') {
    throw new Error('Only persistent grants may span sessions.');
  }
  assertId('Permission surfaceId', scope.surfaceId);
  assertId('Permission capabilityId', scope.capabilityId);
  if (typeof scope.toolPattern !== 'string' || !SAFE_TOOL_PATTERN.test(scope.toolPattern)) {
    throw new Error('Permission toolPattern is invalid.');
  }
};

const validateRequest = (request: PermissionRequest): void => {
  assertId('Permission subjectId', request.subjectId);
  assertId('Permission sessionId', request.sessionId);
  assertId('Permission surfaceId', request.surfaceId);
  assertId('Permission capabilityId', request.capabilityId);
  assertId('Permission tool', request.tool);
};

const toolMatches = (pattern: string, tool: string): boolean =>
  pattern === '*' || (pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : pattern === tool);

const scopeMatches = (grant: PermissionGrant, request: PermissionRequest): boolean =>
  grant.scope.subjectId === request.subjectId &&
  (grant.scope.sessionId === '*' || grant.scope.sessionId === request.sessionId) &&
  grant.scope.surfaceId === request.surfaceId &&
  grant.scope.capabilityId === request.capabilityId &&
  toolMatches(grant.scope.toolPattern, request.tool);

const activeReason = (grant: PermissionGrant, timestamp: number): 'expired' | 'revoked' | 'consumed' | null => {
  if (grant.revokedAt !== undefined) return 'revoked';
  if (grant.expiresAt !== undefined && grant.expiresAt <= timestamp) return 'expired';
  if (grant.remainingUses !== undefined && grant.remainingUses < 1) return 'consumed';
  return null;
};

const specificity = (grant: PermissionGrant): number =>
  (grant.scope.sessionId === '*' ? 0 : 4) +
  (grant.scope.toolPattern === '*' ? 0 : grant.scope.toolPattern.endsWith('*') ? 1 : 2);

const auditMatches = (record: PermissionAuditRecord, query: PermissionAuditQuery): boolean =>
  (query.subjectId === undefined || record.subjectId === query.subjectId) &&
  (query.sessionId === undefined || record.sessionId === query.sessionId) &&
  (query.surfaceId === undefined || record.surfaceId === query.surfaceId) &&
  (query.capabilityId === undefined || record.capabilityId === query.capabilityId) &&
  (query.actions === undefined || query.actions.includes(record.action)) &&
  (query.after === undefined || record.timestamp > query.after);

export type PermissionStoreOptions = {
  now?: () => number;
  createId?: () => string;
  maxAuditRecords?: number;
};

/** Serialized policy engine: every authorization and allow-once consumption is committed atomically. */
export class PermissionStore implements DurablePermissionStore {
  private state: PermissionStoreState = { version: 1, grants: [], audit: [] };
  private initialized = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxAuditRecords: number;

  public constructor(
    private readonly repository: PermissionStateRepository,
    options: PermissionStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.maxAuditRecords = options.maxAuditRecords ?? DEFAULT_MAX_AUDIT;
    if (!Number.isSafeInteger(this.maxAuditRecords) || this.maxAuditRecords < 1) {
      throw new Error('maxAuditRecords must be a positive integer.');
    }
  }

  public async initialize(): Promise<void> {
    await this.serial(async () => {
      if (this.initialized) return;
      this.state = await this.repository.load();
      this.validateLoadedState();
      this.initialized = true;
    });
  }

  public async createGrant(input: CreatePermissionGrantInput): Promise<PermissionGrant> {
    return this.serial(async () => {
      this.requireInitialized();
      validateScope(input.scope, input.lifetime);
      const timestamp = this.now();
      if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= timestamp)) {
        throw new Error('Permission grant expiry must be in the future.');
      }
      const grant: PermissionGrant = {
        id: input.id ?? this.createId(),
        scope: clone(input.scope),
        effect: input.effect,
        lifetime: input.lifetime,
        createdAt: timestamp,
        expiresAt: input.expiresAt,
        remainingUses: input.lifetime === 'allow-once' ? 1 : undefined,
      };
      assertId('Permission grant id', grant.id);
      if (this.state.grants.some((item) => item.id === grant.id))
        throw new Error('Permission grant id already exists.');
      this.state.grants.push(grant);
      this.addAudit({
        action: 'grant.created',
        timestamp,
        ...this.auditScope(grant.scope),
        grantId: grant.id,
        effect: grant.effect,
        lifetime: grant.lifetime,
      });
      await this.persist();
      return clone(grant);
    });
  }

  public async authorize(request: PermissionRequest): Promise<PermissionDecision> {
    return this.serial(async () => {
      this.requireInitialized();
      validateRequest(request);
      const timestamp = this.now();
      const scoped = this.state.grants.filter((grant) => scopeMatches(grant, request));
      const active = scoped.filter((grant) => activeReason(grant, timestamp) === null);
      const ranked = active.toSorted(
        (left, right) =>
          Number(right.effect === 'deny') - Number(left.effect === 'deny') ||
          specificity(right) - specificity(left) ||
          right.createdAt - left.createdAt
      );
      const matched = ranked[0];
      const inactiveReason = scoped.map((grant) => activeReason(grant, timestamp)).find((reason) => reason !== null);
      const decision: PermissionDecision = matched
        ? {
            allowed: matched.effect === 'allow',
            reason: matched.effect === 'allow' ? 'explicit-allow' : 'explicit-deny',
            grantId: matched.id,
          }
        : { allowed: false, reason: inactiveReason ?? 'no-matching-grant' };

      if (matched?.remainingUses !== undefined) matched.remainingUses -= 1;
      this.addAudit({
        action: 'request.evaluated',
        timestamp,
        ...request,
        grantId: decision.grantId,
        allowed: decision.allowed,
        reason: decision.reason,
      });
      await this.persist();
      return decision;
    });
  }

  public async revoke(grantId: string): Promise<boolean> {
    return this.serial(async () => {
      this.requireInitialized();
      assertId('Permission grant id', grantId);
      const grant = this.state.grants.find((item) => item.id === grantId);
      if (!grant || grant.revokedAt !== undefined) return false;
      grant.revokedAt = this.now();
      this.addAudit({
        action: 'grant.revoked',
        timestamp: grant.revokedAt,
        ...this.auditScope(grant.scope),
        grantId,
        effect: grant.effect,
        lifetime: grant.lifetime,
      });
      await this.persist();
      return true;
    });
  }

  public async listGrants(options: { includeInactive?: boolean } = {}): Promise<PermissionGrant[]> {
    return this.serial(async () => {
      this.requireInitialized();
      const timestamp = this.now();
      return this.state.grants
        .filter((grant) => options.includeInactive || activeReason(grant, timestamp) === null)
        .map(clone);
    });
  }

  public async queryAudit(query: PermissionAuditQuery = {}): Promise<PermissionAuditRecord[]> {
    return this.serial(async () => {
      this.requireInitialized();
      const limit = query.limit ?? DEFAULT_QUERY_LIMIT;
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Permission audit limit must be positive.');
      return this.state.audit
        .filter((record) => auditMatches(record, query))
        .slice(-limit)
        .map(clone);
    });
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    let result: T | undefined;
    let failure: unknown;
    const run = this.queue.then(async () => {
      const previousState = clone(this.state);
      const wasInitialized = this.initialized;
      try {
        result = await operation();
      } catch (error) {
        this.state = previousState;
        this.initialized = wasInitialized;
        failure = error;
      }
    });
    this.queue = run;
    await run;
    if (failure !== undefined) throw failure;
    return result as T;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error('PermissionStore must be initialized before use.');
  }

  private auditScope(
    scope: PermissionScope
  ): Pick<PermissionAuditRecord, 'subjectId' | 'sessionId' | 'surfaceId' | 'capabilityId' | 'tool'> {
    return {
      subjectId: scope.subjectId,
      sessionId: scope.sessionId,
      surfaceId: scope.surfaceId,
      capabilityId: scope.capabilityId,
      tool: scope.toolPattern,
    };
  }

  private addAudit(record: Omit<PermissionAuditRecord, 'id'>): void {
    this.state.audit.push({ id: this.createId(), ...record });
    if (this.state.audit.length > this.maxAuditRecords) {
      this.state.audit.splice(0, this.state.audit.length - this.maxAuditRecords);
    }
  }

  private async persist(): Promise<void> {
    await this.repository.save(this.state);
  }

  private validateLoadedState(): void {
    const grantIds = new Set<string>();
    for (const grant of this.state.grants) {
      assertId('Permission grant id', grant.id);
      validateScope(grant.scope, grant.lifetime);
      if (
        grantIds.has(grant.id) ||
        !['allow', 'deny'].includes(grant.effect) ||
        !['allow-once', 'session', 'persistent'].includes(grant.lifetime) ||
        !isTimestamp(grant.createdAt) ||
        (grant.expiresAt !== undefined && !isTimestamp(grant.expiresAt)) ||
        (grant.revokedAt !== undefined && !isTimestamp(grant.revokedAt)) ||
        (grant.lifetime === 'allow-once' && ![0, 1].includes(grant.remainingUses ?? -1)) ||
        (grant.lifetime !== 'allow-once' && grant.remainingUses !== undefined)
      ) {
        throw new Error('Permission store contains an invalid grant.');
      }
      grantIds.add(grant.id);
    }
    for (const record of this.state.audit) {
      assertId('Permission audit id', record.id);
      assertId('Permission audit subjectId', record.subjectId);
      if (record.sessionId !== '*') assertId('Permission audit sessionId', record.sessionId);
      assertId('Permission audit surfaceId', record.surfaceId);
      assertId('Permission audit capabilityId', record.capabilityId);
      if (
        !isTimestamp(record.timestamp) ||
        !['grant.created', 'grant.revoked', 'request.evaluated'].includes(record.action) ||
        typeof record.tool !== 'string' ||
        !SAFE_TOOL_PATTERN.test(record.tool)
      ) {
        throw new Error('Permission store contains an invalid audit record.');
      }
    }
  }
}
