/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createIdeHookStore, workspaceKey, type HookFs } from '@/process/ide/hooks/ideHookStore';

/** An in-memory fs double matching the store's HookFs contract. */
const makeFs = (seed: Record<string, string> = {}): { fs: HookFs; files: Map<string, string> } => {
  const files = new Map<string, string>(Object.entries(seed));
  const fs: HookFs = {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (oldPath, newPath) => {
      const v = files.get(oldPath);
      if (v !== undefined) {
        files.set(newPath, v);
        files.delete(oldPath);
      }
    },
    mkdir: async () => undefined,
  };
  return { fs, files };
};

describe('workspaceKey', () => {
  it('is stable and slash/case-insensitive', () => {
    expect(workspaceKey('C:/Repo')).toBe(workspaceKey('c:\\repo'));
    expect(workspaceKey('/a')).not.toBe(workspaceKey('/b'));
  });
});

describe('createIdeHookStore', () => {
  it('starts empty when no file exists', async () => {
    const { fs } = makeFs();
    const store = createIdeHookStore({ rootPath: '/repo', dir: '/data', fs });
    expect(await store.list()).toEqual([]);
  });

  it('saves, lists, gets, patches and removes a hook', async () => {
    const { fs } = makeFs();
    let id = 0;
    const store = createIdeHookStore({
      rootPath: '/repo',
      dir: '/data',
      fs,
      now: () => 1000,
      newId: () => `id-${++id}`,
    });

    const saved = await store.save({
      name: 'Lint on save',
      event: 'fileSaved',
      action: 'runCommand',
      command: 'npm run lint',
      filePatterns: ['*.ts'],
    });
    expect(saved.id).toBe('id-1');
    expect(saved.enabled).toBe(true);

    expect(await store.list()).toHaveLength(1);
    expect((await store.get('id-1'))?.name).toBe('Lint on save');

    const patched = await store.patch('id-1', { enabled: false, lastRunAt: 2000 });
    expect(patched?.enabled).toBe(false);
    expect(patched?.lastRunAt).toBe(2000);

    expect(await store.remove('id-1')).toEqual([]);
  });

  it('persists across instances (same dir + root)', async () => {
    const { fs, files } = makeFs();
    const a = createIdeHookStore({ rootPath: '/repo', dir: '/data', fs, newId: () => 'fixed' });
    await a.save({ name: 'H' });
    // A fresh store reads the same persisted file.
    const b = createIdeHookStore({ rootPath: '/repo', dir: '/data', fs });
    const list = await b.load();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('H');
    // The file is keyed by workspace hash under the dir.
    expect([...files.keys()].some((k) => k.includes(workspaceKey('/repo')))).toBe(true);
  });

  it('isolates hooks per workspace root', async () => {
    const { fs } = makeFs();
    const a = createIdeHookStore({ rootPath: '/repoA', dir: '/data', fs, newId: () => 'a' });
    const b = createIdeHookStore({ rootPath: '/repoB', dir: '/data', fs, newId: () => 'b' });
    await a.save({ name: 'A-hook' });
    expect(await b.list()).toEqual([]);
  });

  it('drops malformed records and survives a corrupt file', async () => {
    const key = workspaceKey('/repo');
    const { fs } = makeFs({ [join('/data', `${key}.json`)]: '[{"no":"name"},{"name":"Good"}]' });
    const store = createIdeHookStore({ rootPath: '/repo', dir: '/data', fs });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Good');
  });

  it('notifies onChange listeners', async () => {
    const { fs } = makeFs();
    const store = createIdeHookStore({ rootPath: '/repo', dir: '/data', fs, newId: () => 'x' });
    const listener = vi.fn();
    store.onChange(listener);
    await store.save({ name: 'H' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
