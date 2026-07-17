import { describe, expect, it } from 'vitest';
import { buildSurfaceHarnessPrompt } from '../../../packages/desktop/src/process/agentRuntime/surfaceRegistry/harnesses';
import type { ResolvedSurface } from '../../../packages/desktop/src/process/agentRuntime/surfaceRegistry/types';

const resolvedSurface = (id: string): ResolvedSurface => ({
  manifest: {
    schemaVersion: 1,
    id,
    label: id,
    description: `${id} surface`,
    source: { kind: 'builtin' },
    context: {
      required: ['agent', 'personal', 'conversation', 'surface'],
      includeOpaqueSecretHandles: false,
    },
    permissions: {
      minimumMode: 'read-only',
      allowedModes: ['read-only'],
      requireExplicitGrant: false,
    },
    capabilities: [],
  },
  capabilities: [],
  omittedOptionalCapabilities: [],
  fallbackTrail: [],
});

describe('surface harness prompts', () => {
  it('adds a live Studio and PowerPoint workflow for the Office surface', () => {
    const prompt = buildSurfaceHarnessPrompt(resolvedSurface('office'));

    expect(prompt).toContain('[Studio Office Harness]');
    expect(prompt).toContain('office_read_document');
    expect(prompt).toContain('office_create_premium_deck');
    expect(prompt).toContain('office_review_premium_quality');
  });

  it('does not leak Office instructions into unrelated surfaces', () => {
    expect(buildSurfaceHarnessPrompt(resolvedSurface('music'))).toBe('');
  });

  it('returns no harness when surface resolution is unavailable', () => {
    expect(buildSurfaceHarnessPrompt(undefined)).toBe('');
  });
});
