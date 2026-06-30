/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * News IPC bridge — exposes the Main-process News aggregator to the renderer
 * News UI.
 *
 * Like the Personal Manager bridge, this is an Electron-native bridge (not an
 * aioncore HTTP route), built with the `@office-ai/platform` `bridge` helper.
 * The typed channels are declared here and the channel-name constants
 * ({@link NEWS_CHANNELS}) are the renderer-safe contract — the renderer rebuilds
 * matching invokers from those names without importing this Node-only module
 * (see `newsBridgeClient.ts`).
 *
 * Every handler resolves an always-resolve {@link NewsResult} envelope: the
 * platform bridge swallows thrown errors (leaving the renderer's `invoke()`
 * pending forever), so failures are surfaced as `{ ok: false, error }`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { validateFeedUrl } from './newsFetcher';
import { detectLocationByIp } from './geoLocation';
import { forecastByCity, forecastByCoords } from './weatherFetch';
import {
  fetchGithubTrending,
  type GithubRepo,
  type GithubTrendingResult,
  type GithubTrendingSince,
} from './githubTrending';
import { fetchMarketQuotes, type MarketKind, type MarketQuote, type MarketQuotesResult } from './marketFetcher';
import type { WeatherForecast } from '@process/manager/weatherProvider';
import type { FetchFeedResult } from './newsFetcher';
import type { INewsScheduler } from './newsScheduler';
import type { INewsStore, NewFeedInput } from './newsStore';
import type { NewsCategoryId, NewsData, NewsFeed, NewsSettings } from './newsTypes';

// ---------------------------------------------------------------------------
// Channel names (renderer-safe contract)
// ---------------------------------------------------------------------------

