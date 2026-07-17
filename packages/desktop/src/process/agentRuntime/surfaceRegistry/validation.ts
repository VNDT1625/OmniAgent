import type {
  SurfaceCapabilityKind,
  SurfaceContextSlice,
  SurfaceManifest,
  SurfacePermissionMode,
  SurfaceTargetKind,
} from './types';

export type SurfaceManifestValidationIssue = { path: string; code: string; message: string };
export type SurfaceManifestValidationResult =
  | { valid: true; manifest: SurfaceManifest; issues: [] }
  | { valid: false; issues: SurfaceManifestValidationIssue[] };

const TARGET_KINDS = new Set<SurfaceTargetKind>(['builtin', 'acp', 'cli', 'remote']);
const PERMISSION_MODES = new Set<SurfacePermissionMode>(['read-only', 'workspace-write', 'full-access']);
const CONTEXT_SLICES = new Set<SurfaceContextSlice>(['agent', 'personal', 'workspace', 'conversation', 'surface']);
const CAPABILITY_KINDS = new Set<SurfaceCapabilityKind>(['mcp', 'native', 'skill', 'bridge']);
const PERMISSION_RANK: Record<SurfacePermissionMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'full-access': 2,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const validateStringArray = (
  value: unknown,
  path: string,
  issues: SurfaceManifestValidationIssue[],
  options: { required?: boolean; allowEmpty?: boolean } = {}
): string[] | undefined => {
  if (value === undefined && !options.required) return undefined;
  if (!Array.isArray(value)) {
    issues.push({ path, code: 'invalid-array', message: `${path} must be an array.` });
    return undefined;
  }
  const values = value.filter(nonEmptyString);
  if (values.length !== value.length) {
    issues.push({ path, code: 'invalid-string', message: `${path} must contain only non-empty strings.` });
  }
  if (!options.allowEmpty && values.length === 0) {
    issues.push({ path, code: 'empty-array', message: `${path} must not be empty.` });
  }
  if (new Set(values).size !== values.length) {
    issues.push({ path, code: 'duplicate-value', message: `${path} must not contain duplicates.` });
  }
  return values;
};

const validateCompatibility = (value: unknown, path: string, issues: SurfaceManifestValidationIssue[]): void => {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path, code: 'invalid-object', message: `${path} must be an object.` });
    return;
  }
  const targets = validateStringArray(value.targetKinds, `${path}.targetKinds`, issues, { allowEmpty: false });
  if (targets?.some((item) => !TARGET_KINDS.has(item as SurfaceTargetKind))) {
    issues.push({ path: `${path}.targetKinds`, code: 'unknown-target', message: 'Unknown target kind.' });
  }
  validateStringArray(value.protocols, `${path}.protocols`, issues, { allowEmpty: false });
  validateStringArray(value.modelIds, `${path}.modelIds`, issues, { allowEmpty: false });
  validateStringArray(value.providerIds, `${path}.providerIds`, issues, { allowEmpty: false });
  validateStringArray(value.requiredModelCapabilities, `${path}.requiredModelCapabilities`, issues, {
    allowEmpty: false,
  });
};

