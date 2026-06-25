/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the MTUI projection layer of the ExpBase engine.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendInbox,
  buildProjection,
  clearInbox,
  MTUI_EXP_DIR,
  readInbox,
  readProjection,
  toProjectionEntry,
  writeProjection,
} from '@/process/experience/experienceProjection';
import type { ExperienceEntry, ExperienceInboxItem } from '@/process/experience/experienceTypes';
import { createMemFs } from './memFs';

const ROOT = path.join('proj-root');

const entry = (overrides: Partial<ExperienceEntry> = {}): ExperienceEntry => ({
  id: 'exp_1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-08T00:00:00.000Z',
  projectId: 'proj_a',
  kind: 'successful_fix',
  symptoms: { summary: 'tsc fails', errorMessages: ['TS2345'] },
  context: { repoArea: ['ide'], files: ['a.ts'], commands: ['bunx tsc'], frameworks: ['typescript'], packages: ['typescript'], errorCategory: 'compile' },
  rootCause: 'wrong type',
  lesson: 'annotate generics',
  verification: { commands: [{ command: 'bunx tsc', outcome: 'passed' }], confidenceEvidence: ['clean'] },
  tags: ['ts'],
  confidence: 0.8,
  relatedEntryIds: [],
  relations: [],
  embeddingText: 'Kind: successful_fix',
  status: 'active',
  ...overrides,
});

describe('toProjectionEntry', () => {
  it('flattens an entry and derives lexicalText, caution, and checks', () => {
    const projected = toProjectionEntry(entry());
    expect(projected.symptom).toBe('tsc fails');
    expect(projected.verificationStrength).toBeGreaterThan(0.4);
    expect(projected.lexicalText).toContain('typescript');
    expect(projected.suggestedChecks).toContain('Run: bunx tsc');
    expect(projected.caution.length).toBeGreaterThan(0);
  });

  it('adds a strong caution for failed attempts', () => {
    const projected = toProjectionEntry(entry({ kind: 'failed_attempt' }));
    expect(projected.caution.join(' ')).toMatch(/did NOT work/);
  });
});

describe('buildProjection', () => {
  it('captures dimensions from the first vectored entry', () => {
    const projection = buildProjection([entry({ id: 'a' }), entry({ id: 'b', vector: [0, 1, 0] })], { now: () => 123, providerId: 'p', model: 'm' });
    expect(projection.dimensions).toBe(3);
    expect(projection.providerId).toBe('p');
    expect(projection.builtAt).toBe(123);
    expect(projection.entries.length).toBe(2);
  });

  it('reports dimensions 0 when no entry has a vector', () => {
    expect(buildProjection([entry()]).dimensions).toBe(0);
  });
});

describe('writeProjection / readProjection', () => {
  it('round-trips the projection file under .mtui/exp/index.json', async () => {
    const fsImpl = createMemFs();
    const projection = buildProjection([entry()], { now: () => 1 });
    const filePath = await writeProjection(ROOT, projection, fsImpl);

    expect(filePath).toBe(path.join(ROOT, MTUI_EXP_DIR, 'index.json'));
    const read = await readProjection(ROOT, fsImpl);
    expect(read?.entries[0].id).toBe('exp_1');
  });

  it('readProjection returns null when absent', async () => {
    expect(await readProjection(ROOT, createMemFs())).toBeNull();
  });
});

describe('inbox', () => {
  it('appends and reads back drafts, tolerating malformed lines', async () => {
    const fsImpl = createMemFs();
    const item: ExperienceInboxItem = { receivedAt: '2026-06-09T00:00:00.000Z', draft: { projectId: 'proj_a', kind: 'lesson', symptoms: { summary: 'note' } } };
    await appendInbox(ROOT, item, fsImpl);
    await appendInbox(ROOT, item, fsImpl);

    // Corrupt one line to prove tolerance.
    const inboxPath = path.join(ROOT, MTUI_EXP_DIR, 'inbox.jsonl');
    fsImpl.files.set(inboxPath, `${fsImpl.files.get(inboxPath)}not-json\n`);

    const items = await readInbox(ROOT, fsImpl);
    expect(items.length).toBe(2);
    expect(items[0].draft.symptoms.summary).toBe('note');
  });

  it('clearInbox empties the queue', async () => {
    const fsImpl = createMemFs();
    await appendInbox(ROOT, { receivedAt: 'x', draft: { projectId: 'p', kind: 'lesson', symptoms: { summary: 's' } } }, fsImpl);
    await clearInbox(ROOT, fsImpl);
    expect(await readInbox(ROOT, fsImpl)).toEqual([]);
  });

  it('readInbox returns [] when absent', async () => {
    expect(await readInbox(ROOT, createMemFs())).toEqual([]);
  });
});
