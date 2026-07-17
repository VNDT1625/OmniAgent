export type SurfaceTargetKind = 'builtin' | 'acp' | 'cli' | 'remote';
export type SurfacePermissionMode = 'read-only' | 'workspace-write' | 'full-access';
export type SurfaceContextSlice = 'agent' | 'personal' | 'workspace' | 'conversation' | 'surface';
export type SurfaceCapabilityKind = 'mcp' | 'native' | 'skill' | 'bridge';

export type SurfaceCompatibilityPolicy = {
  targetKinds?: SurfaceTargetKind[];
  protocols?: string[];
  modelIds?: string[];
  providerIds?: string[];
  requiredModelCapabilities?: string[];
};

export type SurfaceModelDescriptor = {
  targetKind: SurfaceTargetKind;
  protocol: string;
  modelId?: string;
  providerId?: string;
  capabilities?: string[];
};

export type SurfaceCapabilityBinding = {
  id: string;
  label: string;
  kind: SurfaceCapabilityKind;
  providerId?: string;
  serverName?: string;
  toolPatterns: string[];
  optional?: boolean;
  priority?: number;
  minimumPermissionMode: SurfacePermissionMode;
  requiredPermissionScopes?: string[];
  requireExplicitGrant?: boolean;
  compatibility?: SurfaceCompatibilityPolicy;
};

export type SurfaceContextPolicy = {
  required: SurfaceContextSlice[];
  includeOpaqueSecretHandles: boolean;
  allowedSecretCapabilities?: string[];
  maxCharacters?: number;
};

export type SurfacePermissionPolicy = {
  minimumMode: SurfacePermissionMode;
  allowedModes: SurfacePermissionMode[];
  requiredScopes?: string[];
  requireExplicitGrant: boolean;
};

export type SurfaceManifestSource = {
  kind: 'builtin' | 'plugin' | 'user';
  id?: string;
  version?: string;
};

export type SurfaceManifest = {
  schemaVersion: 1;
  id: string;
  label: string;
  description: string;
  source: SurfaceManifestSource;
  priority?: number;
  compatibility?: SurfaceCompatibilityPolicy;
  context: SurfaceContextPolicy;
  permissions: SurfacePermissionPolicy;
  capabilities: SurfaceCapabilityBinding[];
  fallbackSurfaceIds?: string[];
};

export type SurfaceResolutionRequest = {
  surfaceId?: string;
  model: SurfaceModelDescriptor;
  permissionMode: SurfacePermissionMode;
  grantedPermissionScopes?: string[];
  explicitlyGrantedCapabilityIds?: string[];
  availableCapabilityIds?: string[];
  requiredCapabilityIds?: string[];
};

export type SurfaceResolutionIssueCode =
  | 'unknown-surface'
  | 'fallback-cycle'
  | 'incompatible-target'
  | 'incompatible-protocol'
  | 'incompatible-model'
  | 'incompatible-provider'
  | 'missing-model-capability'
  | 'permission-mode-denied'
  | 'missing-permission-scope'
  | 'missing-capability'
  | 'capability-grant-required';

export type SurfaceResolutionIssue = {
  code: SurfaceResolutionIssueCode;
  message: string;
  capabilityId?: string;
};

export type ResolvedSurface = {
  manifest: SurfaceManifest;
  capabilities: SurfaceCapabilityBinding[];
  omittedOptionalCapabilities: Array<{ capabilityId: string; issues: SurfaceResolutionIssue[] }>;
  fallbackTrail: string[];
};

export type SurfaceResolution =
  | { ok: true; value: ResolvedSurface }
  | { ok: false; requestedSurfaceId: string; fallbackTrail: string[]; issues: SurfaceResolutionIssue[] };

export type SurfaceDiscoveryResult = {
  manifest: SurfaceManifest;
  compatible: boolean;
  issues: SurfaceResolutionIssue[];
  capabilities: SurfaceCapabilityBinding[];
};

export type SurfaceRegistry = {
  register(manifest: SurfaceManifest, options?: { replace?: boolean }): void;
  unregister(surfaceId: string): boolean;
  get(surfaceId: string): SurfaceManifest | undefined;
  list(): SurfaceManifest[];
  discover(request: Omit<SurfaceResolutionRequest, 'surfaceId'>): SurfaceDiscoveryResult[];
  resolve(request: SurfaceResolutionRequest): SurfaceResolution;
};
