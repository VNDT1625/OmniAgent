/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bot engine — orchestrates the News bot + Trading bot for the Realtime tabs.
 *
 * Owns one news bot and one trading bot (one per tab), persists their config +
 * state atomically to `bots-data.json`, and ticks them on a timer: the trading
 * bot pulls live prices + daily history + per-symbol news sentiment and runs a
 * risk-managed decision; the news bot scores the current items into alerts.
 * State changes are pushed to the renderer via {@link onChange}.
 *
 * **Real-money safety:** no live execution adapter is wired by default, so a
 * `live` bot is hard-gated to paper-only by {@link tick} until a deliberate,
 * user-configured exchange adapter is injected. The engine never places a real
 * order on its own.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NewsItem } from '../newsTypes';
import { backtest } from './backtest';
import { computeNewsAlerts, aggregateSymbolSentiment, DEFAULT_SYMBOL_ALIASES } from './newsBot';
import { tick, type LiveExecutor } from './tradingBot';
import {
  defaultRiskLimits,
  emptyPortfolio,
  type BacktestResult,
  type NewsBotConfig,
  type NewsBotState,
  type StrategyId,
  type StrategyParams,
  type TradingBotConfig,
  type TradingBotState,
} from './botTypes';

const DATA_FILE = 'bots-data.json';
const DATA_VERSION = 1 as const;

export type BotsData = {
  version: typeof DATA_VERSION;
  trading: TradingBotState;
  news: NewsBotState;
};

const defaultTradingConfig = (): TradingBotConfig => ({
  id: 'trading-1',
  kind: 'trading',
  enabled: false,
  mode: 'paper',
  symbols: ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'TSLA'],
  strategy: 'ensemble',
  params: {},
  risk: defaultRiskLimits(),
  intervalSec: 60,
  startingCash: 10_000,
  liveArmed: false,
});

const defaultNewsConfig = (): NewsBotConfig => ({
  id: 'news-1',
  kind: 'news',
  enabled: false,
  watchKeywords: [],
  alertThreshold: 0.3,
  maxAlerts: 50,
});

const defaultData = (): BotsData => ({
  version: DATA_VERSION,
  trading: {
    config: defaultTradingConfig(),
    portfolio: emptyPortfolio(10_000),
    equity: 10_000,
    returnPct: 0,
    drawdownPct: 0,
    haltedReason: null,
    lastTickAt: null,
    lastSignals: {},
  },
  news: { config: defaultNewsConfig(), alerts: [], lastTickAt: null },
});

/** Injected dependencies (data providers are injectable for tests). */
export type BotEngineDeps = {
  dir?: string;
  now?: () => number;
  newId?: () => string;
  /** Resolve current prices for the given symbols. */
  getPrices: (symbols: string[]) => Promise<Record<string, number>>;
  /** Resolve daily close history (oldest→newest) for a symbol. */
  getHistory: (symbol: string) => Promise<number[]>;
  /** Current news items (for sentiment + alerts). */
  getNewsItems: () => NewsItem[];
  setInterval?: (handler: () => void, ms: number) => { clear: () => void };
  /** Optional live executor factory — ABSENT by default (paper-only). */
  liveExecutorFactory?: (config: TradingBotConfig) => LiveExecutor | undefined;
};

