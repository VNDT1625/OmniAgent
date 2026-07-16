/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createNewsStore, type NewsFs } from '@process/news/newsStore';

/** In-memory NewsFs for deterministic store tests (no disk). */
const makeMemFs = (): NewsFs => {
  const files = new Map<string, string>();
  return {
    readFile: async (p) => {
      if (!files.has(p)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p)!;
    },
    writeFile: async (p, data) => void files.set(p, data),
    rename: async (from, to) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
    mkdir: async () => undefined,
  };
};

describe('newsStore — realtime/translation field round-trip', () => {
  it('persists and reloads kind, lang, translations, and settings', async () => {
    const fs = makeMemFs();
    const a = createNewsStore({ dir: '/x', fs, now: () => 1, newId: () => 'feed-1' });
    await a.load();
    await a.addFeed({ url: 'jetstream://bluesky', kind: 'bluesky', lang: 'en', title: 'BSky' });
    await a.ingestItems('feed-1', [
      {
        guid: 'g1',
        title: 'Привет',
        link: 'https://e.com/a',
        summary: 'мир',
        author: null,
        imageUrl: null,
        publishedAt: 1,
        category: 'world',
        categorySource: 'default',
        rawTags: [],
        sourceLang: 'ru',
        translations: { en: { title: 'Hello', summary: 'world' } },
      },
    ]);
    await a.updateSettings({ translateEnabled: true, translateTargetLang: 'en', realtimeEnabled: false });

    // Reload from the same backing fs into a fresh store instance.
    const b = createNewsStore({ dir: '/x', fs, now: () => 2 });
    const data = await b.load();
    const feed = data.feeds.find((f) => f.id === 'feed-1');
    expect(feed?.kind).toBe('bluesky');
    expect(feed?.lang).toBe('en');
    const item = data.items.find((i) => i.id === 'feed-1::g1');
    expect(item?.sourceLang).toBe('ru');
    expect(item?.translations?.en).toEqual({ title: 'Hello', summary: 'world' });
    expect(data.settings.translateEnabled).toBe(true);
    expect(data.settings.translateTargetLang).toBe('en');
    expect(data.settings.realtimeEnabled).toBe(false);
  });

  it('preserves cached translations across a re-ingest without new translations', async () => {
    const fs = makeMemFs();
    const store = createNewsStore({ dir: '/y', fs, now: () => 1, newId: () => 'f' });
    await store.load();
    await store.addFeed({ url: 'https://e.com/rss' });
    const baseItem = {
      guid: 'g1',
      title: 'T',
      link: 'https://e.com/a',
      summary: 'S',
      author: null,
      imageUrl: null,
      publishedAt: 1,
      category: 'general' as const,
      categorySource: 'default' as const,
      rawTags: [],
    };
    await store.ingestItems('f', [{ ...baseItem, translations: { vi: { title: 'Tên', summary: 'Tóm' } } }]);
    // Re-ingest the same guid WITHOUT translations (simulating an RSS refresh).
    await store.ingestItems('f', [baseItem]);
    const item = store.getData().items.find((i) => i.id === 'f::g1');
    expect(item?.translations?.vi).toEqual({ title: 'Tên', summary: 'Tóm' });
  });
});
