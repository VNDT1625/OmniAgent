/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store imports `electron` for the lazy userData fallback; tests always pass
// a `rootDir`, so `app.getPath` is never called — a minimal mock suffices.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aionui-rtk-test' } }));

import { createRtkStore, type RtkStoreFs } from '@/process/knowledge/realtime/rtkStore';
import type { KnowledgeFact } from '@/process/knowledge/realtime/rtkTypes';

/** A trivial in-memory filesystem implementing the store's fs seam. */
const createMemoryFs = (): RtkStoreFs & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return {
    files,
    readFile: (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      return Promise.resolve(value);
    },
    writeFile: (filePath, data) => {
      files.set(filePath, data);
      return Promise.resolve();
    },
    rename: (oldPath, newPath) => {
      const value = files.get(oldPath);
      if (value !== undefined) {
        files.set(newPath, value);
        files.delete(oldPath);
      }
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(undefined),
  };
};

const makeFact = (over: Partial<KnowledgeFact> = {}): KnowledgeFact => ({
  id: 'f1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  topic: 'nodejs.lts.version',
  question: 'latest node lts?',
  aliases: [],
  value: '22.x',
  volatilityClass: 'version',
  ttlMs: 1000,
  validAsOf: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  sources: [],
  confidence: 0.6,
  freshness: 'fresh',
  history: [],
  tags: [],
  embeddingText: 'Topic: nodejs.lts.version',
  status: 'active',
  ...over,
});

describe('rtkStore', () => {
  let fs: ReturnType<typeof createMemoryFs>;
  let store: ReturnType<typeof createRtkStore>;

  beforeEach(() => {
    fs = createMemoryFs();
    store = createRtkStore({ rootDir: '/data', fs });
  });

  it('upserts and gets a fact', async () => {
    await store.upsert(makeFact());
    expect((await store.get('f1'))?.value).toBe('22.x');
  });

  it('replaces an existing fact on upsert by id', async () => {
    await store.upsert(makeFact());
    await store.upsert(makeFact({ value: '24.x' }));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0].value).toBe('24.x');
  });

  it('finds by topic', async () => {
    await store.upsert(makeFact());
    expect((await store.byTopic('nodejs.lts.version'))?.id).toBe('f1');
    expect(await store.byTopic('missing')).toBeNull();
  });

  it('patches an existing fact and throws for unknown id', async () => {
    await store.upsert(makeFact());
    const patched = await store.patch('f1', { value: 'patched' });
    expect(patched.value).toBe('patched');
    await expect(store.patch('nope', { value: 'x' })).rejects.toThrow(/unknown fact/i);
  });

  it('filters by status, expiry and topic prefix', async () => {
    await store.upsert(makeFact({ id: 'a', topic: 'node.v', status: 'active', expiresAt: '2026-01-01T00:00:00.000Z' }));
    await store.upsert(makeFact({ id: 'b', topic: 'node.x', status: 'archived', expiresAt: '2030-01-01T00:00:00.000Z' }));
    expect((await store.list({ status: 'active' })).map((f) => f.id)).toEqual(['a']);
    expect((await store.list({ expiredBefore: '2027-01-01T00:00:00.000Z' })).map((f) => f.id)).toEqual(['a']);
    expect((await store.list({ topicPrefix: 'node.' })).length).toBe(2);
  });

  it('removes a fact', async () => {
    await store.upsert(makeFact());
    expect(await store.remove('f1')).toBe(true);
    expect(await store.remove('f1')).toBe(false);
    expect(await store.get('f1')).toBeNull();
  });

  it('persists relations', async () => {
    await store.setRelations([{ fromId: 'a', toId: 'b', kind: 'supersedes' }]);
    expect(await store.relations()).toEqual([{ fromId: 'a', toId: 'b', kind: 'supersedes' }]);
  });

  it('starts empty when the file does not exist', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('writes atomically (tmp then rename) leaving only the final file', async () => {
    await store.upsert(makeFact());
    const paths = [...fs.files.keys()];
    expect(paths.some((p) => p.endsWith('facts.json'))).toBe(true);
    expect(paths.some((p) => p.endsWith('.tmp'))).toBe(false);
  });
});
