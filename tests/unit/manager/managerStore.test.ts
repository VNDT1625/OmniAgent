/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/manager/managerStore — the file-based CRUD store for
 * the Personal Manager feature (tasks/notes/events/settings).
 *
 * Covers:
 * - CRUD round-trip persisted atomically (Property 2) using an in-memory fs.
 * - Defensive load: corrupt JSON / missing file / malformed records yield a
 *   valid empty-or-filtered document, never a throw (Property 3).
 * - Recurring task completion spawns the next occurrence (criterion 1.3b).
 *
 * No real disk or live Electron `app` is touched.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ManagerFs } from '@/process/manager/managerStore';
import { createManagerStore } from '@/process/manager/managerStore';

/** In-memory {@link ManagerFs} modelling a path→contents map + dir set. */
const createMemFs = (seed?: Record<string, string>): ManagerFs & { files: Map<string, string> } => {
  const files = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    files,
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
      files.set(filePath, data);
    },
    rename: async (oldPath, newPath) => {
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

const ROOT = path.join('mgr-root');
const DATA_FILE = path.join(ROOT, 'manager-data.json');

/** Deterministic id generator for stable assertions. */
const seqIds = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe('createManagerStore — CRUD round-trip (Property 2)', () => {
  it('adds a task and persists it atomically (no leftover .tmp)', async () => {
    const fsImpl = createMemFs();
    const store = createManagerStore({ dir: ROOT, fs: fsImpl, now: () => 1000, newId: seqIds() });

    const task = await store.addTask({ title: 'Write spec', priority: 'high', kind: 'oneoff' });
    expect(task.id).toBe('id-1');
    expect(task.title).toBe('Write spec');

    // Persisted to the real path, and the tmp file was renamed away.
    expect(fsImpl.files.has(DATA_FILE)).toBe(true);
    expect(fsImpl.files.has(`${DATA_FILE}.tmp`)).toBe(false);

    // A fresh store reading the same fs sees the task (round-trip).
    const store2 = createManagerStore({ dir: ROOT, fs: fsImpl });
    const data = await store2.load();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].title).toBe('Write spec');
  });

  it('updates, completes, and removes a task', async () => {
    const fsImpl = createMemFs();
    const store = createManagerStore({ dir: ROOT, fs: fsImpl, now: () => 2000, newId: seqIds() });

    const task = await store.addTask({ title: 'A' });
    await store.updateTask(task.id, { priority: 'urgent' });
    let data = await store.setTaskStatus(task.id, 'done');
    expect(data.tasks[0].priority).toBe('urgent');
    expect(data.tasks[0].status).toBe('done');
    expect(data.tasks[0].completedAt).toBe(2000);

    data = await store.removeTask(task.id);
    expect(data.tasks).toHaveLength(0);
  });

  it('toggles a subtask independently', async () => {
    const fsImpl = createMemFs();
    const store = createManagerStore({ dir: ROOT, fs: fsImpl, newId: seqIds() });
    const task = await store.addTask({ title: 'Parent', subtasks: [{ title: 'child' }] });
    const subId = task.subtasks[0].id;
    const data = await store.toggleSubtask(task.id, subId);
    expect(data.tasks[0].subtasks[0].done).toBe(true);
  });

  it('handles notes and events CRUD + setEvents replace', async () => {
    const fsImpl = createMemFs();
    const store = createManagerStore({ dir: ROOT, fs: fsImpl, now: () => 5, newId: seqIds() });

    const note = await store.addNote({ body: '# idea', tags: ['x'] });
    expect(note.body).toBe('# idea');

    const ev = await store.addEvent({
      title: 'Class',
      startAt: 100,
      endAt: 200,
      lockKind: 'fixed',
      source: 'image',
    });
    expect(ev.lockKind).toBe('fixed');

    const replaced = await store.setEvents([{ ...ev, title: 'Class B' }]);
    expect(replaced.events).toHaveLength(1);
    expect(replaced.events[0].title).toBe('Class B');
  });

  it('stores notes in the three categories with their fields', async () => {
    const fsImpl = createMemFs();
    const store = createManagerStore({ dir: ROOT, fs: fsImpl, now: () => 7, newId: seqIds() });

    const daily = await store.addNote({ category: 'daily', body: 'today' });
    expect(daily.category).toBe('daily');
    expect(daily.dayAt).toBe(7); // defaults to now for daily

    const learn = await store.addNote({
      category: 'learn',
      title: 'SR',
      body: 'see [[Memory]]',
      sources: [{ title: 'W', url: 'https://w' }],
    });
    expect(learn.category).toBe('learn');
    expect(learn.sources?.[0].url).toBe('https://w');

    const dataEntry = await store.addNote({
      category: 'data',
      title: 'Doc',
      body: 'sum',
      url: 'https://x',
      tags: ['pdf'],
    });
    expect(dataEntry.category).toBe('data');
    expect(dataEntry.url).toBe('https://x');

    // Legacy note without category loads as daily (defensive).
    const data = store.getData();
    expect(data.notes).toHaveLength(3);
  });

  it('updates settings', async () => {
    const fsImpl = createMemFs();
    const store = createManagerStore({ dir: ROOT, fs: fsImpl });
    const data = await store.updateSettings({ weatherEnabled: true, defaultLocation: 'Hanoi' });
    expect(data.settings.weatherEnabled).toBe(true);
    expect(data.settings.defaultLocation).toBe('Hanoi');
  });

  it('emits onChange after a mutation', async () => {
    const fsImpl = createMemFs();
    const store = createManagerStore({ dir: ROOT, fs: fsImpl });
    let received = 0;
    const off = store.onChange(() => (received += 1));
    await store.addTask({ title: 'ping' });
    expect(received).toBe(1);
    off();
    await store.addTask({ title: 'pong' });
    expect(received).toBe(1); // unsubscribed
  });
});

