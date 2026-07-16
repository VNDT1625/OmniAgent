/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the News / RSS aggregator feature.
 *
 * The aggregator pulls RSS/Atom feeds in the Main process, classifies each
 * article into a topic **without any AI** (a deterministic 3-layer rule
 * pipeline — see `newsClassifier.ts`), and persists the result to a JSON
 * document on disk (see `newsStore.ts`). The renderer reads this state via the
 * `news.*` IPC bridge.
 *
 * Process boundary: imported by both Main process (Node) and the renderer
 * (types only). Keep this module free of Node/DOM runtime imports.
 */

/** Persisted document schema version. Bump when the on-disk shape changes. */
export const NEWS_DATA_VERSION = 1 as const;

/**
 * Built-in topic taxonomy. These ids are stable (used in storage + keyword
 * rules); their human labels are resolved via i18n keys `news.category.<id>`.
 */
export const NEWS_CATEGORY_IDS = [
  'general',
  'world',
  'politics',
  'business',
  'technology',
  'science',
  'health',
  'sports',
  'entertainment',
] as const;

export type NewsCategoryId = (typeof NEWS_CATEGORY_IDS)[number];

/** Which layer of the classifier decided an item's category (for transparency). */
export type CategorySource = 'feed' | 'tag' | 'keyword' | 'default';

/**
 * Source kind of a feed.
 *
 * - `rss` — a pull-based RSS/Atom URL refreshed by the scheduler (the default
 *   and the only kind the scheduler fetches).
 * - `bluesky` — a synthetic feed populated **live** by the realtime connector
 *   (Bluesky Jetstream WebSocket firehose). The scheduler skips these.
 *
 * Stored as an optional field so existing documents (which predate it) keep
 * working — `undefined` is treated as `rss`.
 */
export type NewsFeedKind = 'rss' | 'bluesky';

/** A subscribed feed source (RSS by default, or a realtime social stream). */
export type NewsFeed = {
  id: string;
  /** Source kind. Absent ⇒ `rss` (backward-compatible). */
  kind?: NewsFeedKind;
  /**
   * Source language as a BCP-47 / ISO-639-1 tag (e.g. `vi`, `en`, `ja`). Used by
   * the no-AI translator to decide whether an article needs translating into the
   * app language. `null`/absent ⇒ auto-detect from the article text.
   */
  lang?: string | null;
  /** Feed document URL (the XML endpoint), or the stream identifier for realtime feeds. */
  url: string;
  /** Display title — taken from the feed's `<title>` or overridden by the user. */
  title: string;
  /**
   * User-assigned category for the **whole** feed. When set, every article from
   * this feed inherits it (classifier layer 1 — the most reliable signal, since
   * publishers expose topic-specific feed URLs). `null` lets the per-article
   * layers decide.
   */
  category: NewsCategoryId | null;
  /** Disabled feeds are kept but skipped on refresh. */
  enabled: boolean;
  createdAt: number;
  /** Epoch ms of the last successful fetch, or `null` if never fetched. */
  lastFetchedAt: number | null;
  /** Last fetch error message, or `null` when the last fetch succeeded. */
  lastError: string | null;
};

/** A single classified article. */
export type NewsItem = {
  /** Stable id derived from the article guid/link (dedupe key). */
  id: string;
  /** Owning feed id. */
  feedId: string;
  title: string;
  link: string;
  /** Plain-text summary/snippet (HTML stripped). */
  summary: string;
  author: string | null;
  /** Thumbnail/image URL, or `null` when the feed provides none. */
  imageUrl: string | null;
  /** Epoch ms of publication, or `null` when the feed omits a date. */
  publishedAt: number | null;
  /** Resolved topic. */
  category: NewsCategoryId;
  /** Which classifier layer assigned {@link category}. */
  categorySource: CategorySource;
  /** Raw `<category>`/tag strings from the feed item (lower-cased). */
  rawTags: string[];
  read: boolean;
  /** Epoch ms when this item was first ingested. */
  fetchedAt: number;
  /**
   * Detected/declared source language (ISO-639-1, e.g. `ru`, `ja`), or `null`
   * when unknown. Set by the no-AI translator at ingest time.
   */
  sourceLang?: string | null;
  /**
   * Cached translations keyed by target app locale's base language (e.g. `vi`,
   * `zh`). Each entry holds the translated `title` + `summary`. Produced by the
   * dedicated MT engine (no LLM); absent until translated. The renderer shows
   * `translations[lang] ?? original`.
   */
  translations?: Record<string, { title: string; summary: string }>;
};

/** A user-editable keyword rule: any keyword hit maps the article to `category`. */
export type KeywordRule = {
  category: NewsCategoryId;
  /** Lower-cased match terms (substring match against title + summary). */
  keywords: string[];
};

/** Tunable aggregator settings. */
export type NewsSettings = {
  /** Refresh cadence in minutes (RSS is pull-based; 15 is a sane default). */
  refreshIntervalMinutes: number;
  /** Cap on retained items per feed (oldest pruned beyond this). */
  maxItemsPerFeed: number;
  /**
   * Extra keyword rules layered **on top of** the built-in defaults
   * (`newsClassifier.ts`). User rules win over defaults for the same term.
   */
  keywordRules: KeywordRule[];
  /** Translate foreign-language articles into the app language (no LLM). */
  translateEnabled: boolean;
  /**
   * Target MT language for translation (e.g. `vi`, `zh-CN`). The renderer keeps
   * this in sync with the current app locale. `null` ⇒ no target resolved yet.
   */
  translateTargetLang: string | null;
  /**
   * Stream the realtime social firehose (Bluesky Jetstream). When `false` the
   * connector disconnects and consumes no bandwidth. Default on.
   */
  realtimeEnabled: boolean;
  /**
   * User's custom Stocks watchlist as Yahoo Finance symbols (e.g. `AAPL`,
   * `^GSPC`, `BTC-USD`). Empty ⇒ the built-in default watchlist is used.
   */
  marketSymbols: string[];
};

/** The full persisted aggregator document. */
export type NewsData = {
  version: typeof NEWS_DATA_VERSION;
  feeds: NewsFeed[];
  items: NewsItem[];
  settings: NewsSettings;
};

/** Default settings for a fresh install. */
export const defaultNewsSettings = (): NewsSettings => ({
  refreshIntervalMinutes: 15,
  maxItemsPerFeed: 100,
  keywordRules: [],
  translateEnabled: false,
  translateTargetLang: null,
  realtimeEnabled: false,
  marketSymbols: [],
});

/** An empty, valid document. */
export const emptyNewsData = (): NewsData => ({
  version: NEWS_DATA_VERSION,
  feeds: [],
  items: [],
  settings: defaultNewsSettings(),
});
