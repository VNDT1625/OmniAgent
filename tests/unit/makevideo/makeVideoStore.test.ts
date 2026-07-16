/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/makevideo/makeVideoStore — the file-based CRUD store
 * for the Make Video feature (AI movie/anime projects).
 *
 * Covers:
 * - save/list/get/remove/updateScene round-trip persisted atomically using an
 *   in-memory fs (tmp file written then renamed, no leftover .tmp).
 * - Defensive load: corrupt JSON / missing file yields an empty list, never a
 *   throw; malformed records are dropped.
 * - onChange fires after a mutation.
 *
 * No real disk or live Electron `app` is touched.
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { MakeVideoFs } from '@/process/makevideo/makeVideoStore';
import { createMakeVideoStore } from '@/process/makevideo/makeVideoStore';
import type { Scene, VideoProject } from '@/process/makevideo/makeVideoTypes';

/** In-memory {@link MakeVideoFs} modelling a path→contents map, recording write order. */
const createMemFs = (seed?: Record<string, string>): MakeVideoFs & { files: Map<string, string>; ops: string[] } => {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  const ops: string[] = [];
  return {
    files,
    ops,
    readFile: async (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        const error = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    },
    writeFile: async (filePath, data) => {
      ops.push(`write:${filePath}`);
      files.set(filePath, data);
    },
    rename: async (oldPath, newPath) => {
      ops.push(`rename:${oldPath}->${newPath}`);
      const content = files.get(oldPath);
      if (content === undefined) {
        const error = new Error(`ENOENT: ${oldPath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      files.set(newPath, content);
      files.delete(oldPath);
    },
    mkdir: async (dirPath) => dirPath,
  };
};

const ROOT = path.join('mkv-root');
const DATA_FILE = path.join(ROOT, 'make-video-projects.json');

/** Deterministic id generator for stable assertions. */
const seqIds = () => {
  let n = 0;
  return () => `id-${++n}`;
};

/** Build a project with a single scene for fixtures. */
const makeProject = (overrides?: Partial<VideoProject>): VideoProject => {
  const scene: Scene = {
    id: 's1',
    index: 0,
    title: 'Opening',
    narration: 'Once upon a time',
    imagePrompt: 'wide shot, golden hour',
    imagePath: null,
    imageError: null,
  };
  return {
    id: 'p1',
    topic: 'A lonely robot',
    style: 'anime',
    language: 'English',
    scenes: [scene],
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
};

describe('createMakeVideoStore — CRUD round-trip', () => {
  it('saves a project and persists it atomically (no leftover .tmp)', async () => {
    const fsImpl = createMemFs();
    const store = createMakeVideoStore({ dir: ROOT, fs: fsImpl, now: () => 1000, newId: seqIds() });

    const saved = await store.save(makeProject());
    expect(saved.id).toBe('p1');
    expect(saved.updatedAt).toBe(1000);

    expect(fsImpl.files.has(DATA_FILE)).toBe(true);
    expect(fsImpl.files.has(`${DATA_FILE}.tmp`)).toBe(false);

    // A fresh store reading the same fs sees the project (round-trip).
    const store2 = createMakeVideoStore({ dir: ROOT, fs: fsImpl });
    const list = await store2.list();
    expect(list).toHaveLength(1);
    expect(list[0].topic).toBe('A lonely robot');
  });

  it('writes the tmp file BEFORE renaming it into place (atomic order)', async () => {
    const fsImpl = createMemFs();
    const store = createMakeVideoStore({ dir: ROOT, fs: fsImpl, now: () => 1, newId: seqIds() });

    await store.save(makeProject());

    expect(fsImpl.ops).toEqual([`write:${DATA_FILE}.tmp`, `rename:${DATA_FILE}.tmp->${DATA_FILE}`]);
  });

  it('upserts: saving an existing id replaces it and preserves createdAt', async () => {
    const fsImpl = createMemFs();
    let clock = 100;
    const store = createMakeVideoStore({ dir: ROOT, fs: fsImpl, now: () => clock, newId: seqIds() });

    await store.save(makeProject({ createdAt: 100, updatedAt: 100 }));
    clock = 500;
    const updated = await store.save(makeProject({ topic: 'A brave robot' }));

    expect(updated.topic).toBe('A brave robot');
    expect(updated.createdAt).toBe(100); // preserved from first save
    expect(updated.updatedAt).toBe(500); // bumped to current clock

    const list = await store.list();
    expect(list).toHaveLength(1);
  });

  it('get returns a project by id and null when missing', async () => {
    const fsImpl = createMemFs();
    const store = createMakeVideoStore({ dir: ROOT, fs: fsImpl, now: () => 1, newId: seqIds() });
    await store.save(makeProject());

    expect(await store.get('p1')).not.toBeNull();
    expect(await store.get('nope')).toBeNull();
  });

  it('removes a project by id', async () => {
    const fsImpl = createMemFs();
    const store = createMakeVideoStore({ dir: ROOT, fs: fsImpl, now: () => 1, newId: seqIds() });
    await store.save(makeProject({ id: 'p1' }));
    await store.save(makeProject({ id: 'p2', topic: 'Second' }));

    const remaining = await store.remove('p1');
    expect(remaining.map((p) => p.id)).toEqual(['p2']);
    expect(await store.get('p1')).toBeNull();
  });

  it('updateScene patches one scene and bumps updatedAt; returns null for unknown project', async () => {
    const fsImpl = createMemFs();
    let clock = 100;
    const store = createMakeVideoStore({ dir: ROOT, fs: fsImpl, now: () => clock, newId: seqIds() });
    await store.save(makeProject());

    clock = 900;
    const updated = await store.updateScene('p1', 's1', { imagePath: '/tmp/img.png', imageError: null });
    expect(updated).not.toBeNull();
    expect(updated?.scenes[0].imagePath).toBe('/tmp/img.png');
    expect(updated?.scenes[0].id).toBe('s1'); // id is never overwritten
    expect(updated?.updatedAt).toBe(900);

    expect(await store.updateScene('ghost', 's1', { imagePath: 'x' })).toBeNull();
  });
});

describe('createMakeVideoStore — defensive load', () => {
  it('returns an empty list when the file is missing', async () => {
    const store = createMakeVideoStore({ dir: ROOT, fs: createMemFs() });
    expect(await store.load()).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it('returns an empty list when the JSON is corrupt', async () => {
    const store = createMakeVideoStore({ dir: ROOT, fs: createMemFs({ [DATA_FILE]: '[ not json' }) });
    expect(await store.load()).toEqual([]);
  });

  it('drops malformed project records but keeps valid ones', async () => {
    const seed = JSON.stringify([
      { id: 'good', topic: 'ok', style: 'noir', language: 'English', scenes: [], createdAt: 1, updatedAt: 2 },
      { topic: 'no id — dropped' },
      42,
      null,
    ]);
    const store = createMakeVideoStore({ dir: ROOT, fs: createMemFs({ [DATA_FILE]: seed }) });
    const list = await store.load();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('good');
  });

  it('fires onChange after a mutation with the new list', async () => {
    const fsImpl = createMemFs();
    const store = createMakeVideoStore({ dir: ROOT, fs: fsImpl, now: () => 1, newId: seqIds() });
    const listener = vi.fn();
    const off = store.onChange(listener);

    await store.save(makeProject());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toHaveLength(1);

    off();
    await store.save(makeProject({ id: 'p2' }));
    expect(listener).toHaveBeenCalledTimes(1); // unsubscribed
  });
});
