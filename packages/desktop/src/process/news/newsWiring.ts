/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wiring for the News aggregator — builds the single set of services the
 * renderer UI (via `newsBridge`) shares with the Main-process bootstrap.
 *
 * {@link getNewsServices} lazily constructs (and caches) the store + scheduler.
 * Both resolve their on-disk root from the Electron `userData` dir lazily, so no
 * `app` access happens at import time.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { createNewsScheduler, type INewsScheduler } from './newsScheduler';
import { createNewsStore, type INewsStore } from './newsStore';
import { createMyMemoryTranslator } from './newsTranslator';
import { createRealtimeConnector, type IRealtimeConnector } from './realtimeConnector';
import { createBotEngine, type IBotEngine } from './bots/botEngine';
import { fetchMarketQuotes } from './marketFetcher';
import { fetchDailyHistory } from './bots/stooqHistory';

/** The shared News services for the whole Main process. */
export type NewsServices = {
  store: INewsStore;
  scheduler: INewsScheduler;
  realtime: IRealtimeConnector;
  bots: IBotEngine;
};

let shared: NewsServices | undefined;

/**
 * Resolve the shared {@link NewsServices}, constructing the defaults on first
 * use.
 */
export const getNewsServices = (): NewsServices => {
  if (shared) return shared;
  const store = createNewsStore();
  const translator = createMyMemoryTranslator();
  const scheduler = createNewsScheduler({ store, translator });
  const realtime = createRealtimeConnector({ store });
  const bots = createBotEngine({
    getPrices: async (symbols) => {
      const res = await fetchMarketQuotes();
      const out: Record<string, number> = {};
      if (res.ok) for (const q of res.quotes) if (symbols.includes(q.symbol) && q.price != null) out[q.symbol] = q.price;
      return out;
    },
    getHistory: async (symbol) => {
      const res = await fetchDailyHistory(symbol, { limit: 400 });
      return res.ok ? res.bars.map((b) => b.close) : [];
    },
    getNewsItems: () => store.getData().items,
    // No live executor wired: live mode stays paper-gated until a deliberate,
    // user-configured exchange adapter is added. The engine never auto-trades real money.
  });
  shared = { store, scheduler, realtime, bots };
  return shared;
};

/** Reset the cached services (deterministic teardown for tests/hot-reload). */
export const disposeNewsServices = (): void => {
  shared?.scheduler.stop();
  shared?.realtime.stop();
  shared?.bots.stop();
  shared = undefined;
};
