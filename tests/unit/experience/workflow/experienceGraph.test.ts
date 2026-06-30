/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for Exp Graph relation inference and suggestion enrichment.
 */

import { describe, expect, it } from 'vitest';
import {
  enrichSuggestions,
  inferRelations,
  recomputeAllRelations,
} from '@/process/experience/workflow/experienceGraph';
import type { ExperienceEntry, ExperienceSuggestion } from '@/process/experience/experienceTypes';

const entry = (overrides: Partial<ExperienceEntry> = {}): ExperienceEntry => ({
  id: 'e1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-08T00:00:00.000Z',
  projectId: 'p',
  kind: 'successful_fix',
  symptoms: { summary: 'vitest mock not applied to module under test', errorMessages: [] },
  context: {
    repoArea: [],
    files: ['useThing.ts'],
    commands: ['bun run test'],
    frameworks: ['vitest'],
    packages: ['vitest'],
    errorCategory: 'test-failure',
  },
  rootCause: 'mock declared after import hoisting',
  lesson: 'hoist vi.mock above imports',
  verification: { commands: [], confidenceEvidence: [] },
  tags: [],
  confidence: 0.8,
  relatedEntryIds: [],
  relations: [],
  embeddingText: '',
  status: 'active',
  ...overrides,
});

describe('inferRelations', () => {
  it('links entries with the same symptom and same root cause', () => {
    const a = entry({ id: 'a' });
    const b = entry({ id: 'b' });
    const relations = inferRelations(a, [a, b]);
    expect(relations).toEqual(
      expect.arrayContaining([
        { type: 'same_symptom_as', targetId: 'b' },
        { type: 'same_root_cause', targetId: 'b' },
      ])
    );
  });

  it('marks a failed attempt as contradicting a successful fix for the same context', () => {
    const fix = entry({ id: 'fix', kind: 'successful_fix' });
    const failed = entry({ id: 'failed', kind: 'failed_attempt' });
    const relations = inferRelations(failed, [fix]);
    expect(relations).toEqual(expect.arrayContaining([{ type: 'contradicts', targetId: 'fix' }]));
  });

  it('detects applies_to when files + framework overlap', () => {
    const a = entry({
      id: 'a',
      symptoms: { summary: 'totally different wording here about layout', errorMessages: [] },
      rootCause: 'css',
    });
    const b = entry({
      id: 'b',
      symptoms: { summary: 'unrelated phrasing about spacing', errorMessages: [] },
      rootCause: 'flex',
    });
    const relations = inferRelations(a, [b]);
    expect(relations).toEqual(expect.arrayContaining([{ type: 'applies_to', targetId: 'b' }]));
  });

  it('skips self, cross-project, and archived targets', () => {
    const a = entry({ id: 'a' });
    const archived = entry({ id: 'b', status: 'archived' });
    const otherProject = entry({ id: 'c', projectId: 'other' });
    expect(inferRelations(a, [a, archived, otherProject])).toEqual([]);
  });
});

describe('recomputeAllRelations', () => {
  it('produces relations keyed by id for every entry', () => {
    const a = entry({ id: 'a' });
    const b = entry({ id: 'b' });
    const map = recomputeAllRelations([a, b]);
    expect(map.get('a')?.length).toBeGreaterThan(0);
    expect(map.get('b')?.length).toBeGreaterThan(0);
  });
});

describe('enrichSuggestions', () => {
  const suggestion = (entryId: string): ExperienceSuggestion => ({
    entryId,
    score: 0.8,
    kind: 'successful_fix',
    symptom: 's',
    lesson: 'l',
    whyRelevant: [],
    caution: ['base caution'],
    suggestedChecks: [],
  });

  it('attaches related lessons and a contradiction caution', () => {
    const sourceById = new Map([
      [
        'a',
        {
          id: 'a',
          kind: 'successful_fix' as const,
          status: 'active' as const,
          lesson: 'fix lesson',
          relations: [{ type: 'contradicts' as const, targetId: 'b' }],
        },
      ],
      [
        'b',
        { id: 'b', kind: 'failed_attempt' as const, status: 'active' as const, lesson: 'do not do X', relations: [] },
      ],
    ]);
    const [enriched] = enrichSuggestions([suggestion('a')], sourceById);
    expect(enriched.related?.[0]).toEqual({
      entryId: 'b',
      relation: 'contradicts',
      kind: 'failed_attempt',
      lesson: 'do not do X',
    });
    expect(enriched.caution[0]).toMatch(/CONTRADICTS/);
  });

  it('drops archived neighbours and leaves suggestions without relations untouched', () => {
    const sourceById = new Map([
      [
        'a',
        {
          id: 'a',
          kind: 'successful_fix' as const,
          status: 'active' as const,
          lesson: 'l',
          relations: [{ type: 'same_symptom_as' as const, targetId: 'gone' }],
        },
      ],
      ['gone', { id: 'gone', kind: 'lesson' as const, status: 'archived' as const, lesson: 'x', relations: [] }],
    ]);
    const [enriched] = enrichSuggestions([suggestion('a')], sourceById);
    expect(enriched.related).toBeUndefined();
  });
});
