/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the ExpBase capture service: normalization, sanitization,
 * dedupe/merge, and optional embedding.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExperienceStore } from '@/process/experience/experienceStore';
import {
  createExperienceCapture,
  lexicalJaccard,
  mergeEntries,
  normalizeDraft,
} from '@/process/experience/experienceCapture';
import type { ExperienceEmbedder } from '@/process/experience/experienceVectorIndex';
import type { ExperienceEntryDraft } from '@/process/experience/experienceTypes';
import { createMemFs } from './memFs';

const ROOT = path.join('cap-root');

const draft = (overrides: Partial<ExperienceEntryDraft> = {}): ExperienceEntryDraft => ({
  projectId: 'proj_a',
  kind: 'successful_fix',
  symptoms: { summary: 'vitest mock not applied', errorMessages: ['expected spy to be called'] },
  context: {
    files: ['useThing.ts'],
    commands: ['bun run test'],
    frameworks: ['vitest'],
    packages: ['vitest'],
    errorCategory: 'test-failure',
  },
  rootCause: 'mock declared after import',
  fix: { summary: 'hoist vi.mock', steps: ['move vi.mock above imports'], changedFiles: ['useThing.ts'] },
  lesson: 'vi.mock must be hoisted above imports',
  verification: { commands: [{ command: 'bun run test', outcome: 'passed' }], confidenceEvidence: ['suite green'] },
  tags: ['vitest', 'mock'],
  confidence: 0.7,
  ...overrides,
});

const makeCapture = (embedder?: ExperienceEmbedder | null) => {
  const store = createExperienceStore({ rootDir: ROOT, fs: createMemFs() });
  let counter = 0;
  const capture = createExperienceCapture({
    store,
    embedder,
    now: () => '2026-06-09T00:00:00.000Z',
    generateId: () => `exp_${++counter}`,
  });
  return { store, capture };
};

describe('normalizeDraft', () => {
  it('sanitizes secrets and derives embeddingText/status', () => {
    const entry = normalizeDraft(
      draft({ rootCause: 'leaked api_key=topsecret123456' }),
      'exp_x',
      '2026-06-09T00:00:00.000Z'
    );
    expect(entry.rootCause).toContain('[REDACTED]');
    expect(entry.status).toBe('active');
    expect(entry.embeddingText).toContain('Kind: successful_fix');
    expect(entry.confidence).toBe(0.7);
  });

  it('throws on invalid kind, missing projectId, or missing symptom', () => {
    expect(() => normalizeDraft(draft({ kind: 'nope' as never }), 'x', 'now')).toThrow(/Invalid kind/);
    expect(() => normalizeDraft(draft({ projectId: '' }), 'x', 'now')).toThrow(/projectId/);
    expect(() => normalizeDraft(draft({ symptoms: { summary: '' } }), 'x', 'now')).toThrow(/symptom/);
  });

  it('coerces unknown verification outcomes to not_run', () => {
    const entry = normalizeDraft(
      draft({ verification: { commands: [{ command: 'x', outcome: 'weird' as never }] } }),
      'x',
      'now'
    );
    expect(entry.verification.commands[0].outcome).toBe('not_run');
  });
});

describe('lexicalJaccard', () => {
  it('is 1 for identical text and lower for divergent text', () => {
    expect(lexicalJaccard('alpha beta gamma', 'alpha beta gamma')).toBeCloseTo(1, 6);
    expect(lexicalJaccard('alpha beta gamma', 'alpha delta epsilon')).toBeLessThan(0.5);
  });
});

describe('createExperienceCapture', () => {
  it('creates a new entry on first capture', async () => {
    const { capture } = makeCapture();
    const result = await capture.capture(draft());
    expect(result.action).toBe('created');
    expect(result.entry.id).toBe('exp_1');
    expect(result.entry.vector).toBeUndefined();
  });

  it('merges a near-duplicate instead of creating a second entry', async () => {
    const { store, capture } = makeCapture();
    await capture.capture(draft());
    const second = await capture.capture(
      draft({
        symptoms: { summary: 'vitest mock not applied', errorMessages: ['expected spy to be called', 'extra detail'] },
      })
    );

    expect(second.action).toBe('updated');
    expect(second.entry.id).toBe('exp_1');
    expect(second.entry.symptoms.errorMessages).toContain('extra detail');
    expect(second.entry.confidence).toBeGreaterThan(0.7);
    expect((await store.searchMetadata({ projectId: 'proj_a' })).length).toBe(1);
  });

  it('does not merge a clearly different experience', async () => {
    const { store, capture } = makeCapture();
    await capture.capture(draft());
    const other = await capture.capture(
      draft({
        symptoms: { summary: 'electron window fails to open on linux wayland' },
        rootCause: 'missing ozone platform flag',
        fix: { summary: 'pass --ozone-platform-hint=auto', steps: [], changedFiles: ['main.ts'] },
        lesson: 'set ozone platform hint on wayland',
        context: {
          files: ['main.ts'],
          commands: ['bun start'],
          frameworks: ['electron'],
          packages: ['electron'],
          errorCategory: 'runtime',
        },
        tags: ['electron', 'linux'],
      })
    );
    expect(other.action).toBe('created');
    expect((await store.searchMetadata({ projectId: 'proj_a' })).length).toBe(2);
  });

  it('attaches a vector when an embedder is available', async () => {
    const embedder: ExperienceEmbedder = {
      providerId: 'fake',
      model: 'm',
      embed: async (texts) => texts.map(() => [0, 3, 4]),
    };
    const { capture } = makeCapture(embedder);
    const result = await capture.capture(draft());
    expect(result.entry.vector).toEqual([0, 0.6, 0.8]);
  });

  it('degrades to no vector when embedding throws', async () => {
    const embedder: ExperienceEmbedder = {
      providerId: 'fake',
      model: 'm',
      embed: async () => {
        throw new Error('offline');
      },
    };
    const { capture } = makeCapture(embedder);
    const result = await capture.capture(draft());
    expect(result.entry.vector).toBeUndefined();
    expect(result.action).toBe('created');
  });
});

describe('mergeEntries', () => {
  it('unions context and raises confidence', () => {
    const a = normalizeDraft(draft(), 'a', '2026-06-01T00:00:00.000Z');
    const b = normalizeDraft(
      draft({ context: { files: ['other.ts'], frameworks: ['vitest'], packages: [], commands: [] }, tags: ['extra'] }),
      'b',
      '2026-06-02T00:00:00.000Z'
    );
    const merged = mergeEntries(a, b, '2026-06-03T00:00:00.000Z');
    expect(merged.context.files).toEqual(expect.arrayContaining(['useThing.ts', 'other.ts']));
    expect(merged.tags).toEqual(expect.arrayContaining(['vitest', 'mock', 'extra']));
    expect(merged.confidence).toBeGreaterThanOrEqual(a.confidence);
    expect(merged.updatedAt).toBe('2026-06-03T00:00:00.000Z');
  });
});
