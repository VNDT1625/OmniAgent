/** Durable, transport-neutral permission contracts for Tomny Core. */

export type PermissionGrantLifetime = 'allow-once' | 'session' | 'persistent';
export type PermissionGrantEffect = 'allow' | 'deny';

export type PermissionScope = {
  subjectId: string;
  sessionId: string | '*';
  surfaceId: string;
  capabilityId: string;
  toolPattern: string;
};

export type PermissionGrant = {
  id: string;
  scope: PermissionScope;
  effect: PermissionGrantEffect;
  lifetime: PermissionGrantLifetime;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  remainingUses?: number;
};

export type CreatePermissionGrantInput = {
  id?: string;
  scope: PermissionScope;
  effect: PermissionGrantEffect;
  lifetime: PermissionGrantLifetime;
  expiresAt?: number;
};

export type PermissionRequest = {
  subjectId: string;
  sessionId: string;
  surfaceId: string;
  capabilityId: string;
  tool: string;
};

export type PermissionDecisionReason =
  | 'explicit-allow'
  | 'explicit-deny'
  | 'no-matching-grant'
  | 'expired'
  | 'revoked'
  | 'consumed';

export type PermissionDecision = {
  allowed: boolean;
  reason: PermissionDecisionReason;
  grantId?: string;
};

export type PermissionAuditAction = 'grant.created' | 'grant.revoked' | 'request.evaluated';

/** Audit records intentionally exclude prompts, commands, credentials and arbitrary metadata. */
export type PermissionAuditRecord = {
  id: string;
  timestamp: number;
  action: PermissionAuditAction;
  subjectId: string;
  sessionId: string;
  surfaceId: string;
  capabilityId: string;
  tool: string;
  grantId?: string;
  effect?: PermissionGrantEffect;
  lifetime?: PermissionGrantLifetime;
  allowed?: boolean;
  reason?: PermissionDecisionReason;
};

export type PermissionAuditQuery = {
  subjectId?: string;
  sessionId?: string;
  surfaceId?: string;
  capabilityId?: string;
  actions?: PermissionAuditAction[];
  after?: number;
  limit?: number;
};

export type PermissionStoreState = {
  version: 1;
  grants: PermissionGrant[];
  audit: PermissionAuditRecord[];
};

export type PermissionStateRepository = {
  load(): Promise<PermissionStoreState>;
  save(state: PermissionStoreState): Promise<void>;
};

export type DurablePermissionStore = {
  initialize(): Promise<void>;
  createGrant(input: CreatePermissionGrantInput): Promise<PermissionGrant>;
  authorize(request: PermissionRequest): Promise<PermissionDecision>;
  revoke(grantId: string): Promise<boolean>;
  listGrants(options?: { includeInactive?: boolean }): Promise<PermissionGrant[]>;
  queryAudit(query?: PermissionAuditQuery): Promise<PermissionAuditRecord[]>;
};
