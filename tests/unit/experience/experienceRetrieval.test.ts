/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the ExpBase retrieval/ranking service.
 */

import { describe, expect, it } from 'vitest';
import {
  buildQueryText,
  computeContextMatch,
  createExperienceRetrieval,
  rankExperiences,
} from '@/process/experience/experienceRetrieval';
import type { ExperienceEmbedder } from '@/process/experience/experienceVectorIndex';
import type { ExperienceProjectionEntry, ExperienceQuery } from '@/process/experience/experienceTypes';

const NOW = Date.parse('2026-06-09T00:00:00.000Z');

const entry = (overrides: Partial<ExperienceProjectionEntry> = {}): ExperienceProjectionEntry => ({
  id: 'exp_1',
  kind: 'successful_fix',
  status: 'active',
  symptom: 'vitest mock not applied to module',
  lesson: 'hoist vi.mock above imports',
  tags: ['vitest', 'mock'],
  frameworks: ['vitest'],
  packages: ['vitest'],
  files: ['useThing.ts'],
  commands: ['bun run test'],
  errorCategory: 'test-failure',
  confidence: 0.8,
  verificationStrength: 0.8,
  updatedAt: '2026-06-08T00:00:00.000Z',
  lexicalText:
    'vitest mock not applied to module hoist vi.mock above imports vitest mock vitest usething.ts bun run test test-failure',
  caution: ['Confirm the current framework/version and context match before applying.'],
  suggestedChecks: ['Run: bun run test'],
  relations: [],
  ...overrides,
});

const query: ExperienceQuery = {
  symptom: 'my vitest mock is not applied',
  frameworks: ['vitest'],
  packages: ['vitest'],
  commands: ['bun run test'],
  files: ['useThing.ts'],
  errorCategory: 'test-failure',
};

describe('buildQueryText', () => {
  it('includes symptom, frameworks, and commands', () => {
    const text = buildQueryText(query);
    expect(text).toContain('my vitest mock is not applied');
    expect(text).toContain('frameworks vitest');
    expect(text).toContain('commands bun run test');
  });
});

describe('computeContextMatch', () => {
  it('scores high and lists reasons when metadata matches', () => {
    const match = computeContextMatch(query, entry());
    expect(match.score).toBeGreaterThan(0.9);
    expect(match.why).toEqual(expect.arrayContaining(['Same framework', 'Same command failed', 'Same error category']));
  });

  it('scores 0 when the query carries no metadata', () => {
    expect(computeContextMatch({ symptom: 'x' }, entry()).score).toBe(0);
  });
});

describe('rankExperiences', () => {
  it('surfaces a strongly matching entry with caution and checks', () => {
    const [suggestion] = rankExperiences(query, [entry()], { now: NOW });
    expect(suggestion.entryId).toBe('exp_1');
    expect(suggestion.score).toBeGreaterThan(0.4);
    expect(suggestion.caution.length).toBeGreaterThan(0);
    expect(suggestion.suggestedChecks).toContain('Run: bun run test');
  });

  it('drops archived entries entirely', () => {
    expect(rankExperiences(query, [entry({ status: 'archived' })], { now: NOW })).toEqual([]);
  });

  it('penalizes superseded entries below an equivalent active one', () => {
    const active = rankExperiences(query, [entry({ id: 'a' })], { now: NOW })[0];
    const superseded = rankExperiences(query, [entry({ id: 's', status: 'superseded' })], { now: NOW, minScore: 0 })[0];
    expect(active.score).toBeGreaterThan(superseded.score);
  });

  it('ranks a same-framework entry above a different-framework one', () => {
    const sameFramework = entry({ id: 'same' });
    const otherFramework = entry({
      id: 'other',
      frameworks: ['jest'],
      packages: ['jest'],
      commands: ['npx jest'],
      lexicalText: 'jest mock not applied hoist jest.mock npx jest test-failure',
    });
    const ranked = rankExperiences(query, [otherFramework, sameFramework], { now: NOW });
    expect(ranked[0].entryId).toBe('same');
  });

  it('respects topK', () => {
    const entries = [entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })];
    expect(rankExperiences(query, entries, { now: NOW, topK: 2 }).length).toBe(2);
  });
});

describe('createExperienceRetrieval', () => {
  it('uses vector similarity when an embedder is provided', async () => {
    const embedder: ExperienceEmbedder = {
      providerId: 'f',
      model: 'm',
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    };
    const retrieval = createExperienceRetrieval({ embedder, now: () => NOW });
    const withVector = entry({ id: 'v', vector: [1, 0, 0] });
    const [suggestion] = await retrieval.retrieve(query, [withVector]);
    expect(suggestion.entryId).toBe('v');
    expect(suggestion.whyRelevant).toEqual(expect.arrayContaining(['Strong semantic match']));
  });

  it('falls back to lexical when embedding fails', async () => {
    const embedder: ExperienceEmbedder = {
      providerId: 'f',
      model: 'm',
      embed: async () => {
        throw new Error('offline');
      },
    };
    const retrieval = createExperienceRetrieval({ embedder, now: () => NOW });
    const suggestions = await retrieval.retrieve(query, [entry()]);
    expect(suggestions.length).toBe(1);
  });
});
