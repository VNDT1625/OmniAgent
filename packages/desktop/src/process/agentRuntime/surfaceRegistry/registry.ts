import { assertSurfaceManifest } from './validation';
import type {
  SurfaceCapabilityBinding,
  SurfaceCompatibilityPolicy,
  SurfaceDiscoveryResult,
  SurfaceManifest,
  SurfaceModelDescriptor,
  SurfacePermissionMode,
  SurfaceRegistry,
  SurfaceResolution,
  SurfaceResolutionIssue,
  SurfaceResolutionRequest,
} from './types';

const PERMISSION_RANK: Record<SurfacePermissionMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'full-access': 2,
};

const clone = <T>(value: T): T => structuredClone(value);
const matchesPattern = (value: string | undefined, patterns: string[] | undefined): boolean => {
  if (!patterns) return true;
  if (!value) return false;
  return patterns.some((pattern) => {
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${expression}$`, 'i').test(value);
  });
};

const compatibilityIssues = (
  policy: SurfaceCompatibilityPolicy | undefined,
  model: SurfaceModelDescriptor,
  capabilityId?: string
): SurfaceResolutionIssue[] => {
  if (!policy) return [];
  const issues: SurfaceResolutionIssue[] = [];
  if (policy.targetKinds && !policy.targetKinds.includes(model.targetKind)) {
    issues.push({ code: 'incompatible-target', message: `Target ${model.targetKind} is not supported.`, capabilityId });
  }
  if (policy.protocols && !matchesPattern(model.protocol, policy.protocols)) {
    issues.push({
      code: 'incompatible-protocol',
      message: `Protocol ${model.protocol} is not supported.`,
      capabilityId,
    });
  }
  if (policy.modelIds && !matchesPattern(model.modelId, policy.modelIds)) {
    issues.push({
      code: 'incompatible-model',
      message: `Model ${model.modelId ?? '(unspecified)'} is not supported.`,
      capabilityId,
    });
  }
  if (policy.providerIds && !matchesPattern(model.providerId, policy.providerIds)) {
    issues.push({
      code: 'incompatible-provider',
      message: `Provider ${model.providerId ?? '(unspecified)'} is not supported.`,
      capabilityId,
    });
  }
  const modelCapabilities = new Set(model.capabilities ?? []);
  for (const required of policy.requiredModelCapabilities ?? []) {
    if (!modelCapabilities.has(required)) {
      issues.push({
        code: 'missing-model-capability',
        message: `Model capability ${required} is required.`,
        capabilityId,
      });
    }
  }
  return issues;
};

const missingScopes = (required: string[] | undefined, granted: Set<string>): string[] =>
  (required ?? []).filter((scope) => !granted.has(scope));

const assessCapability = (
  binding: SurfaceCapabilityBinding,
  manifest: SurfaceManifest,
  request: Omit<SurfaceResolutionRequest, 'surfaceId'>
): SurfaceResolutionIssue[] => {
  const issues = compatibilityIssues(binding.compatibility, request.model, binding.id);
  if (PERMISSION_RANK[request.permissionMode] < PERMISSION_RANK[binding.minimumPermissionMode]) {
    issues.push({
      code: 'permission-mode-denied',
      message: `${binding.id} requires ${binding.minimumPermissionMode}.`,
      capabilityId: binding.id,
    });
  }
  const absentScopes = missingScopes(binding.requiredPermissionScopes, new Set(request.grantedPermissionScopes ?? []));
  if (absentScopes.length > 0) {
    issues.push({
      code: 'missing-permission-scope',
      message: `${binding.id} requires scopes: ${absentScopes.join(', ')}.`,
      capabilityId: binding.id,
    });
  }
  if (request.availableCapabilityIds && !request.availableCapabilityIds.includes(binding.id)) {
    issues.push({ code: 'missing-capability', message: `${binding.id} is not available.`, capabilityId: binding.id });
  }
  const explicitGrant = binding.requireExplicitGrant ?? manifest.permissions.requireExplicitGrant;
  if (explicitGrant && !request.explicitlyGrantedCapabilityIds?.includes(binding.id)) {
    issues.push({
      code: 'capability-grant-required',
      message: `${binding.id} requires an explicit user grant.`,
      capabilityId: binding.id,
    });
  }
  return issues;
};

const assessManifest = (
  manifest: SurfaceManifest,
  request: Omit<SurfaceResolutionRequest, 'surfaceId'>
): SurfaceDiscoveryResult & { omitted: Array<{ capabilityId: string; issues: SurfaceResolutionIssue[] }> } => {
  const issues = compatibilityIssues(manifest.compatibility, request.model);
  if (
    !manifest.permissions.allowedModes.includes(request.permissionMode) ||
    PERMISSION_RANK[request.permissionMode] < PERMISSION_RANK[manifest.permissions.minimumMode]
  ) {
    issues.push({
      code: 'permission-mode-denied',
      message: `${manifest.id} does not allow permission mode ${request.permissionMode}.`,
    });
  }
  const absentScopes = missingScopes(
    manifest.permissions.requiredScopes,
    new Set(request.grantedPermissionScopes ?? [])
  );
  if (absentScopes.length > 0) {
    issues.push({
      code: 'missing-permission-scope',
      message: `${manifest.id} requires scopes: ${absentScopes.join(', ')}.`,
    });
  }

  const active: SurfaceCapabilityBinding[] = [];
  const omitted: Array<{ capabilityId: string; issues: SurfaceResolutionIssue[] }> = [];
  for (const binding of manifest.capabilities.toSorted((left, right) => (right.priority ?? 0) - (left.priority ?? 0))) {
    const bindingIssues = assessCapability(binding, manifest, request);
    if (bindingIssues.length === 0) active.push(binding);
    else if (binding.optional) omitted.push({ capabilityId: binding.id, issues: bindingIssues });
    else issues.push(...bindingIssues);
  }

  const declared = new Set(manifest.capabilities.map((binding) => binding.id));
  const enabled = new Set(active.map((binding) => binding.id));
  for (const required of request.requiredCapabilityIds ?? []) {
    if (!declared.has(required) || !enabled.has(required)) {
      issues.push({
        code: 'missing-capability',
        message: `Required capability ${required} is unavailable.`,
        capabilityId: required,
      });
    }
  }
  return { manifest, compatible: issues.length === 0, issues, capabilities: active, omitted };
};

export type SurfaceRegistryOptions = {
  manifests?: SurfaceManifest[];
  defaultSurfaceId?: string;
};

/** In-memory policy registry; IO/plugin loading stays in injected callers. */
export const createSurfaceRegistry = (options: SurfaceRegistryOptions = {}): SurfaceRegistry => {
  const manifests = new Map<string, SurfaceManifest>();
  const defaultSurfaceId = options.defaultSurfaceId;

  const register: SurfaceRegistry['register'] = (input, registerOptions) => {
    const manifest = assertSurfaceManifest(input);
    if (manifests.has(manifest.id) && !registerOptions?.replace) {
      throw new Error(`Surface already registered: ${manifest.id}`);
    }
    manifests.set(manifest.id, clone(manifest));
  };

  for (const manifest of options.manifests ?? []) register(manifest);

  const get: SurfaceRegistry['get'] = (surfaceId) => {
    const value = manifests.get(surfaceId);
    return value ? clone(value) : undefined;
  };

  const list: SurfaceRegistry['list'] = () =>
    [...manifests.values()]
      .toSorted((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id))
      .map(clone);

  const discover: SurfaceRegistry['discover'] = (request) =>
    list().map((manifest) => {
      const result = assessManifest(manifest, request);
      return {
        manifest: clone(manifest),
        compatible: result.compatible,
        issues: clone(result.issues),
        capabilities: clone(result.capabilities),
      };
    });

  const resolve: SurfaceRegistry['resolve'] = (request): SurfaceResolution => {
    const requestedSurfaceId = request.surfaceId ?? defaultSurfaceId ?? '';
    const queue = requestedSurfaceId ? [requestedSurfaceId] : [];
    const visited = new Set<string>();
    const fallbackTrail: string[] = [];
    const collectedIssues: SurfaceResolutionIssue[] = [];

    while (queue.length > 0) {
      const surfaceId = queue.shift() ?? '';
      if (visited.has(surfaceId)) {
        collectedIssues.push({ code: 'fallback-cycle', message: `Fallback cycle detected at ${surfaceId}.` });
        continue;
      }
      visited.add(surfaceId);
      fallbackTrail.push(surfaceId);
      const manifest = manifests.get(surfaceId);
      if (!manifest) {
        collectedIssues.push({ code: 'unknown-surface', message: `Surface is not registered: ${surfaceId}.` });
        continue;
      }
      const result = assessManifest(manifest, request);
      if (result.compatible) {
        return {
          ok: true,
          value: {
            manifest: clone(manifest),
            capabilities: clone(result.capabilities),
            omittedOptionalCapabilities: clone(result.omitted),
            fallbackTrail: [...fallbackTrail],
          },
        };
      }
      collectedIssues.push(...result.issues);
      queue.push(...(manifest.fallbackSurfaceIds ?? []));
      if (defaultSurfaceId && surfaceId !== defaultSurfaceId) queue.push(defaultSurfaceId);
    }

    return {
      ok: false,
      requestedSurfaceId,
      fallbackTrail,
      issues:
        collectedIssues.length > 0
          ? collectedIssues
          : [{ code: 'unknown-surface', message: 'No surface or default surface was requested.' }],
    };
  };

  return {
    register,
    unregister: (surfaceId) => manifests.delete(surfaceId),
    get,
    list,
    discover,
    resolve,
  };
};
