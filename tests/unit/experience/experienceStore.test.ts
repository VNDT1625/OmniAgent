/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the file-based ExperienceStore (in-memory fs).
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createExperienceStore } from '@/process/experience/experienceStore';
import type { ExperienceEntry } from '@/process/experience/experienceTypes';
import { createMemFs } from './memFs';

const ROOT = path.join('exp-root');

const makeEntry = (overrides: Partial<ExperienceEntry> = {}): ExperienceEntry => ({
  id: 'exp_1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  projectId: 'proj_a',
  kind: 'successful_fix',
  symptoms: { summary: 'boom', errorMessages: [] },
  context: { repoArea: [], files: [], commands: [], frameworks: [], packages: [] },
  lesson: 'do better',
  verification: { commands: [], confidenceEvidence: [] },
  tags: ['ts'],
  confidence: 0.5,
  relatedEntryIds: [],
  relations: [],
  embeddingText: 'Kind: successful_fix',
  status: 'active',
  ...overrides,
});

describe('createExperienceStore', () => {
  it('creates then reads an entry back by id', async () => {
    const fsImpl = createMemFs();
    const store = createExperienceStore({ rootDir: ROOT, fs: fsImpl });

    await store.create(makeEntry());
    const got = await store.get('exp_1');

    expect(got?.id).toBe('exp_1');
    expect(fsImpl.files.has(path.join(ROOT, 'proj_a', 'entries', 'exp_1.json'))).toBe(true);
  });

  it('returns null for a missing entry', async () => {
    const store = createExperienceStore({ rootDir: ROOT, fs: createMemFs() });
    expect(await store.get('nope')).toBeNull();
  });

  it('updates an entry while preserving id and createdAt', async () => {
    const store = createExperienceStore({ rootDir: ROOT, fs: createMemFs() });
    await store.create(makeEntry());

    const updated = await store.update('exp_1', { status: 'archived', createdAt: 'HACKED' as unknown as string });

    expect(updated.status).toBe('archived');
    expect(updated.createdAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('throws when updating an unknown entry', async () => {
    const store = createExperienceStore({ rootDir: ROOT, fs: createMemFs() });
    await expect(store.update('ghost', { confidence: 1 })).rejects.toThrow(/unknown entry/);
  });

  it('removes an entry', async () => {
    const store = createExperienceStore({ rootDir: ROOT, fs: createMemFs() });
    await store.create(makeEntry());
    await store.remove('exp_1');
    expect(await store.get('exp_1')).toBeNull();
  });

  it('filters by projectId, kind, status, and tags', async () => {
    const store = createExperienceStore({ rootDir: ROOT, fs: createMemFs() });
    await store.create(makeEntry({ id: 'exp_1', projectId: 'proj_a', tags: ['ts', 'vitest'] }));
    await store.create(makeEntry({ id: 'exp_2', projectId: 'proj_a', kind: 'agent_mistake', status: 'archived' }));
    await store.create(makeEntry({ id: 'exp_3', projectId: 'proj_b' }));

    expect((await store.searchMetadata({ projectId: 'proj_a' })).map((entry) => entry.id).sort()).toEqual(['exp_1', 'exp_2']);
    expect((await store.searchMetadata({ kind: 'agent_mistake' })).map((entry) => entry.id)).toEqual(['exp_2']);
    expect((await store.searchMetadata({ status: 'active', projectId: 'proj_a' })).map((entry) => entry.id)).toEqual(['exp_1']);
    expect((await store.searchMetadata({ tags: ['vitest'] })).map((entry) => entry.id)).toEqual(['exp_1']);
  });

  it('returns [] before anything is written', async () => {
    const store = createExperienceStore({ rootDir: ROOT, fs: createMemFs() });
    expect(await store.searchMetadata()).toEqual([]);
  });

  it('rejects unsafe ids', async () => {
    const store = createExperienceStore({ rootDir: ROOT, fs: createMemFs() });
    await expect(store.create(makeEntry({ id: '../escape' }))).rejects.toThrow(/Invalid entryId/);
  });
});
