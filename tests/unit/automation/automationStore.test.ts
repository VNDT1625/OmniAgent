/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { createAutomationStore, type AutomationFs } from '@/process/automation/automationStore';
import type { Workflow } from '@/process/automation/automationTypes';

/** An in-memory `AutomationFs` that records the order of write/rename calls. */
const createMemoryFs = (
  seed: Record<string, string> = {}
): { fs: AutomationFs; files: Map<string, string>; ops: string[] } => {
  const files = new Map<string, string>(Object.entries(seed));
  const ops: string[] = [];
  const fs: AutomationFs = {
    readFile: async (filePath) => {
      if (!files.has(filePath)) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(filePath) as string;
    },
    writeFile: async (filePath, data) => {
      ops.push(`write:${filePath}`);
      files.set(filePath, data);
    },
    rename: async (oldPath, newPath) => {
      ops.push(`rename:${oldPath}->${newPath}`);
      const value = files.get(oldPath);
      if (value !== undefined) {
        files.set(newPath, value);
        files.delete(oldPath);
      }
    },
    mkdir: async () => undefined,
  };
  return { fs, files, ops };
};

const DIR = '/tmp/automation';
const FILE = path.join(DIR, 'automation-workflows.json');

/** Deterministic id generator. */
const makeIds = (): (() => string) => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('createAutomationStore', () => {
  it('saves a new workflow and lists it back', async () => {
    const { fs } = createMemoryFs();
    const store = createAutomationStore({ dir: DIR, fs, now: () => 1000, newId: makeIds() });

    const saved = await store.save({ name: 'My flow' });
    expect(saved.id).toBe('id-1');
    expect(saved.createdAt).toBe(1000);
    expect(saved.updatedAt).toBe(1000);
    expect(saved.enabled).toBe(true);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('My flow');
  });

  it('upserts an existing workflow by id (preserving createdAt, bumping updatedAt)', async () => {
    const { fs } = createMemoryFs();
    let clock = 1000;
    const store = createAutomationStore({ dir: DIR, fs, now: () => clock, newId: makeIds() });

    const created = await store.save({ name: 'Flow' });
    clock = 2000;
    const updated = await store.save({ id: created.id, name: 'Flow renamed' });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(1000);
    expect(updated.updatedAt).toBe(2000);

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Flow renamed');
  });

  it('gets a workflow by id and returns undefined for unknown ids', async () => {
    const { fs } = createMemoryFs();
    const store = createAutomationStore({ dir: DIR, fs, now: () => 1, newId: makeIds() });

    const saved = await store.save({ name: 'Flow' });
    expect(await store.get(saved.id)).toMatchObject({ name: 'Flow' });
    expect(await store.get('missing')).toBeUndefined();
  });

  it('removes a workflow by id', async () => {
    const { fs } = createMemoryFs();
    const store = createAutomationStore({ dir: DIR, fs, now: () => 1, newId: makeIds() });

    const a = await store.save({ name: 'A' });
    await store.save({ name: 'B' });
    const remaining = await store.remove(a.id);

    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe('B');
    expect(await store.get(a.id)).toBeUndefined();
  });

  it('writes atomically: tmp write then rename into place', async () => {
    const { fs, ops } = createMemoryFs();
    const store = createAutomationStore({ dir: DIR, fs, now: () => 1, newId: makeIds() });

    await store.save({ name: 'Flow' });

    expect(ops).toEqual([`write:${FILE}.tmp`, `rename:${FILE}.tmp->${FILE}`]);
  });

  it('reads an existing file on load', async () => {
    const existing: Workflow[] = [
      { id: 'w1', name: 'Persisted', nodes: [], enabled: true, createdAt: 5, updatedAt: 5 },
    ];
    const { fs } = createMemoryFs({ [FILE]: JSON.stringify(existing) });
    const store = createAutomationStore({ dir: DIR, fs, now: () => 1, newId: makeIds() });

    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('w1');
    expect(list[0].name).toBe('Persisted');
  });

  it('defensively returns an empty list for corrupt JSON', async () => {
    const { fs } = createMemoryFs({ [FILE]: '{ this is not valid json' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = createAutomationStore({ dir: DIR, fs, now: () => 1, newId: makeIds() });

    expect(await store.list()).toEqual([]);
    warn.mockRestore();
  });

  it('drops malformed records but keeps valid ones', async () => {
    const raw = JSON.stringify([
      { id: 'good', name: 'Good', nodes: [], enabled: true, createdAt: 1, updatedAt: 1 },
      { id: 'no-name' },
      { id: 'bad-nodes', name: 'Has bad node', nodes: [{ kind: 'not-a-kind' }, { kind: 'action.log', name: 'Log' }] },
      'totally-wrong',
    ]);
    const { fs } = createMemoryFs({ [FILE]: raw });
    const store = createAutomationStore({ dir: DIR, fs, now: () => 7, newId: makeIds() });

    const list = await store.list();
    expect(list.map((w) => w.name)).toEqual(['Good', 'Has bad node']);
    const withNodes = list.find((w) => w.name === 'Has bad node');
    expect(withNodes?.nodes).toHaveLength(1);
    expect(withNodes?.nodes[0].kind).toBe('action.log');
  });

  it('fires onChange listeners after a mutation and stops after unsubscribe', async () => {
    const { fs } = createMemoryFs();
    const store = createAutomationStore({ dir: DIR, fs, now: () => 1, newId: makeIds() });

    const seen: number[] = [];
    const unsubscribe = store.onChange((workflows) => seen.push(workflows.length));

    await store.save({ name: 'A' });
    await store.save({ name: 'B' });
    expect(seen).toEqual([1, 2]);

    unsubscribe();
    await store.save({ name: 'C' });
    expect(seen).toEqual([1, 2]);
  });
});
