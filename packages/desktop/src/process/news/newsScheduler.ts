/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Refresh scheduler for the News aggregator.
 *
 * Like the Personal Manager's reminder scheduler, this runs entirely in the
 * Main process with a simple ticker — NOT through aioncore's cron (which exists
 * to run *agent tasks*, not lightweight feed polling). On {@link start} it runs
 * an immediate catch-up refresh (so reopening the app pulls fresh news), then
 * ticks on a fixed interval. Each tick refreshes only feeds whose
 * `lastFetchedAt` is older than the configured cadence, with bounded
 * concurrency so a long feed list can't saturate the network.
 *
 * RSS is pull-based: the effective freshness is `refreshIntervalMinutes`. We
 * keep the *ticker* short (one minute) and gate per-feed on its own
 * `lastFetchedAt`, so a feed added mid-cycle refreshes promptly without waiting
 * a full interval.
 *
 * Testability: `fetchFeed`, `now`, and the interval scheduler are injectable so
 * the cadence/catch-up/concurrency behaviour is unit-testable without real
 * timers or network.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { fetchFeed as defaultFetchFeed } from './newsFetcher';
import type { FetchFeedResult } from './newsFetcher';
import type { INewsStore } from './newsStore';
import type { NewsFeed } from './newsTypes';
import { baseLang, translateIngestItems, type Translator } from './newsTranslator';

/** How many feeds may be fetched concurrently in one sweep. */
const DEFAULT_MAX_PARALLEL = 4;

/** Injected dependencies for {@link createNewsScheduler}. */
export type NewsSchedulerDeps = {
  /** The shared News store (source of feeds + sink for ingested items). */
  store: INewsStore;
  /** Fetch one feed. Defaults to {@link defaultFetchFeed}. Injectable for tests. */
  fetchFeed?: (feed: NewsFeed, userRules: Parameters<typeof defaultFetchFeed>[1]) => Promise<FetchFeedResult>;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Schedule a repeating tick. Defaults to `setInterval`. */
  setInterval?: (handler: () => void, ms: number) => { clear: () => void };
  /** Ticker period in ms. Defaults to 60_000 (one minute). */
  tickMs?: number;
  /** Max concurrent feed fetches per sweep. Defaults to {@link DEFAULT_MAX_PARALLEL}. */
  maxParallel?: number;
  /** Optional no-LLM translator. When set + enabled in settings, new items are translated. */
  translator?: Translator;
};

/** Public contract of the news scheduler. */
export type INewsScheduler = {
  /** Run an immediate refresh of all due feeds, then begin ticking. Idempotent. */
  start(): Promise<void>;
  /** Stop ticking. */
  stop(): void;
  /** Refresh every due feed once (also used internally by the ticker). */
  sweep(): Promise<void>;
  /** Force-refresh a single feed now, regardless of its cadence. */
  refreshFeed(feedId: string): Promise<FetchFeedResult>;
  /** Force-refresh all enabled feeds now, regardless of cadence. */
  refreshAll(): Promise<void>;
};

/** Run `tasks` with at most `limit` in flight at once (preserves order-agnostic). */
const mapWithConcurrency = async <T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> => {
  const queue = [...items];
  const runners: Promise<void>[] = [];
  const runNext = async (): Promise<void> => {
    const item = queue.shift();
    if (item === undefined) return;
    await worker(item);
    await runNext();
  };
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(runNext());
  await Promise.all(runners);
};

/**
 * Create a news scheduler bound to a {@link INewsStore}.
 */