/** IPC channel names for the news surface. Safe to mirror in the renderer. */
export const NEWS_CHANNELS = {
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

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export type ValidateFeedRequest = { url: string };
export type ValidateFeedResult = { ok: true; title: string } | { ok: false; error: string };
export type AddFeedRequest = { input: NewFeedInput };
export type UpdateFeedRequest = { id: string; patch: Partial<Omit<NewsFeed, 'id' | 'createdAt'>> };
export type IdRequest = { id: string };
export type RefreshFeedRequest = { id: string };
export type MarkReadRequest = { id: string; read: boolean };
export type ClearItemsRequest = { feedId?: string };

export type UpdateSettingsRequest = { patch: Partial<NewsSettings> };
export type GetWeatherRequest = { location?: string };
export type WeatherResult = { ok: true; data: WeatherForecast } | { ok: false; error: string };
export type GithubTrendingRequest = { since?: GithubTrendingSince; limit?: number; force?: boolean };
export type MarketQuotesRequest = { force?: boolean };

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------
export type NewsResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Typed news IPC channels. Exported for the bootstrap registration wiring. */
export const newsChannels = {
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Services the news bridge operates on. */
export type NewsBridgeServices = {
  store: INewsStore;
  scheduler: INewsScheduler;
};

export type RegisterNewsBridgeOptions = { services: NewsBridgeServices };

let unsubscribeChange: (() => void) | undefined;

/** Re-export for renderer convenience. */
export type { NewsCategoryId };

/**
 * Register the news IPC handlers and wire the live `dataChanged` push.
 *
 * Idempotent: a repeated call re-registers the providers and replaces the prior
 * `onChange` subscription. Intended to be invoked once during Main-process
 * bootstrap.
 */
export function registerNewsBridge(options: RegisterNewsBridgeOptions): void {
  const { store, scheduler } = options.services;

  /** Wrap a handler so it ALWAYS resolves a {@link NewsResult}. */
  const safe =
    <Req, Res>(label: string, handler: (req: Req) => Promise<Res>) =>
    async (req: Req): Promise<NewsResult<Res>> => {
      try {
        return { ok: true, data: await handler(req) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[NewsBridge] ${label} failed:`, error);
        return { ok: false, error: message };
      }
    };

  newsChannels.getData.provider(safe('getData', () => store.load()));

  newsChannels.addFeed.provider(
    safe('addFeed', async ({ input }) => {
      const feed = await store.addFeed(input);
      // Kick off an immediate fetch so the new feed populates without waiting.
      scheduler.refreshFeed(feed.id).catch((error) => console.error('[NewsBridge] initial refresh failed:', error));
      return store.getData();
    })
  );
  newsChannels.updateFeed.provider(safe('updateFeed', ({ id, patch }) => store.updateFeed(id, patch)));
  newsChannels.removeFeed.provider(safe('removeFeed', ({ id }) => store.removeFeed(id)));

  newsChannels.refreshFeed.provider(
    safe('refreshFeed', async ({ id }) => {
      await scheduler.refreshFeed(id);
      return store.getData();
    })
  );
  newsChannels.refreshAll.provider(
    safe('refreshAll', async () => {
      await scheduler.refreshAll();
      return store.getData();
    })
  );

  newsChannels.markRead.provider(safe('markRead', ({ id, read }) => store.markRead(id, read)));
  newsChannels.markAllRead.provider(safe('markAllRead', () => store.markAllRead()));
  newsChannels.clearItems.provider(safe('clearItems', ({ feedId }) => store.clearItems(feedId)));
  newsChannels.updateSettings.provider(safe('updateSettings', ({ patch }) => store.updateSettings(patch)));

  // Validate a feed URL before subscribing (test fetch + parse).
  newsChannels.validateFeed.provider(async ({ url }): Promise<ValidateFeedResult> => validateFeedUrl(url));

  // Top trending GitHub repositories (keyless Search API) for the tech tab.
  newsChannels.githubTrending.provider(
    async ({ since, limit, force }): Promise<GithubTrendingResult> => fetchGithubTrending({ since, limit, force })
  );

  // Market quotes (indices + equities via Stooq, crypto via CoinGecko) for the Stocks tab.
  newsChannels.marketQuotes.provider(async ({ force }): Promise<MarketQuotesResult> => {
    const symbols = store.getData().settings.marketSymbols;
    return fetchMarketQuotes({ force, symbols });
  });

  // Weather widget (keyless Open-Meteo). When the caller passes no location we
  // auto-detect from the public IP — and prefer the lat/lon that IP lookup
  // returns so we can skip geocoding (more reliable). A user-typed city goes
  // through geocoding.
  newsChannels.getWeather.provider(async ({ location }): Promise<WeatherResult> => {
    const place = (location ?? '').trim();
    if (place) {
      const forecast = await forecastByCity(place, 5).catch((): null => null);
      return forecast ? { ok: true, data: forecast } : { ok: false, error: 'weather-unavailable' };
    }
    // Auto mode: detect by IP.
    const detected = await detectLocationByIp().catch((): null => null);
    if (!detected) return { ok: false, error: 'location-unknown' };
    // Prefer direct coordinates (skips geocoding); fall back to city geocode.
    const forecast =
      detected.latitude != null && detected.longitude != null
        ? await forecastByCoords(detected.latitude, detected.longitude, detected.city, 5).catch((): null => null)
        : await forecastByCity(detected.city, 5).catch((): null => null);
    return forecast ? { ok: true, data: forecast } : { ok: false, error: 'weather-unavailable' };
  });

  // Live push: forward every store change to the renderer.
  unsubscribeChange?.();
  unsubscribeChange = store.onChange((data) => {
    newsChannels.dataChanged.emit(data);
  });
}

/** Detach the live push subscription (deterministic teardown for tests/hot-reload). */
export function disposeNewsBridge(): void {
  unsubscribeChange?.();
  unsubscribeChange = undefined;
}

/** Surface the fetch result type for the renderer client. */
export type { FetchFeedResult };
/** Surface the weather forecast type for the renderer client. */
export type { WeatherForecast };
/** Surface GitHub trending types for the renderer client. */
export type { GithubRepo, GithubTrendingResult, GithubTrendingSince };
/** Surface market quote types for the renderer client. */
export type { MarketKind, MarketQuote, MarketQuotesResult };
