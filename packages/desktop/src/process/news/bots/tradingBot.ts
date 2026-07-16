/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trading bot decision tick — risk-managed, deterministic.
 *
 * Given current prices, recent close history, and per-symbol news sentiment, it
 * (1) applies stop-loss / take-profit exits, (2) enforces hard risk gates
 * (daily-loss kill switch, max open positions, max trades/day), then (3) sizes
 * and places signal-driven entries via the paper broker. The SAME accounting as
 * the backtester is used, so paper results and backtests are consistent.
 *
 * **Live safety:** this module only ever performs PAPER accounting. Real-money
 * execution is delegated to an optional, explicitly-armed executor injected by
 * the engine; without it, a `live` bot refuses to trade and reports why. There
 * is no code path that places a real order without an armed, user-configured
 * executor.
 *
 * Pure (no IO/clock) — time, ids, and the optional live executor are injected.
 */

import { applyFill, equityOf, positionOf, updatePeak } from './paperBroker';
import { runStrategy } from './strategies';
import type { OrderSide, Portfolio, Signal, Trade, TradingBotState } from './botTypes';

export type LiveExecutor = (order: { symbol: string; side: OrderSide; qty: number; price: number }) => void;

export type TickContext = {
  /** Current price per symbol. Symbols without a price are skipped. */
  prices: Record<string, number>;
  /** Daily close history per symbol (oldest→newest) for indicators. */
  closesBySymbol: Record<string, number[]>;
  /** News sentiment per symbol in [-1, 1]. */
  sentimentBySymbol: Record<string, number>;
  now: number;
  idGen: () => string;
  /** Present only when the user explicitly armed live trading with creds. */
  liveExecutor?: LiveExecutor;
};

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const tradesToday = (pf: Portfolio, now: number): number => {
  const day = utcDay(now);
  return pf.trades.filter((t) => utcDay(t.time) === day).length;
};

/** Recompute the derived equity/return/drawdown fields of a state. */
const recompute = (state: TradingBotState, prices: Record<string, number>): TradingBotState => {
  const equity = equityOf(state.portfolio, prices);
  const portfolio = updatePeak(state.portfolio, equity);
  const returnPct = (equity - portfolio.startingCash) / portfolio.startingCash;
  const drawdownPct = portfolio.peakEquity > 0 ? (portfolio.peakEquity - equity) / portfolio.peakEquity : 0;
  return { ...state, portfolio, equity, returnPct, drawdownPct };
};

/**
 * Run one decision tick. Returns the next state + the trades executed this tick.
 * Never throws; rejected orders are simply skipped.
 */
export const tick = (state: TradingBotState, ctx: TickContext): { state: TradingBotState; trades: Trade[] } => {
  const { config } = state;
  const executed: Trade[] = [];
  let pf = state.portfolio;
  const lastSignals: Record<string, Signal> = { ...state.lastSignals };

  const fill = (symbol: string, side: OrderSide, qty: number, price: number, reason: string): boolean => {
    const res = applyFill(pf, { symbol, side, qty, price, time: ctx.now, reason, mode: config.mode, id: ctx.idGen() });
    if (!res.ok) return false;
    pf = res.portfolio;
    executed.push(res.trade);
    // Mirror to the real exchange only when an armed executor is present.
    if (config.mode === 'live' && config.liveArmed && ctx.liveExecutor) {
      try {
        ctx.liveExecutor({ symbol, side, qty, price });
      } catch {
        /* executor errors must not corrupt the ledger */
      }
    }
    return true;
  };

  // Live guard: refuse to trade live unless explicitly armed AND an executor exists.
  let haltedReason = state.haltedReason;
  if (config.mode === 'live' && (!config.liveArmed || !ctx.liveExecutor)) {
    haltedReason = 'live trading not configured (paper-only)';
  }

  // 1) Risk exits first (always allowed, even when halted).
  const exitedThisTick = new Set<string>();
  for (const symbol of config.symbols) {
    const price = ctx.prices[symbol];
    const pos = positionOf(pf, symbol);
    if (price == null || !pos) continue;
    const change = (price - pos.avgPrice) / pos.avgPrice;
    if (config.risk.stopLossPct > 0 && change <= -config.risk.stopLossPct) {
      if (fill(symbol, 'sell', pos.qty, price, 'stop-loss')) exitedThisTick.add(symbol);
    } else if (config.risk.takeProfitPct > 0 && change >= config.risk.takeProfitPct) {
      if (fill(symbol, 'sell', pos.qty, price, 'take-profit')) exitedThisTick.add(symbol);
    }
  }

  // 2) Daily-loss kill switch (halts NEW entries for the rest of the session).
  // equityOf already marks positions to market, so it reflects unrealized PnL;
  // compare it directly against starting cash (no double counting).
  const equityNow = equityOf(pf, ctx.prices);
  const dayPnlPct = (equityNow - pf.startingCash) / pf.startingCash;
  if (config.risk.dailyLossLimitPct > 0 && dayPnlPct <= -config.risk.dailyLossLimitPct && !haltedReason) {
    haltedReason = `daily loss limit hit (${(dayPnlPct * 100).toFixed(1)}%)`;
  }

  const canEnter = !haltedReason && tradesToday(pf, ctx.now) < config.risk.maxTradesPerDay;

  // 3) Signal-driven entries/exits.
  for (const symbol of config.symbols) {
    const price = ctx.prices[symbol];
    const closes = ctx.closesBySymbol[symbol] ?? [];
    if (price == null || closes.length === 0) continue;
    const sig = runStrategy(config.strategy, [...closes, price], config.params, {
      newsSentiment: ctx.sentimentBySymbol[symbol],
    });
    lastSignals[symbol] = sig;
    const pos = positionOf(pf, symbol);

    if (sig.action === 'sell' && pos) {
      fill(symbol, 'sell', pos.qty, price, sig.reason);
    } else if (sig.action === 'buy' && !pos && canEnter && !exitedThisTick.has(symbol)) {
      const openCount = pf.positions.length;
      if (openCount >= config.risk.maxOpenPositions) continue;
      if (tradesToday(pf, ctx.now) >= config.risk.maxTradesPerDay) continue;
      const equity = equityOf(pf, ctx.prices);
      const budget = equity * config.risk.maxPositionPct * Math.max(0.25, sig.strength);
      const qty = Math.floor(budget / price);
      if (qty > 0) fill(symbol, 'buy', qty, price, sig.reason);
    }
  }

  const next = recompute({ ...state, portfolio: pf, haltedReason, lastTickAt: ctx.now, lastSignals }, ctx.prices);
  return { state: next, trades: executed };
};