export const createNewsScheduler = (deps: NewsSchedulerDeps): INewsScheduler => {
  const now = deps.now ?? Date.now;
  const tickMs = deps.tickMs ?? 60_000;
  const maxParallel = deps.maxParallel ?? DEFAULT_MAX_PARALLEL;
  const fetchOne = deps.fetchFeed ?? ((feed, rules) => defaultFetchFeed(feed, rules));
  const scheduleInterval =
    deps.setInterval ??
    ((handler: () => void, ms: number) => {
      const id = setInterval(handler, ms);
      return { clear: () => clearInterval(id) };
    });

  let handle: { clear: () => void } | undefined;
  let started = false;
  /** Guards against overlapping sweeps (a slow network shouldn't double-run). */
  let sweeping = false;

  /**
   * Translate freshly-fetched items into the app language in place (best-effort,
   * no LLM). Only runs when enabled + a translator is wired; skips items already
   * cached for the target language so refreshes don't burn the daily quota.
   */
  const maybeTranslate = async (feed: NewsFeed, items: Parameters<INewsStore['ingestItems']>[1]): Promise<void> => {
    const settings = deps.store.getData().settings;
    if (!deps.translator || !settings.translateEnabled || !settings.translateTargetLang || items.length === 0) return;
    const targetBase = baseLang(settings.translateTargetLang);
    const existing = deps.store.getData().items;
    const cachedFor = new Set(
      existing.filter((i) => i.feedId === feed.id && i.translations?.[targetBase]).map((i) => i.id)
    );
    try {
      await translateIngestItems(items, deps.translator, {
        targetLang: settings.translateTargetLang,
        feedLang: feed.lang ?? null,
        isAlreadyTranslated: (item) => cachedFor.has(`${feed.id}::${item.guid}`),
      });
    } catch (error) {
      console.error(`[NewsScheduler] translation failed for ${feed.url}:`, error);
    }
  };

  /** Fetch one feed and persist the outcome (items on success, error otherwise). */
  const refreshOne = async (feed: NewsFeed): Promise<FetchFeedResult> => {
    const rules = deps.store.getData().settings.keywordRules;
    const result = await fetchOne(feed, rules);
    if (result.ok) {
      await maybeTranslate(feed, result.items);
      await deps.store.ingestItems(feed.id, result.items);
      // Adopt the feed's real title when the user never set one.
      if (result.feedTitle && (feed.title === feed.url || !feed.title)) {
        await deps.store.updateFeed(feed.id, { title: result.feedTitle });
      }
    } else {
      // Without strictNullChecks the `else` branch does not reliably narrow the
      // union to its failure member, so name it explicitly before reading `error`.
      const failure = result as { ok: false; error: string };
      await deps.store.updateFeed(feed.id, { lastError: failure.error, lastFetchedAt: now() });
    }
    return result;
  };

  /** Feeds that are enabled and overdue for a refresh at time `at`. */
  const dueFeeds = (at: number): NewsFeed[] => {
    const { feeds, settings } = deps.store.getData();
    const intervalMs = settings.refreshIntervalMinutes * 60_000;
    return feeds.filter(
      (f) =>
        (f.kind ?? 'rss') === 'rss' &&
        f.enabled &&
        (f.lastFetchedAt == null || at - f.lastFetchedAt >= intervalMs)
    );
  };

  const sweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      const feeds = dueFeeds(now());
      await mapWithConcurrency(feeds, maxParallel, async (feed) => {
        try {
          await refreshOne(feed);
        } catch (error) {
          console.error(`[NewsScheduler] refresh failed for ${feed.url}:`, error);
        }
      });
    } finally {
      sweeping = false;
    }
  };

  return {
    sweep,

    async start() {
      if (started) return;
      started = true;
      await deps.store.load();
      await sweep(); // catch-up refresh on startup
      handle = scheduleInterval(() => {
        void sweep();
      }, tickMs);
    },

    stop() {
      handle?.clear();
      handle = undefined;
      started = false;
    },

    async refreshFeed(feedId) {
      await deps.store.load();
      const feed = deps.store.getData().feeds.find((f) => f.id === feedId);
      if (!feed) return { ok: false, error: 'Feed not found' };
      // Realtime (non-RSS) feeds are populated by the connector, not fetched.
      if ((feed.kind ?? 'rss') !== 'rss') return { ok: true, feedTitle: feed.title, items: [] };
      return refreshOne(feed);
    },

    async refreshAll() {
      await deps.store.load();
      const feeds = deps.store.getData().feeds.filter((f) => f.enabled && (f.kind ?? 'rss') === 'rss');
      await mapWithConcurrency(feeds, maxParallel, async (feed) => {
        try {
          await refreshOne(feed);
        } catch (error) {
          console.error(`[NewsScheduler] refresh failed for ${feed.url}:`, error);
        }
      });
    },
  };
};