describe('createManagerStore — defensive load (Property 3)', () => {
  it('returns an empty document when the file is missing', async () => {
    const store = createManagerStore({ dir: ROOT, fs: createMemFs() });
    const data = await store.load();
    expect(data.tasks).toEqual([]);
    expect(data.notes).toEqual([]);
    expect(data.events).toEqual([]);
    expect(data.version).toBe(1);
  });

  it('returns an empty document when the JSON is corrupt', async () => {
    const store = createManagerStore({ dir: ROOT, fs: createMemFs({ [DATA_FILE]: '{ not json' }) });
    const data = await store.load();
    expect(data.tasks).toEqual([]);
  });

  it('drops malformed records but keeps valid ones', async () => {
    const seed = JSON.stringify({
      version: 1,
      tasks: [
        { id: 't1', title: 'good' },
        { id: 't2' }, // no title → dropped
        'garbage', // not an object → dropped
      ],
      notes: [{ id: 'n1', body: 'ok' }, { id: 'n2' /* no body */ }],
      events: [
        { id: 'e1', title: 'ok', startAt: 1, endAt: 2 },
        { id: 'e2', title: 'no-times' }, // missing times → dropped
      ],
      settings: 'nope',
    });
    const store = createManagerStore({ dir: ROOT, fs: createMemFs({ [DATA_FILE]: seed }) });
    const data = await store.load();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].title).toBe('good');
    // Dropped tasks get sane defaults for kind/priority/status on the survivor.
    expect(data.tasks[0].kind).toBe('oneoff');
    expect(data.notes).toHaveLength(1);
    expect(data.events).toHaveLength(1);
    expect(data.settings.weatherEnabled).toBe(false);
  });
});

describe('createManagerStore — recurring task spawn (criterion 1.3b)', () => {
  it('spawns the next daily occurrence when a recurring task is completed', async () => {
    const fsImpl = createMemFs();
    const day = 24 * 60 * 60 * 1000;
    const store = createManagerStore({ dir: ROOT, fs: fsImpl, now: () => 10_000, newId: seqIds() });

    const task = await store.addTask({
      title: 'Daily standup',
      kind: 'recurring',
      recurrence: { freq: 'daily', interval: 1 },
      dueAt: 10_000,
    });

    const data = await store.setTaskStatus(task.id, 'done');
    // Original is done; a fresh todo occurrence exists with due shifted by 1 day.
    expect(data.tasks).toHaveLength(2);
    const done = data.tasks.find((t) => t.status === 'done');
    const next = data.tasks.find((t) => t.status === 'todo');
    expect(done?.completedAt).toBe(10_000);
    expect(next?.dueAt).toBe(10_000 + day);
    expect(next?.id).not.toBe(task.id);
  });

  it('does not spawn for a non-recurring task', async () => {
    const fsImpl = createMemFs();
    const store = createManagerStore({ dir: ROOT, fs: fsImpl, newId: seqIds() });
    const task = await store.addTask({ title: 'one-off', kind: 'oneoff' });
    const data = await store.setTaskStatus(task.id, 'done');
    expect(data.tasks).toHaveLength(1);
  });
});
