/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the News IPC surface (RSS aggregator).
 *
 * The Main-process bridge module (`process/news/newsBridge.ts`) pulls in
 * Electron + Node `fs` (via `newsStore.ts`), so it must NOT be imported into the
 * renderer at runtime. Mirroring `managerBridgeClient.ts`, this module:
 *
 * - re-declares the channel-name strings (kept in sync with `NEWS_CHANNELS`),
 * - rebuilds matching `bridge.buildProvider(...)` invokers from those names,
 * - wraps each call with a short timeout so an unregistered channel rejects
 *   instead of hanging.
 *
 * Only **types** are borrowed from Main-process modules via `import type`.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  AddFeedRequest,
  ClearItemsRequest,
  GetWeatherRequest,
  GithubTrendingRequest,
  GithubTrendingResult,
  IdRequest,
  MarkReadRequest,
  NewsResult,
  RefreshFeedRequest,
  UpdateFeedRequest,
  UpdateSettingsRequest,
  ValidateFeedRequest,
  ValidateFeedResult,
  WeatherResult,
  MarketQuotesRequest,
  MarketQuotesResult,
} from '@process/news/newsBridge';
import type { NewsData } from '@process/news/newsTypes';

/** News IPC channel names. Mirrors `NEWS_CHANNELS` in the bridge. */
const NEWS_CHANNELS = {
  getData: 'news.get-data',
  addFeed: 'news.add-feed',
  updateFeed: 'news.update-feed',
  removeFeed: 'news.remove-feed',
  refreshFeed: 'news.refresh-feed',
  refreshAll: 'news.refresh-all',
  markRead: 'news.mark-read',
  markAllRead: 'news.mark-all-read',
  clearItems: 'news.clear-items',
  updateSettings: 'news.update-settings',
  dataChanged: 'news.data-changed',
  validateFeed: 'news.validate-feed',
  getWeather: 'news.get-weather',
  githubTrending: 'news.github-trending',
  marketQuotes: 'news.market-quotes',
} as const;

const channels = {
  getData: bridge.buildProvider<NewsResult<NewsData>, void>(NEWS_CHANNELS.getData),
  addFeed: bridge.buildProvider<NewsResult<NewsData>, AddFeedRequest>(NEWS_CHANNELS.addFeed),
  updateFeed: bridge.buildProvider<NewsResult<NewsData>, UpdateFeedRequest>(NEWS_CHANNELS.updateFeed),
  removeFeed: bridge.buildProvider<NewsResult<NewsData>, IdRequest>(NEWS_CHANNELS.removeFeed),
  refreshFeed: bridge.buildProvider<NewsResult<NewsData>, RefreshFeedRequest>(NEWS_CHANNELS.refreshFeed),
  refreshAll: bridge.buildProvider<NewsResult<NewsData>, void>(NEWS_CHANNELS.refreshAll),
  markRead: bridge.buildProvider<NewsResult<NewsData>, MarkReadRequest>(NEWS_CHANNELS.markRead),
  markAllRead: bridge.buildProvider<NewsResult<NewsData>, void>(NEWS_CHANNELS.markAllRead),
  clearItems: bridge.buildProvider<NewsResult<NewsData>, ClearItemsRequest>(NEWS_CHANNELS.clearItems),
  updateSettings: bridge.buildProvider<NewsResult<NewsData>, UpdateSettingsRequest>(NEWS_CHANNELS.updateSettings),
  dataChanged: bridge.buildEmitter<NewsData>(NEWS_CHANNELS.dataChanged),
  validateFeed: bridge.buildProvider<ValidateFeedResult, ValidateFeedRequest>(NEWS_CHANNELS.validateFeed),
  getWeather: bridge.buildProvider<WeatherResult, GetWeatherRequest>(NEWS_CHANNELS.getWeather),
  githubTrending: bridge.buildProvider<GithubTrendingResult, GithubTrendingRequest>(NEWS_CHANNELS.githubTrending),
  marketQuotes: bridge.buildProvider<MarketQuotesResult, MarketQuotesRequest>(NEWS_CHANNELS.marketQuotes),
};

