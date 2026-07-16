/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/terminal/terminalScheduleStore — CRUD + atomic persist
 * + defensive read. Uses an in-memory fake fs so no disk is touched.
 */

import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { createTerminalScheduleStore, type ScheduleFs } from '@/process/terminal/terminalScheduleStore';

/** A minimal in-memory fs that records the tmp+rename atomic write pattern. */
const makeFakeFs = (seed?: Record<string, string>) => {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  const fs: ScheduleFs = {
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (oldPath, newPath) => {
      const data = files.get(oldPath)!;
      files.delete(oldPath);
      files.set(newPath, data);
    },
    mkdir: vi.fn(async () => undefined),
  };
  return { fs, files };
};

const dir = '/data';
const file = path.join(dir, 'terminal-schedules.json');

describe('terminalScheduleStore', () => {
  it('returns an empty list when the file does not exist', async () => {
    const { fs } = makeFakeFs();
    const store = createTerminalScheduleStore({ dir, fs });
    expect(await store.list()).toEqual([]);
  });

  it('saves a new schedule and assigns an id + timestamps', async () => {
    const { fs, files } = makeFakeFs();
    const store = createTerminalScheduleStore({ dir, fs, now: () => 123, newId: () => 'new-id' });

    const saved = await store.save({ name: 'Launch 9router', script: '9router start' });

    expect(saved.id).toBe('new-id');
    expect(saved.createdAt).toBe(123);
    expect(saved.enabled).toBe(true);
    // Persisted atomically (tmp renamed to the final file).
    expect(files.has(file)).toBe(true);
    const persisted = JSON.parse(files.get(file)!) as unknown[];
    expect(persisted).toHaveLength(1);
  });

  it('updates an existing schedule in place', async () => {
    const { fs } = makeFakeFs();
    const store = createTerminalScheduleStore({ dir, fs, newId: () => 'id-1' });
    const created = await store.save({ name: 'A', script: 'x' });

    const updated = await store.save({ id: created.id, name: 'B', script: 'y' });

    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('B');
    expect(await store.list()).toHaveLength(1);
  });

  it('patch updates only the given runtime fields', async () => {
    const { fs } = makeFakeFs();
    const store = createTerminalScheduleStore({ dir, fs, newId: () => 'id-1' });
    const created = await store.save({ name: 'A', script: 'x' });

    const patched = await store.patch(created.id, { lastStatus: 'ok', lastRunAt: 999 });

    expect(patched?.lastStatus).toBe('ok');
    expect(patched?.lastRunAt).toBe(999);
    expect(patched?.name).toBe('A');
  });

  it('remove deletes a schedule', async () => {
    const { fs } = makeFakeFs();
    const store = createTerminalScheduleStore({ dir, fs, newId: () => 'id-1' });
    const created = await store.save({ name: 'A', script: 'x' });

    const remaining = await store.remove(created.id);

    expect(remaining).toEqual([]);
  });

  it('drops malformed records when reading a corrupt file', async () => {
    const seed = {
      [file]: JSON.stringify([{ name: 'ok', script: 'run', kind: 'cron' }, { bogus: true }, 42]),
    };
    const { fs } = makeFakeFs(seed);
    const store = createTerminalScheduleStore({ dir, fs });

    const list = await store.list();

    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('ok');
  });

  it('notifies onChange listeners after a mutation', async () => {
    const { fs } = makeFakeFs();
    const store = createTerminalScheduleStore({ dir, fs, newId: () => 'id-1' });
    const listener = vi.fn();
    store.onChange(listener);

    await store.save({ name: 'A', script: 'x' });

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
