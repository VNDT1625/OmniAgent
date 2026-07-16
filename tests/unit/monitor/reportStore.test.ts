/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/monitor/reportStore (Yêu cầu 6, criteria 6.2 / 6.9):
 * the store deduplicates bug reports by signature — a recurring error bumps the
 * existing report (occurrences / lastSeen) instead of creating a duplicate, so a
 * similar error can be looked up (and its known fix recalled) without
 * re-analysing.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReportStore, type ReportStoreFs } from '@/process/monitor/reportStore';

/** In-memory fs so tests touch no real disk. */
const createMemFs = (): ReportStoreFs & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (p) => {
      const c = files.get(p);
      if (c === undefined) {
        const e = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      }
      return c;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (a, b) => {
      const c = files.get(a);
      if (c !== undefined) {
        files.set(b, c);
        files.delete(a);
      }
    },
    mkdir: async () => undefined,
  };
};

const FILE = path.join('store', 'bug-reports.json');

const makeStore = () => {
  const fsImpl = createMemFs();
  let clock = 1000;
  const store = createReportStore({ filePath: FILE, fs: fsImpl, now: () => ++clock });
  return { store, fsImpl };
};

describe('reportStore signature dedup (criterion 6.9)', () => {
  it('creates a new report on first sighting', async () => {
    const { store } = makeStore();
    const r = await store.record({ source: 'sentry', title: 'Crash', message: 'boom at foo' });
    expect(r.occurrences).toBe(1);
    expect(await store.list()).toHaveLength(1);
  });

  it('deduplicates identical errors by signature, bumping occurrences', async () => {
    const { store } = makeStore();
    const first = await store.record({
      source: 'sentry',
      title: 'Crash',
      message: 'boom at foo',
      stack: 'Error: boom\n at foo (a.ts:1:2)',
    });
    const second = await store.record({
      source: 'sentry',
      title: 'Crash again',
      message: 'boom at foo',
      stack: 'Error: boom\n at foo (a.ts:9:9)',
    });

    expect(second.signature).toBe(first.signature); // volatile line/col stripped
    expect(second.occurrences).toBe(2);
    const all = await store.list();
    expect(all).toHaveLength(1); // not duplicated
    expect(all[0].occurrences).toBe(2);
  });

  it('keeps distinct errors as separate reports', async () => {
    const { store } = makeStore();
    await store.record({ source: 'sentry', title: 'A', message: 'first kind of error' });
    await store.record({ source: 'sentry', title: 'B', message: 'totally different failure' });
    expect(await store.list()).toHaveLength(2);
  });

  it('finds a report by signature and attaches a known fix (recall path)', async () => {
    const { store } = makeStore();
    const r = await store.record({
      source: 'user',
      title: 'X',
      message: 'specific bug',
      description: 'happens on save',
    });

    const found = await store.findBySignature(r.signature);
    expect(found?.id).toBe(r.id);

    await store.attachKnownFix(r.signature, 'fix-123');
    const updated = await store.findBySignature(r.signature);
    expect(updated?.knownFixId).toBe('fix-123');
  });

  it('honours an explicit signature when provided', async () => {
    const { store } = makeStore();
    const a = await store.record({ source: 'logs', title: 'A', message: 'msg a', signature: 'shared-sig' });
    const b = await store.record({
      source: 'logs',
      title: 'B',
      message: 'msg b (different text)',
      signature: 'shared-sig',
    });
    expect(b.signature).toBe(a.signature);
    expect(b.occurrences).toBe(2);
    expect(await store.list()).toHaveLength(1);
  });
});
