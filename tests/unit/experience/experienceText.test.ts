/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the pure text helpers of the ExpBase engine.
 */

import { describe, expect, it } from 'vitest';
import {
  buildEmbeddingText,
  buildLexicalText,
  clampConfidence,
  computeVerificationStrength,
  normalizeStringList,
  redactList,
  redactSecrets,
  tokenize,
} from '@/process/experience/experienceText';
import type { ExperienceEntry } from '@/process/experience/experienceTypes';

describe('redactSecrets', () => {
  it('redacts OpenAI-style keys', () => {
    expect(redactSecrets('using sk-abcd1234efgh5678ijkl to call')).toContain('[REDACTED]');
    expect(redactSecrets('using sk-abcd1234efgh5678ijkl')).not.toContain('sk-abcd1234efgh5678ijkl');
  });

  it('redacts key=value assignments for sensitive names', () => {
    const out = redactSecrets('api_key=super-secret-value-123');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('super-secret-value-123');
  });

  it('redacts GitHub and JWT tokens', () => {
    expect(redactSecrets('ghp_0123456789abcdefABCDEF')).toBe('[REDACTED]');
    expect(redactSecrets('token eyJhbGciOi.eyJzdWIiO1.SflKxwRJSM')).toContain('[REDACTED]');
  });

  it('redacts passwords embedded in connection strings', () => {
    const out = redactSecrets('postgres://admin:s3cr3tPass@db.example.com:5432/app');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('s3cr3tPass');
    expect(out).toContain('@db.example.com');
    expect(out).toContain('postgres://admin:');
  });

  it('is idempotent and preserves surrounding structure', () => {
    const once = redactSecrets('Error at file.ts: api_key=abcdef123456 failed');
    expect(redactSecrets(once)).toBe(once);
    expect(once).toContain('Error at file.ts:');
  });

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('TypeError: cannot read property foo of undefined')).toBe('TypeError: cannot read property foo of undefined');
  });
});

describe('normalizeStringList', () => {
  it('trims, drops empties, and de-dupes case-insensitively', () => {
    expect(normalizeStringList([' React ', 'react', '', 'Vitest', 'REACT'])).toEqual(['React', 'Vitest']);
  });

  it('returns [] for undefined', () => {
    expect(normalizeStringList(undefined)).toEqual([]);
  });
});

describe('redactList', () => {
  it('redacts and drops empties', () => {
    expect(redactList(['ghp_0123456789abcdefABCDEF', '  '])).toEqual(['[REDACTED]']);
  });
});

describe('clampConfidence', () => {
  it('clamps to [0, 1] and falls back on non-finite', () => {
    expect(clampConfidence(1.5)).toBe(1);
    expect(clampConfidence(-2)).toBe(0);
    expect(clampConfidence(0.42)).toBe(0.42);
    expect(clampConfidence(undefined, 0.7)).toBe(0.7);
    expect(clampConfidence(Number.NaN, 0.3)).toBe(0.3);
  });
});

describe('computeVerificationStrength', () => {
  it('is low with no evidence', () => {
    expect(computeVerificationStrength({ commands: [], confidenceEvidence: [] })).toBeLessThan(0.2);
  });

  it('rewards passed commands and evidence', () => {
    const strong = computeVerificationStrength({
      commands: [{ command: 'bun run test', outcome: 'passed' }],
      confidenceEvidence: ['all 12 tests pass'],
    });
    const weak = computeVerificationStrength({
      commands: [{ command: 'bun run test', outcome: 'failed' }],
      confidenceEvidence: [],
    });
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeGreaterThan(0.4);
  });
});

const baseCore: Pick<ExperienceEntry, 'kind' | 'symptoms' | 'context' | 'rootCause' | 'fix' | 'lesson' | 'verification' | 'tags'> = {
  kind: 'successful_fix',
  symptoms: { summary: 'tsc fails with TS2345', errorMessages: ['TS2345: Argument not assignable'] },
  context: { repoArea: ['process/ide'], files: ['a.ts'], commands: ['bunx tsc'], frameworks: ['typescript'], packages: ['typescript'], errorCategory: 'compile' },
  rootCause: 'wrong generic',
  fix: { summary: 'add explicit type', steps: ['annotate param'], changedFiles: ['a.ts'] },
  lesson: 'annotate generics explicitly',
  verification: { commands: [{ command: 'bunx tsc', outcome: 'passed' }], confidenceEvidence: ['tsc clean'] },
  tags: ['ts'],
};

describe('buildEmbeddingText', () => {
  it('is deterministic for identical content', () => {
    expect(buildEmbeddingText(baseCore)).toBe(buildEmbeddingText({ ...baseCore }));
  });

  it('includes the key sections', () => {
    const text = buildEmbeddingText(baseCore);
    expect(text).toContain('Kind: successful_fix');
    expect(text).toContain('Symptoms:');
    expect(text).toContain('Lesson: annotate generics explicitly');
    expect(text).toContain('Verification: bunx tsc');
  });
});

describe('buildLexicalText and tokenize', () => {
  it('lower-cases and includes identifiers', () => {
    const lexical = buildLexicalText({
      symptom: 'TSC Fails',
      lesson: 'Annotate',
      tags: ['TS'],
      frameworks: ['TypeScript'],
      packages: [],
      files: ['A.ts'],
      commands: ['bunx tsc'],
      errorCategory: 'compile',
    });
    expect(lexical).toBe(lexical.toLowerCase());
    expect(lexical).toContain('typescript');
    expect(tokenize(lexical)).toContain('compile');
  });
});