/** Default invoke timeout (ms). Network-bound calls get a longer budget below. */
const BRIDGE_TIMEOUT_MS = 8_000;
/** Refresh calls hit the network across many feeds — allow more time. */
const REFRESH_TIMEOUT_MS = 60_000;

/** Error thrown when a news IPC call does not reply within its budget. */
export class NewsBridgeTimeoutError extends Error {
  constructor(channel: string) {
    super(`[NewsBridgeClient] No reply on "${channel}" — the news bridge may not be wired yet.`);
    this.name = 'NewsBridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so a missing handler rejects, not hangs. */
const withTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new NewsBridgeTimeoutError(channel));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/**
 * Timeout-guarded News invokers. Each method resolves with the bridge's
 * {@link NewsResult} envelope, or rejects on timeout.
 */
export const newsClient = {
  getData: () => withTimeout(NEWS_CHANNELS.getData, () => channels.getData.invoke(), BRIDGE_TIMEOUT_MS),
  addFeed: (req: AddFeedRequest) =>
    withTimeout(NEWS_CHANNELS.addFeed, () => channels.addFeed.invoke(req), BRIDGE_TIMEOUT_MS),
  updateFeed: (req: UpdateFeedRequest) =>
    withTimeout(NEWS_CHANNELS.updateFeed, () => channels.updateFeed.invoke(req), BRIDGE_TIMEOUT_MS),
  removeFeed: (req: IdRequest) =>
    withTimeout(NEWS_CHANNELS.removeFeed, () => channels.removeFeed.invoke(req), BRIDGE_TIMEOUT_MS),
  refreshFeed: (req: RefreshFeedRequest) =>
    withTimeout(NEWS_CHANNELS.refreshFeed, () => channels.refreshFeed.invoke(req), REFRESH_TIMEOUT_MS),
  refreshAll: () => withTimeout(NEWS_CHANNELS.refreshAll, () => channels.refreshAll.invoke(), REFRESH_TIMEOUT_MS),
  markRead: (req: MarkReadRequest) =>
    withTimeout(NEWS_CHANNELS.markRead, () => channels.markRead.invoke(req), BRIDGE_TIMEOUT_MS),
  markAllRead: () => withTimeout(NEWS_CHANNELS.markAllRead, () => channels.markAllRead.invoke(), BRIDGE_TIMEOUT_MS),
  clearItems: (req: ClearItemsRequest) =>
    withTimeout(NEWS_CHANNELS.clearItems, () => channels.clearItems.invoke(req), BRIDGE_TIMEOUT_MS),
  updateSettings: (req: UpdateSettingsRequest) =>
    withTimeout(NEWS_CHANNELS.updateSettings, () => channels.updateSettings.invoke(req), BRIDGE_TIMEOUT_MS),
  /** Subscribe to live document changes (main → renderer). Returns an unsubscribe fn. */
  onDataChanged: (listener: (data: NewsData) => void): (() => void) => channels.dataChanged.on(listener),
  /** Validate a feed URL before subscribing — test fetch + parse. */
  validateFeed: (req: ValidateFeedRequest) =>
    withTimeout(NEWS_CHANNELS.validateFeed, () => channels.validateFeed.invoke(req), REFRESH_TIMEOUT_MS),
  /** Fetch a 5-day weather forecast for a location (keyless Open-Meteo). */
  getWeather: (req: GetWeatherRequest) =>
    withTimeout(NEWS_CHANNELS.getWeather, () => channels.getWeather.invoke(req), BRIDGE_TIMEOUT_MS),
  /** Fetch top trending GitHub repositories (keyless GitHub Search API). */
  githubTrending: (req: GithubTrendingRequest = {}) =>
    withTimeout(NEWS_CHANNELS.githubTrending, () => channels.githubTrending.invoke(req), REFRESH_TIMEOUT_MS),
  /** Fetch market quotes (indices + equities via Stooq, crypto via CoinGecko). */
  marketQuotes: (req: MarketQuotesRequest = {}) =>
    withTimeout(NEWS_CHANNELS.marketQuotes, () => channels.marketQuotes.invoke(req), REFRESH_TIMEOUT_MS),
};