/** Validate untrusted built-in, plugin or user surface JSON before registration. */
export const validateSurfaceManifest = (value: unknown): SurfaceManifestValidationResult => {
  const issues: SurfaceManifestValidationIssue[] = [];
  if (!isRecord(value))
    return { valid: false, issues: [{ path: '', code: 'invalid-object', message: 'Manifest must be an object.' }] };

  if (value.schemaVersion !== 1) {
    issues.push({
      path: 'schemaVersion',
      code: 'unsupported-version',
      message: 'Only surface schema version 1 is supported.',
    });
  }
  if (!nonEmptyString(value.id) || !/^[a-z][a-z0-9._-]{1,63}$/.test(value.id)) {
    issues.push({
      path: 'id',
      code: 'invalid-id',
      message: 'Surface id must be a 2-64 character lowercase identifier.',
    });
  }
  for (const field of ['label', 'description'] as const) {
    if (!nonEmptyString(value[field])) issues.push({ path: field, code: 'required', message: `${field} is required.` });
  }

  if (!isRecord(value.source) || !['builtin', 'plugin', 'user'].includes(String(value.source.kind))) {
    issues.push({
      path: 'source',
      code: 'invalid-source',
      message: 'Source must identify builtin, plugin or user ownership.',
    });
  } else if (value.source.kind === 'plugin' && !nonEmptyString(value.source.id)) {
    issues.push({ path: 'source.id', code: 'required', message: 'Plugin manifests require a source id.' });
  }
  if (value.priority !== undefined && (!Number.isInteger(value.priority) || Number(value.priority) < 0)) {
    issues.push({ path: 'priority', code: 'invalid-priority', message: 'Priority must be a non-negative integer.' });
  }
  validateCompatibility(value.compatibility, 'compatibility', issues);

  if (!isRecord(value.context)) {
    issues.push({ path: 'context', code: 'invalid-object', message: 'Context policy is required.' });
  } else {
    const required = validateStringArray(value.context.required, 'context.required', issues, {
      required: true,
      allowEmpty: true,
    });
    if (required?.some((item) => !CONTEXT_SLICES.has(item as SurfaceContextSlice))) {
      issues.push({ path: 'context.required', code: 'unknown-context', message: 'Unknown context slice.' });
    }
    if (typeof value.context.includeOpaqueSecretHandles !== 'boolean') {
      issues.push({
        path: 'context.includeOpaqueSecretHandles',
        code: 'required',
        message: 'Secret-handle policy is required.',
      });
    }
    const secrets = validateStringArray(
      value.context.allowedSecretCapabilities,
      'context.allowedSecretCapabilities',
      issues,
      { allowEmpty: true }
    );
    if (secrets && value.context.includeOpaqueSecretHandles === false && secrets.length > 0) {
      issues.push({
        path: 'context.allowedSecretCapabilities',
        code: 'secret-policy-conflict',
        message: 'Secret capabilities require opaque secret handles to be enabled.',
      });
    }
    if (
      value.context.maxCharacters !== undefined &&
      (!Number.isInteger(value.context.maxCharacters) || Number(value.context.maxCharacters) <= 0)
    ) {
      issues.push({
        path: 'context.maxCharacters',
        code: 'invalid-limit',
        message: 'Context limit must be a positive integer.',
      });
    }
  }

  if (!isRecord(value.permissions)) {
    issues.push({ path: 'permissions', code: 'invalid-object', message: 'Permission policy is required.' });
  } else {
    const minimum = value.permissions.minimumMode;
    if (!PERMISSION_MODES.has(minimum as SurfacePermissionMode)) {
      issues.push({
        path: 'permissions.minimumMode',
        code: 'unknown-permission',
        message: 'Unknown minimum permission mode.',
      });
    }
    const allowed = validateStringArray(value.permissions.allowedModes, 'permissions.allowedModes', issues, {
      required: true,
    });
    if (allowed?.some((item) => !PERMISSION_MODES.has(item as SurfacePermissionMode))) {
      issues.push({
        path: 'permissions.allowedModes',
        code: 'unknown-permission',
        message: 'Unknown allowed permission mode.',
      });
    }
    if (
      PERMISSION_MODES.has(minimum as SurfacePermissionMode) &&
      allowed &&
      !allowed.some(
        (item) => PERMISSION_RANK[item as SurfacePermissionMode] >= PERMISSION_RANK[minimum as SurfacePermissionMode]
      )
    ) {
      issues.push({
        path: 'permissions.allowedModes',
        code: 'unreachable-minimum',
        message: 'No allowed mode satisfies the minimum.',
      });
    }
    validateStringArray(value.permissions.requiredScopes, 'permissions.requiredScopes', issues, { allowEmpty: true });
    if (typeof value.permissions.requireExplicitGrant !== 'boolean') {
      issues.push({
        path: 'permissions.requireExplicitGrant',
        code: 'required',
        message: 'Explicit-grant policy is required.',
      });
    }
  }

  if (!Array.isArray(value.capabilities)) {
    issues.push({ path: 'capabilities', code: 'invalid-array', message: 'Capabilities must be an array.' });
  } else {
    const ids = new Set<string>();
    value.capabilities.forEach((candidate, index) => {
      const path = `capabilities[${index}]`;
      if (!isRecord(candidate)) {
        issues.push({ path, code: 'invalid-object', message: 'Capability binding must be an object.' });
        return;
      }
      if (!nonEmptyString(candidate.id))
        issues.push({ path: `${path}.id`, code: 'required', message: 'Capability id is required.' });
      else if (ids.has(candidate.id))
        issues.push({ path: `${path}.id`, code: 'duplicate-capability', message: 'Capability ids must be unique.' });
      else ids.add(candidate.id);
      if (!nonEmptyString(candidate.label))
        issues.push({ path: `${path}.label`, code: 'required', message: 'Capability label is required.' });
      if (!CAPABILITY_KINDS.has(candidate.kind as SurfaceCapabilityKind)) {
        issues.push({ path: `${path}.kind`, code: 'unknown-kind', message: 'Unknown capability binding kind.' });
      }
      if (candidate.kind === 'mcp' && !nonEmptyString(candidate.serverName)) {
        issues.push({ path: `${path}.serverName`, code: 'required', message: 'MCP bindings require a server name.' });
      }
      validateStringArray(candidate.toolPatterns, `${path}.toolPatterns`, issues, { required: true });
      if (!PERMISSION_MODES.has(candidate.minimumPermissionMode as SurfacePermissionMode)) {
        issues.push({
          path: `${path}.minimumPermissionMode`,
          code: 'unknown-permission',
          message: 'Unknown capability permission mode.',
        });
      }
      validateStringArray(candidate.requiredPermissionScopes, `${path}.requiredPermissionScopes`, issues, {
        allowEmpty: true,
      });
      if (candidate.optional !== undefined && typeof candidate.optional !== 'boolean') {
        issues.push({ path: `${path}.optional`, code: 'invalid-boolean', message: 'Optional must be boolean.' });
      }
      if (candidate.requireExplicitGrant !== undefined && typeof candidate.requireExplicitGrant !== 'boolean') {
        issues.push({
          path: `${path}.requireExplicitGrant`,
          code: 'invalid-boolean',
          message: 'Explicit grant must be boolean.',
        });
      }
      validateCompatibility(candidate.compatibility, `${path}.compatibility`, issues);
    });
  }

  const fallbacks = validateStringArray(value.fallbackSurfaceIds, 'fallbackSurfaceIds', issues, { allowEmpty: true });
  if (nonEmptyString(value.id) && fallbacks?.includes(value.id)) {
    issues.push({
      path: 'fallbackSurfaceIds',
      code: 'self-fallback',
      message: 'A surface cannot fall back to itself.',
    });
  }

  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, manifest: structuredClone(value as SurfaceManifest), issues: [] };
};

export class SurfaceManifestValidationError extends Error {
  readonly issues: SurfaceManifestValidationIssue[];

  constructor(issues: SurfaceManifestValidationIssue[]) {
    super(`Invalid surface manifest: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    this.name = 'SurfaceManifestValidationError';
    this.issues = issues;
  }
}

export const assertSurfaceManifest = (value: unknown): SurfaceManifest => {
  const result = validateSurfaceManifest(value);
  if (!result.valid) throw new SurfaceManifestValidationError(result.issues);
  return result.manifest;
};
