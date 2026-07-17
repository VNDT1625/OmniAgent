import { describe, expect, it } from 'vitest';

import {
  createBuiltinSurfaceManifests,
  createSurfaceRegistry,
  SurfaceManifestValidationError,
  validateSurfaceManifest,
  type SurfaceManifest,
} from '@/process/agentRuntime/surfaceRegistry';

const customManifest = (overrides: Partial<SurfaceManifest> = {}): SurfaceManifest => ({
  schemaVersion: 1,
  id: 'custom.surface',
  label: 'Custom surface',
  description: 'Plugin-provided custom work surface.',
  source: { kind: 'plugin', id: 'example.plugin', version: '1.0.0' },
  priority: 10,
  context: {
    required: ['agent', 'personal', 'surface'],
    includeOpaqueSecretHandles: false,
  },
  permissions: {
    minimumMode: 'read-only',
    allowedModes: ['read-only', 'workspace-write', 'full-access'],
    requireExplicitGrant: false,
  },
  capabilities: [
    {
      id: 'plugin.inspect',
      label: 'Plugin inspect tools',
      kind: 'mcp',
      serverName: 'example-plugin',
      toolPatterns: ['example_read_*'],
      minimumPermissionMode: 'read-only',
    },
  ],
  ...overrides,
});

const model = {
  targetKind: 'acp' as const,
  protocol: 'acp',
  modelId: 'claude-sonnet-5',
  providerId: 'anthropic',
  capabilities: ['mcp', 'vision'],
};

const fullRequest = {
  model,
  permissionMode: 'full-access' as const,
  grantedPermissionScopes: ['workspace.read', 'workspace.write', 'browser.control', 'office.read', 'office.write'],
  explicitlyGrantedCapabilityIds: ['surface.ide', 'surface.browser', 'surface.office', 'plugin.inspect'],
};

describe('surface manifest validation', () => {
  it('accepts a data-only custom plugin manifest', () => {
    const result = validateSurfaceManifest(customManifest());

    expect(result.valid).toBe(true);
    if (result.valid) expect(result.manifest.source.kind).toBe('plugin');
  });

  it('rejects unsafe or ambiguous plugin policy', () => {
    const invalid = customManifest({
      id: 'INVALID ID',
      context: {
        required: ['surface'],
        includeOpaqueSecretHandles: false,
        allowedSecretCapabilities: ['browser.secret_type'],
      },
      capabilities: [
        {
          id: 'broken',
          label: 'Broken MCP',
          kind: 'mcp',
          toolPatterns: [],
          minimumPermissionMode: 'read-only',
        },
      ],
      fallbackSurfaceIds: ['INVALID ID'],
    });

    const result = validateSurfaceManifest(invalid);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['invalid-id', 'secret-policy-conflict', 'required', 'empty-array', 'self-fallback'])
      );
    }
  });
});

describe('surface registry discovery', () => {
  it('registers and discovers custom surfaces without runtime code changes', () => {
    const registry = createSurfaceRegistry();
    registry.register(customManifest());

    const discovery = registry.discover(fullRequest);

    expect(discovery).toHaveLength(1);
    expect(discovery[0]).toMatchObject({ compatible: true, manifest: { id: 'custom.surface' } });
  });

  it('filters by transport, model/provider patterns and model capabilities', () => {
    const registry = createSurfaceRegistry({
      manifests: [
        customManifest({
          compatibility: {
            targetKinds: ['acp'],
            protocols: ['acp'],
            modelIds: ['claude-*'],
            providerIds: ['anthropic'],
            requiredModelCapabilities: ['mcp', 'vision'],
          },
        }),
      ],
    });

    const compatible = registry.discover(fullRequest)[0];
    const incompatible = registry.discover({
      ...fullRequest,
      model: { targetKind: 'cli', protocol: 'tomny-json-stream', modelId: 'text-only', capabilities: [] },
    })[0];

    expect(compatible.compatible).toBe(true);
    expect(incompatible.compatible).toBe(false);
    expect(incompatible.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'incompatible-target',
        'incompatible-protocol',
        'incompatible-model',
        'missing-model-capability',
      ])
    );
  });

  it('omits an unavailable optional capability without rejecting its surface', () => {
    const registry = createSurfaceRegistry({
      manifests: [
        customManifest({
          capabilities: [
            {
              id: 'plugin.optional',
              label: 'Optional tool',
              kind: 'skill',
              toolPatterns: ['optional_*'],
              optional: true,
              minimumPermissionMode: 'read-only',
            },
          ],
        }),
      ],
    });

    const result = registry.resolve({ ...fullRequest, surfaceId: 'custom.surface', availableCapabilityIds: [] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.capabilities).toEqual([]);
      expect(result.value.omittedOptionalCapabilities[0]?.capabilityId).toBe('plugin.optional');
    }
  });
});

describe('surface resolution and fallback', () => {
  it('resolves the IDE harness only with matching permission, scopes, availability and approval', () => {
    const registry = createSurfaceRegistry({ manifests: createBuiltinSurfaceManifests(), defaultSurfaceId: 'chat' });

    const result = registry.resolve({
      ...fullRequest,
      surfaceId: 'ide',
      availableCapabilityIds: ['surface.ide'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.id).toBe('ide');
      expect(result.value.capabilities[0]?.serverName).toBe('aionui-ide');
    }
  });

  it('falls back to normal chat when the requested harness cannot be granted', () => {
    const registry = createSurfaceRegistry({ manifests: createBuiltinSurfaceManifests(), defaultSurfaceId: 'chat' });

    const result = registry.resolve({
      model,
      surfaceId: 'browser',
      permissionMode: 'read-only',
      availableCapabilityIds: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.id).toBe('chat');
      expect(result.value.fallbackTrail).toEqual(['browser', 'chat']);
    }
  });

  it('reports unknown surfaces and fallback cycles instead of looping', () => {
    const first = customManifest({ id: 'cycle.first', fallbackSurfaceIds: ['cycle.second'] });
    const second = customManifest({ id: 'cycle.second', fallbackSurfaceIds: ['cycle.first'] });
    const registry = createSurfaceRegistry({ manifests: [first, second] });

    const result = registry.resolve({
      model,
      surfaceId: 'cycle.first',
      permissionMode: 'read-only',
      availableCapabilityIds: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain('fallback-cycle');
  });

  it('protects registered state from caller mutation and requires explicit replacement', () => {
    const manifest = customManifest();
    const registry = createSurfaceRegistry({ manifests: [manifest] });
    manifest.label = 'Mutated outside';

    expect(registry.get('custom.surface')?.label).toBe('Custom surface');
    expect(() => registry.register(customManifest())).toThrow('Surface already registered');
    registry.register(customManifest({ label: 'Replacement' }), { replace: true });
    expect(registry.get('custom.surface')?.label).toBe('Replacement');
  });

  it('rejects an invalid manifest at the registry boundary', () => {
    const registry = createSurfaceRegistry();

    expect(() => registry.register({ ...customManifest(), source: { kind: 'plugin' } })).toThrow(
      SurfaceManifestValidationError
    );
  });
});
