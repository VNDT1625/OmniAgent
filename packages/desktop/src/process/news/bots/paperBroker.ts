/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Paper (simulated) broker — pure portfolio accounting.
 *
 * Executes market fills against a supplied price, books realized PnL on sells
 * (average-cost basis), and marks open positions to market for equity. No IO,
 * no clock of its own (time + ids injected), so it is fully deterministic and
 * is the exact same accounting the backtester uses — the paper bot and the
 * backtest cannot disagree.
 *
 * Live mode reuses the same accounting for its internal ledger; the real
 * exchange adapter (gated, opt-in) is layered on top in the trading bot.
 */

import type { OrderSide, Portfolio, Position, Trade, TradingMode } from './botTypes';

/** Find a position by symbol. */
export const positionOf = (pf: Portfolio, symbol: string): Position | undefined =>
  pf.positions.find((p) => p.symbol === symbol);

/** Mark-to-market equity = cash + Σ qty·price. Missing prices use avg cost. */
export const equityOf = (pf: Portfolio, prices: Record<string, number>): number => {
  let mtm = pf.cash;
  for (const pos of pf.positions) {
    const px = prices[pos.symbol] ?? pos.avgPrice;
    mtm += pos.qty * px;
  }
  return mtm;
};

/** Unrealized PnL of open positions at the given prices. */
export const unrealizedPnl = (pf: Portfolio, prices: Record<string, number>): number => {
  let pnl = 0;
  for (const pos of pf.positions) {
    const px = prices[pos.symbol] ?? pos.avgPrice;
    pnl += (px - pos.avgPrice) * pos.qty;
  }
  return pnl;
};

export type FillInput = {
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  time: number;
  reason: string;
  mode: TradingMode;
  id: string;
};

export type FillResult = { ok: true; portfolio: Portfolio; trade: Trade } | { ok: false; error: string };

/**
 * Apply a market fill and return the updated portfolio + trade. Rejects fills
 * that would oversell a position or overspend cash (no shorting, no margin in
 * the paper model — deliberately conservative).
 */
export const applyFill = (pf: Portfolio, input: FillInput): FillResult => {
  const { symbol, side, qty, price, time, reason, mode, id } = input;
  if (qty <= 0 || !Number.isFinite(qty) || price <= 0 || !Number.isFinite(price)) {
    return { ok: false, error: 'invalid order' };
  }
  const existing = positionOf(pf, symbol);

  if (side === 'buy') {
    const cost = qty * price;
    if (cost > pf.cash + 1e-9) return { ok: false, error: 'insufficient cash' };
    const newQty = (existing?.qty ?? 0) + qty;
    const newAvg = existing ? (existing.avgPrice * existing.qty + cost) / newQty : price;
    const positions = existing
      ? pf.positions.map((p) => (p.symbol === symbol ? { ...p, qty: newQty, avgPrice: newAvg } : p))
      : [...pf.positions, { symbol, qty, avgPrice: price, openedAt: time }];
    const trade: Trade = { id, symbol, side, qty, price, time, realizedPnl: 0, reason, mode };
    return { ok: true, trade, portfolio: { ...pf, cash: pf.cash - cost, positions, trades: [...pf.trades, trade] } };
  }

  // sell
  if (!existing || existing.qty < qty - 1e-9) return { ok: false, error: 'no position to sell' };
  const realized = (price - existing.avgPrice) * qty;
  const remaining = existing.qty - qty;
  const positions =
    remaining > 1e-9
      ? pf.positions.map((p) => (p.symbol === symbol ? { ...p, qty: remaining } : p))
      : pf.positions.filter((p) => p.symbol !== symbol);
  const trade: Trade = { id, symbol, side, qty, price, time, realizedPnl: realized, reason, mode };
  return {
    ok: true,
    trade,
    portfolio: {
      ...pf,
      cash: pf.cash + qty * price,
      realizedPnl: pf.realizedPnl + realized,
      positions,
      trades: [...pf.trades, trade],
    },
  };
};

/** Update the peak-equity high-water mark (for drawdown tracking). */
export const updatePeak = (pf: Portfolio, equity: number): Portfolio =>
  equity > pf.peakEquity ? { ...pf, peakEquity: equity } : pf;
