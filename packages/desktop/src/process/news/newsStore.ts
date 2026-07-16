/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistence + CRUD layer for the News aggregator.
 *
 * Mirrors the Personal Manager store conventions: the whole {@link NewsData}
 * document is written to `news-data.json` in the Electron `userData` dir via a
 * sibling `.tmp` file + atomic rename, so a crash mid-write never corrupts the
 * file. Reads are defensive — a missing/corrupt file yields a fresh empty
 * document and malformed records are dropped rather than throwing.
 *
 * The store also owns the **ingest** path: {@link INewsStore.ingestItems}
 * merges freshly-fetched items for one feed, deduping by id and pruning to the
 * configured `maxItemsPerFeed`. An `onChange` subscription lets the bridge push
 * live updates to the renderer.
 *
 * Testability: the directory, fs impl, clock, and id generator are injectable.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  defaultNewsSettings,
  emptyNewsData,
  NEWS_CATEGORY_IDS,
  NEWS_DATA_VERSION,
  type NewsCategoryId,
  type NewsData,
  type NewsFeed,
  type NewsItem,
  type NewsSettings,
  type KeywordRule,
} from './newsTypes';

/** Name of the persisted document inside the app data directory. */
const NEWS_DATA_FILE = 'news-data.json';

/** Minimal subset of `fs/promises` used here (injectable for tests). */
export type NewsFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

const defaultFs: NewsFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

export type NewsStoreOptions = {
  dir?: string;
  fs?: NewsFs;
  now?: () => number;
  newId?: () => string;
};

const resolveDir = (options?: NewsStoreOptions): string => options?.dir ?? app.getPath('userData');
const resolveFs = (options?: NewsStoreOptions): NewsFs => options?.fs ?? defaultFs;
const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

// ---------------------------------------------------------------------------
// Defensive normalisation
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const isCategory = (v: unknown): v is NewsCategoryId =>
  typeof v === 'string' && (NEWS_CATEGORY_IDS as readonly string[]).includes(v);

const isFeedKind = (v: unknown): v is NewsFeed['kind'] => v === 'rss' || v === 'bluesky';

const normaliseFeed = (v: unknown, now: number): NewsFeed | null => {
  if (!isObject(v) || typeof v.url !== 'string') return null;
  return {
    id: str(v.id) || randomUUID(),
    kind: isFeedKind(v.kind) ? v.kind : 'rss',
    lang: typeof v.lang === 'string' ? v.lang : null,
    url: v.url,
    title: str(v.title) || v.url,
    category: isCategory(v.category) ? v.category : null,
    enabled: bool(v.enabled, true),
    createdAt: num(v.createdAt) ?? now,
    lastFetchedAt: num(v.lastFetchedAt),
    lastError: typeof v.lastError === 'string' ? v.lastError : null,
  };
};

