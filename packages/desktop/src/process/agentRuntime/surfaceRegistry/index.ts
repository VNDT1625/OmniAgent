export { BUILTIN_SURFACE_MANIFESTS, createBuiltinSurfaceManifests } from './defaults';
export { createSurfaceRegistry, type SurfaceRegistryOptions } from './registry';
export {
  assertSurfaceManifest,
  SurfaceManifestValidationError,
  validateSurfaceManifest,
  type SurfaceManifestValidationIssue,
  type SurfaceManifestValidationResult,
} from './validation';
export type {
  ResolvedSurface,
  SurfaceCapabilityBinding,
  SurfaceCapabilityKind,
  SurfaceCompatibilityPolicy,
  SurfaceContextPolicy,
  SurfaceContextSlice,
  SurfaceDiscoveryResult,
  SurfaceManifest,
  SurfaceManifestSource,
  SurfaceModelDescriptor,
  SurfacePermissionMode,
  SurfacePermissionPolicy,
  SurfaceRegistry,
  SurfaceResolution,
  SurfaceResolutionIssue,
  SurfaceResolutionIssueCode,
  SurfaceResolutionRequest,
  SurfaceTargetKind,
} from './types';
