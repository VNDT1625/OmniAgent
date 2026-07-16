/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bot IPC bridge — exposes the news + trading bot engine to the renderer.
 *
 * Electron-native bridge (`@office-ai/platform`). Channel-name constants are the
 * renderer-safe contract (mirrored in `botBridgeClient.ts`); every handler
 * resolves a {@link BotResult} envelope so a thrown error never leaves the
 * renderer's invoke pending.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type { IBotEngine, BotsData } from './botEngine';
import type { BacktestResult, NewsBotConfig, StrategyId, StrategyParams, TradingBotConfig } from './botTypes';

export const BOT_CHANNELS = {
  getData: 'bot.get-data',
  updateTrading: 'bot.update-trading',
  updateNews: 'bot.update-news',
  resetPortfolio: 'bot.reset-portfolio',
  halt: 'bot.halt',
  tickNow: 'bot.tick-now',
  backtest: 'bot.backtest',
  dataChanged: 'bot.data-changed',
} as const;

export type UpdateTradingRequest = { patch: Partial<TradingBotConfig> };
export type UpdateNewsRequest = { patch: Partial<NewsBotConfig> };
export type HaltRequest = { reason: string };
export type BacktestRequest = { symbol: string; strategy: StrategyId; params?: StrategyParams; startingCash?: number };

export type BotResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const botChannels = {
  getData: bridge.buildProvider<BotResult<BotsData>, void>(BOT_CHANNELS.getData),
  updateTrading: bridge.buildProvider<BotResult<BotsData>, UpdateTradingRequest>(BOT_CHANNELS.updateTrading),
  updateNews: bridge.buildProvider<BotResult<BotsData>, UpdateNewsRequest>(BOT_CHANNELS.updateNews),
  resetPortfolio: bridge.buildProvider<BotResult<BotsData>, void>(BOT_CHANNELS.resetPortfolio),
  halt: bridge.buildProvider<BotResult<BotsData>, HaltRequest>(BOT_CHANNELS.halt),
  tickNow: bridge.buildProvider<BotResult<BotsData>, void>(BOT_CHANNELS.tickNow),
  backtest: bridge.buildProvider<BotResult<BacktestResult>, BacktestRequest>(BOT_CHANNELS.backtest),
  dataChanged: bridge.buildEmitter<BotsData>(BOT_CHANNELS.dataChanged),
};

let unsubscribe: (() => void) | undefined;

export function registerBotBridge(options: { engine: IBotEngine }): void {
  const { engine } = options;

  const safe =
    <Req, Res>(label: string, handler: (req: Req) => Promise<Res>) =>
    async (req: Req): Promise<BotResult<Res>> => {
      try {
        return { ok: true, data: await handler(req) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[BotBridge] ${label} failed:`, error);
        return { ok: false, error: message };
      }
    };

  botChannels.getData.provider(safe('getData', () => engine.load()));
  botChannels.updateTrading.provider(safe('updateTrading', ({ patch }) => engine.updateTradingConfig(patch)));
  botChannels.updateNews.provider(safe('updateNews', ({ patch }) => engine.updateNewsConfig(patch)));
  botChannels.resetPortfolio.provider(safe('resetPortfolio', () => engine.resetPortfolio()));
  botChannels.halt.provider(safe('halt', ({ reason }) => engine.haltTrading(reason)));
  botChannels.tickNow.provider(
    safe('tickNow', async () => {
      await engine.tickNow();
      return engine.getData();
    })
  );
  botChannels.backtest.provider(safe('backtest', (req) => engine.runBacktest(req)));

  unsubscribe?.();
  unsubscribe = engine.onChange((d) => botChannels.dataChanged.emit(d));
}

export function disposeBotBridge(): void {
  unsubscribe?.();
  unsubscribe = undefined;
}

export type { BotsData };