/** Defensively parse the optional per-locale translation cache. */
const normaliseTranslations = (v: unknown): NewsItem['translations'] => {
  if (!isObject(v)) return undefined;
  const out: Record<string, { title: string; summary: string }> = {};
  for (const [lang, entry] of Object.entries(v)) {
    if (isObject(entry) && typeof entry.title === 'string') {
      out[lang] = { title: entry.title, summary: typeof entry.summary === 'string' ? entry.summary : '' };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

const normaliseItem = (v: unknown, now: number): NewsItem | null => {
  if (!isObject(v) || typeof v.title !== 'string') return null;
  const source = v.categorySource;
  return {
    id: str(v.id) || randomUUID(),
    feedId: str(v.feedId),
    title: v.title,
    link: str(v.link),
    summary: str(v.summary),
    author: typeof v.author === 'string' ? v.author : null,
    imageUrl: typeof v.imageUrl === 'string' ? v.imageUrl : null,
    publishedAt: num(v.publishedAt),
    category: isCategory(v.category) ? v.category : 'general',
    categorySource:
      source === 'feed' || source === 'tag' || source === 'keyword' || source === 'default' ? source : 'default',
    rawTags: strArr(v.rawTags),
    read: bool(v.read, false),
    fetchedAt: num(v.fetchedAt) ?? now,
    sourceLang: typeof v.sourceLang === 'string' ? v.sourceLang : null,
    translations: normaliseTranslations(v.translations),
  };
};

const normaliseKeywordRule = (v: unknown): KeywordRule | null => {
  if (!isObject(v) || !isCategory(v.category)) return null;
  const keywords = strArr(v.keywords)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (keywords.length === 0) return null;
  return { category: v.category, keywords };
};

const normaliseSettings = (v: unknown): NewsSettings => {
  const base = defaultNewsSettings();
  if (!isObject(v)) return base;
  const interval = num(v.refreshIntervalMinutes);
  const maxItems = num(v.maxItemsPerFeed);
  return {
    refreshIntervalMinutes:
      interval != null ? Math.min(1440, Math.max(5, Math.round(interval))) : base.refreshIntervalMinutes,
    maxItemsPerFeed: maxItems != null ? Math.min(1000, Math.max(10, Math.round(maxItems))) : base.maxItemsPerFeed,
    keywordRules: Array.isArray(v.keywordRules)
      ? v.keywordRules.map(normaliseKeywordRule).filter((x): x is KeywordRule => x !== null)
      : [],
    translateEnabled: bool(v.translateEnabled, base.translateEnabled),
    translateTargetLang: typeof v.translateTargetLang === 'string' ? v.translateTargetLang : null,
    realtimeEnabled: bool(v.realtimeEnabled, base.realtimeEnabled),
    marketSymbols: strArr(v.marketSymbols)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0)
      .slice(0, 50),
  };
};

const normaliseData = (parsed: unknown, now: number): NewsData => {
  if (!isObject(parsed)) return emptyNewsData();
  return {
    version: NEWS_DATA_VERSION,
    feeds: Array.isArray(parsed.feeds)
      ? parsed.feeds.map((f) => normaliseFeed(f, now)).filter((x): x is NewsFeed => x !== null)
      : [],
    items: Array.isArray(parsed.items)
      ? parsed.items.map((i) => normaliseItem(i, now)).filter((x): x is NewsItem => x !== null)
      : [],
    settings: normaliseSettings(parsed.settings),
  };
};

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/** Fields accepted when subscribing to a feed; the rest are defaulted. */
export type NewFeedInput = {
  url: string;
  title?: string;
  category?: NewsCategoryId | null;
  enabled?: boolean;
  kind?: NewsFeed['kind'];
  lang?: string | null;
};

/** A freshly-fetched + classified item, before it is assigned a store id. */
export type IngestItemInput = Omit<NewsItem, 'id' | 'feedId' | 'read' | 'fetchedAt'> & { guid: string };

/** Public contract of the News store. */
export type INewsStore = {
  load(): Promise<NewsData>;
  getData(): NewsData;
  // Feeds
  addFeed(input: NewFeedInput): Promise<NewsFeed>;
  updateFeed(id: string, patch: Partial<Omit<NewsFeed, 'id' | 'createdAt'>>): Promise<NewsData>;
  removeFeed(id: string): Promise<NewsData>;
  // Items
  /** Merge freshly-fetched items for one feed: dedupe by guid, prune to cap. */
  ingestItems(feedId: string, items: IngestItemInput[]): Promise<NewsData>;
  markRead(itemId: string, read: boolean): Promise<NewsData>;
  markAllRead(): Promise<NewsData>;
  clearItems(feedId?: string): Promise<NewsData>;
  // Settings
  updateSettings(patch: Partial<NewsSettings>): Promise<NewsData>;
  onChange(listener: (data: NewsData) => void): () => void;
};

/** Stable item id from a feed id + the item's guid (dedupe key). */
const itemIdFor = (feedId: string, guid: string): string => `${feedId}::${guid}`;

/**
 * Create a News store rooted at the given directory (defaults to `userData`).
 * Caches the document in memory after the first {@link load} and persists
 * atomically after each mutation, emitting the new document to listeners.
 */
export const createNewsStore = (options?: NewsStoreOptions): INewsStore => {
  const now = options?.now ?? Date.now;
  const newId = options?.newId ?? randomUUID;
  const fsImpl = resolveFs(options);
  const filePath = path.join(resolveDir(options), NEWS_DATA_FILE);
  const listeners = new Set<(data: NewsData) => void>();

  let cache: NewsData = emptyNewsData();
  let loaded = false;

  const persist = async (next: NewsData): Promise<NewsData> => {
    cache = next;
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.tmp`;
    await fsImpl.mkdir(dir, { recursive: true });
    await fsImpl.writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, filePath);
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        console.error('[NewsStore] onChange listener threw:', error);
      }
    }
    return next;
  };

  const load = async (): Promise<NewsData> => {
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      cache = normaliseData(JSON.parse(raw) as unknown, now());
    } catch (error) {
      if (!isFileNotFound(error)) {
        console.warn('[NewsStore] Failed to read news-data.json; using empty document:', error);
      }
      cache = emptyNewsData();
    }
    loaded = true;
    return cache;
  };

  const ensureLoaded = async (): Promise<void> => {
    if (!loaded) await load();
  };

  /** Keep the newest `cap` items for `feedId`; sort key prefers publishedAt. */
  const pruneFeedItems = (items: NewsItem[], feedId: string, cap: number): NewsItem[] => {
    const own = items.filter((i) => i.feedId === feedId);
    if (own.length <= cap) return items;
    const sortKey = (i: NewsItem) => i.publishedAt ?? i.fetchedAt;
    const keep = new Set(
      own
        .toSorted((a, b) => sortKey(b) - sortKey(a))
        .slice(0, cap)
        .map((i) => i.id)
    );
    return items.filter((i) => i.feedId !== feedId || keep.has(i.id));
  };

  return {
    load,
    getData: () => cache,

    async addFeed(input) {
      await ensureLoaded();
      const ts = now();
      const feed: NewsFeed = {
        id: newId(),
        kind: input.kind ?? 'rss',
        lang: input.lang ?? null,
        url: input.url,
        title: input.title ?? input.url,
        category: input.category ?? null,
        enabled: input.enabled ?? true,
        createdAt: ts,
        lastFetchedAt: null,
        lastError: null,
      };
      await persist({ ...cache, feeds: [...cache.feeds, feed] });
      return feed;
    },

    async updateFeed(id, patch) {
      await ensureLoaded();
      const feeds = cache.feeds.map((f) => (f.id === id ? { ...f, ...patch, id: f.id } : f));
      return persist({ ...cache, feeds });
    },

    async removeFeed(id) {
      await ensureLoaded();
      return persist({
        ...cache,
        feeds: cache.feeds.filter((f) => f.id !== id),
        items: cache.items.filter((i) => i.feedId !== id),
      });
    },

    async ingestItems(feedId, incoming) {
      await ensureLoaded();
      const ts = now();
      const existingById = new Map(cache.items.map((i) => [i.id, i]));
      for (const raw of incoming) {
        const id = itemIdFor(feedId, raw.guid);
        const prev = existingById.get(id);
        existingById.set(id, {
          id,
          feedId,
          title: raw.title,
          link: raw.link,
          summary: raw.summary,
          author: raw.author,
          imageUrl: raw.imageUrl,
          publishedAt: raw.publishedAt,
          category: raw.category,
          categorySource: raw.categorySource,
          rawTags: raw.rawTags,
          // Preserve read state + original ingest time across refreshes.
          read: prev?.read ?? false,
          fetchedAt: prev?.fetchedAt ?? ts,
          // Translation metadata: prefer freshly-supplied values, else keep the
          // previously-cached translations so we never re-translate on refresh.
          sourceLang: raw.sourceLang ?? prev?.sourceLang ?? null,
          translations: raw.translations ?? prev?.translations,
        });
      }
      let items = [...existingById.values()];
      const cap = cache.settings.maxItemsPerFeed;
      items = pruneFeedItems(items, feedId, cap);
      const feeds = cache.feeds.map((f) => (f.id === feedId ? { ...f, lastFetchedAt: ts, lastError: null } : f));
      return persist({ ...cache, feeds, items });
    },

    async markRead(itemId, read) {
      await ensureLoaded();
      const items = cache.items.map((i) => (i.id === itemId ? { ...i, read } : i));
      return persist({ ...cache, items });
    },

    async markAllRead() {
      await ensureLoaded();
      return persist({ ...cache, items: cache.items.map((i) => ({ ...i, read: true })) });
    },

    async clearItems(feedId) {
      await ensureLoaded();
      const items = feedId ? cache.items.filter((i) => i.feedId !== feedId) : [];
      return persist({ ...cache, items });
    },

    async updateSettings(patch) {
      await ensureLoaded();
      return persist({ ...cache, settings: { ...cache.settings, ...patch } });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
