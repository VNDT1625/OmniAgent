/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  baseLang,
  detectLang,
  localeToMtLang,
  translateIngestItems,
  createMyMemoryTranslator,
  type Translator,
} from '@process/news/newsTranslator';
import type { IngestItemInput } from '@process/news/newsStore';

const item = (over: Partial<IngestItemInput> = {}): IngestItemInput => ({
  guid: 'g1',
  title: 'Title',
  link: 'https://e.com/a',
  summary: 'Summary',
  author: null,
  imageUrl: null,
  publishedAt: null,
  category: 'general',
  categorySource: 'default',
  rawTags: [],
  ...over,
});

describe('newsTranslator — helpers', () => {
  it('maps locales to MT codes (Chinese keeps region)', () => {
    expect(localeToMtLang('vi-VN')).toBe('vi');
    expect(localeToMtLang('zh-CN')).toBe('zh-CN');
    expect(localeToMtLang('zh-TW')).toBe('zh-TW');
    expect(localeToMtLang('en-US')).toBe('en');
  });

  it('detects language by script', () => {
    expect(detectLang('Привет мир')).toBe('ru');
    expect(detectLang('こんにちは')).toBe('ja');
    expect(detectLang('안녕하세요')).toBe('ko');
    expect(detectLang('Xin chào bạn')).toBe('vi');
    expect(detectLang('你好世界')).toBe('zh');
    expect(detectLang('Hello world')).toBeNull();
  });

  it('baseLang strips region', () => {
    expect(baseLang('zh-CN')).toBe('zh');
    expect(baseLang('vi')).toBe('vi');
  });
});

describe('newsTranslator — translateIngestItems', () => {
  const fakeTranslator = (map: Record<string, string>): Translator => ({
    translate: async (text) => map[text] ?? `T(${text})`,
  });

  it('translates foreign items into the target language', async () => {
    const items = [item({ guid: 'r1', title: 'Привет', summary: 'мир' })];
    await translateIngestItems(items, fakeTranslator({ Привет: 'Hello', мир: 'world' }), { targetLang: 'en' });
    expect(items[0].sourceLang).toBe('ru');
    expect(items[0].translations?.en).toEqual({ title: 'Hello', summary: 'world' });
  });

  it('skips items already in the target language', async () => {
    const translate = vi.fn(async (t: string) => `T(${t})`);
    const items = [item({ title: 'Hello world', summary: 'plain' })];
    await translateIngestItems(items, { translate }, { targetLang: 'en', feedLang: 'en' });
    expect(translate).not.toHaveBeenCalled();
    expect(items[0].translations).toBeUndefined();
  });

  it('honours the isAlreadyTranslated guard', async () => {
    const translate = vi.fn(async (t: string) => `T(${t})`);
    const items = [item({ guid: 'r2', title: 'Привет' })];
    await translateIngestItems(
      items,
      { translate },
      {
        targetLang: 'vi',
        isAlreadyTranslated: () => true,
      }
    );
    expect(translate).not.toHaveBeenCalled();
  });
});

describe('newsTranslator — MyMemory engine', () => {
  it('parses a successful response', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: 'Xin chào' } }), {
          status: 200,
        })
    );
    const tr = createMyMemoryTranslator({ fetch: fetchMock as unknown as typeof fetch });
    expect(await tr.translate('Hello', 'en', 'vi')).toBe('Xin chào');
  });

  it('returns null when the API signals a non-200 status', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ responseStatus: 403, responseData: {} }), { status: 200 })
    );
    const tr = createMyMemoryTranslator({ fetch: fetchMock as unknown as typeof fetch });
    expect(await tr.translate('Hello', 'en', 'vi')).toBeNull();
  });

  it('stops calling the API once the daily char budget is exhausted', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: 'ok' } }), { status: 200 })
    );
    const tr = createMyMemoryTranslator({ fetch: fetchMock as unknown as typeof fetch, dailyCharBudget: 5 });
    expect(await tr.translate('Hello', 'en', 'vi')).toBe('ok'); // 5 chars — fits
    expect(await tr.translate('World', 'en', 'vi')).toBeNull(); // would exceed budget
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