export type IBotEngine = {
  load(): Promise<BotsData>;
  getData(): BotsData;
  start(): Promise<void>;
  stop(): void;
  tickNow(): Promise<void>;
  updateTradingConfig(patch: Partial<TradingBotConfig>): Promise<BotsData>;
  updateNewsConfig(patch: Partial<NewsBotConfig>): Promise<BotsData>;
  resetPortfolio(): Promise<BotsData>;
  /** Kill switch: halt the trading bot immediately. */
  haltTrading(reason: string): Promise<BotsData>;
  runBacktest(req: { symbol: string; strategy: StrategyId; params?: StrategyParams; startingCash?: number }): Promise<BacktestResult>;
  onChange(listener: (data: BotsData) => void): () => void;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export const createBotEngine = (deps: BotEngineDeps): IBotEngine => {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;
  const dir = deps.dir ?? app.getPath('userData');
  const filePath = path.join(dir, DATA_FILE);
  const listeners = new Set<(d: BotsData) => void>();
  const scheduleInterval =
    deps.setInterval ??
    ((handler: () => void, ms: number) => {
      const id = setInterval(handler, ms);
      return { clear: () => clearInterval(id) };
    });

  let data: BotsData = defaultData();
  let loaded = false;
  let handle: { clear: () => void } | undefined;
  let ticking = false;

  const persist = async (next: BotsData): Promise<BotsData> => {
    data = next;
    const tmp = `${filePath}.tmp`;
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fs.promises.rename(tmp, filePath);
    for (const l of listeners) {
      try {
        l(next);
      } catch (e) {
        console.error('[BotEngine] listener threw:', e);
      }
    }
    return next;
  };

  const load = async (): Promise<BotsData> => {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (isObject(parsed) && isObject(parsed.trading) && isObject(parsed.news)) {
        // Merge onto defaults so newly-added fields are always present.
        const base = defaultData();
        data = {
          version: DATA_VERSION,
          trading: { ...base.trading, ...(parsed.trading as TradingBotState), config: { ...base.trading.config, ...((parsed.trading as TradingBotState).config ?? {}) } },
          news: { ...base.news, ...(parsed.news as NewsBotState), config: { ...base.news.config, ...((parsed.news as NewsBotState).config ?? {}) } },
        };
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') console.warn('[BotEngine] read failed; using defaults:', e);
      data = defaultData();
    }
    loaded = true;
    return data;
  };

  const ensureLoaded = async (): Promise<void> => {
    if (!loaded) await load();
  };

  /** Run the trading bot once if due. */
  const tickTrading = async (): Promise<void> => {
    const state = data.trading;
    if (!state.config.enabled) return;
    const due = state.lastTickAt == null || now() - state.lastTickAt >= state.config.intervalSec * 1000;
    if (!due) return;
    const symbols = state.config.symbols;
    const [prices, sentiment] = await Promise.all([
      deps.getPrices(symbols).catch((): Record<string, number> => ({})),
      Promise.resolve(aggregateSymbolSentiment(deps.getNewsItems(), DEFAULT_SYMBOL_ALIASES)),
    ]);
    const closesBySymbol: Record<string, number[]> = {};
    await Promise.all(
      symbols.map(async (s) => {
        closesBySymbol[s] = await deps.getHistory(s).catch((): number[] => []);
      })
    );
    const liveExecutor = deps.liveExecutorFactory?.(state.config);
    const { state: nextState } = tick(state, { prices, closesBySymbol, sentimentBySymbol: sentiment, now: now(), idGen: newId, liveExecutor });
    await persist({ ...data, trading: nextState });
  };

  /** Run the news bot once. */
  const tickNews = async (): Promise<void> => {
    const state = data.news;
    if (!state.config.enabled) return;
    const alerts = computeNewsAlerts(deps.getNewsItems(), state.config, (item) => `alert-${item.id}-${newId().slice(0, 6)}`);
    await persist({ ...data, news: { ...state, alerts, lastTickAt: now() } });
  };

  const tickNow = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      await tickNews();
      await tickTrading();
    } catch (e) {
      console.error('[BotEngine] tick failed:', e);
    } finally {
      ticking = false;
    }
  };

  return {
    load,
    getData: () => data,

    async start() {
      await load();
      if (handle) return;
      handle = scheduleInterval(() => void tickNow(), 15_000);
      void tickNow();
    },

    stop() {
      handle?.clear();
      handle = undefined;
    },

    tickNow,

    async updateTradingConfig(patch) {
      await ensureLoaded();
      // Guard: arming live requires mode === 'live' explicitly; never auto-arm.
      const config = { ...data.trading.config, ...patch };
      if (config.mode !== 'live') config.liveArmed = false;
      return persist({ ...data, trading: { ...data.trading, config, haltedReason: patch.enabled === false ? data.trading.haltedReason : data.trading.haltedReason } });
    },

    async updateNewsConfig(patch) {
      await ensureLoaded();
      return persist({ ...data, news: { ...data.news, config: { ...data.news.config, ...patch } } });
    },

    async resetPortfolio() {
      await ensureLoaded();
      const startingCash = data.trading.config.startingCash;
      return persist({
        ...data,
        trading: { ...data.trading, portfolio: emptyPortfolio(startingCash), equity: startingCash, returnPct: 0, drawdownPct: 0, haltedReason: null, lastSignals: {} },
      });
    },

    async haltTrading(reason) {
      await ensureLoaded();
      return persist({ ...data, trading: { ...data.trading, config: { ...data.trading.config, enabled: false }, haltedReason: reason } });
    },

    async runBacktest(req) {
      const bars = await deps.getHistory(req.symbol);
      const ohlc = bars.map((close, i) => ({ time: i * 86_400_000, open: close, high: close, low: close, close, volume: 0 }));
      return backtest(req.symbol, ohlc, req.strategy, req.params ?? {}, undefined, req.startingCash ?? 10_000);
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
