/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single-symbol backtester.
 *
 * Replays daily bars through the SAME strategy + paper-broker accounting the
 * live paper bot uses, applying stop-loss / take-profit / position-size limits
 * each bar. Reports risk-adjusted metrics AND the buy-and-hold benchmark, so a
 * strategy that merely tracks the market is not mistaken for skill. Honest
 * metrics (vs benchmark, drawdown, Sharpe, trade count) are the antidote to the
 * "guaranteed-best bot" myth — they show what a strategy actually does.
 *
 * Pure + deterministic (no IO, no clock). No Node/DOM imports.
 */

import { applyFill, equityOf, positionOf, updatePeak } from './paperBroker';
import { runStrategy } from './strategies';
import {
  emptyPortfolio,
  type BacktestResult,
  type OHLCBar,
  type Portfolio,
  type RiskLimits,
  type StrategyId,
  type StrategyParams,
} from './botTypes';

const TRADING_DAYS = 252;

const warmupFor = (strategy: StrategyId, params: StrategyParams): number => {
  const candidates = [
    params.slowPeriod ?? 30,
    params.rsiPeriod ?? 14,
    params.breakoutPeriod ?? 20,
    params.fastPeriod ?? 10,
  ];
  return Math.max(2, ...candidates) + 1;
};

const stddev = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
};

/**
 * Backtest one symbol. `newsSentiment`, if given, is applied as a constant
 * context across the window (historical per-bar sentiment is not available
 * keyless); strategies that don't use it are unaffected.
 */
export const backtest = (
  symbol: string,
  bars: OHLCBar[],
  strategy: StrategyId,
  params: StrategyParams = {},
  risk: Pick<RiskLimits, 'maxPositionPct' | 'stopLossPct' | 'takeProfitPct'> = {
    maxPositionPct: 0.2,
    stopLossPct: 0.05,
    takeProfitPct: 0.12,
  },
  startingCash = 10_000,
  newsSentiment?: number
): BacktestResult => {
  let pf: Portfolio = emptyPortfolio(startingCash);
  const equityCurve: Array<{ time: number; equity: number }> = [];
  const dailyReturns: number[] = [];
  const warmup = warmupFor(strategy, params);
  const closes: number[] = [];
  let prevEquity = startingCash;
  let seq = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    closes.push(bar.close);
    const price = bar.close;
    const prices = { [symbol]: price };

    // 1) Risk exits on the open position (stop-loss / take-profit at bar close).
    const pos = positionOf(pf, symbol);
    if (pos) {
      const change = (price - pos.avgPrice) / pos.avgPrice;
      const hitStop = risk.stopLossPct > 0 && change <= -risk.stopLossPct;
      const hitTake = risk.takeProfitPct > 0 && change >= risk.takeProfitPct;
      if (hitStop || hitTake) {
        const res = applyFill(pf, {
          symbol,
          side: 'sell',
          qty: pos.qty,
          price,
          time: bar.time,
          reason: hitStop ? 'stop-loss' : 'take-profit',
          mode: 'paper',
          id: `bt-${seq++}`,
        });
        if (res.ok) pf = res.portfolio;
      }
    }

    // 2) Strategy decision (needs warmup history).
    if (i >= warmup) {
      const sig = runStrategy(strategy, closes, params, { newsSentiment });
      const open = positionOf(pf, symbol);
      if (sig.action === 'buy' && !open) {
        const equity = equityOf(pf, prices);
        const budget = equity * risk.maxPositionPct * Math.max(0.2, sig.strength);
        const qty = Math.floor(budget / price);
        if (qty > 0) {
          const res = applyFill(pf, {
            symbol,
            side: 'buy',
            qty,
            price,
            time: bar.time,
            reason: sig.reason,
            mode: 'paper',
            id: `bt-${seq++}`,
          });
          if (res.ok) pf = res.portfolio;
        }
      } else if (sig.action === 'sell' && open) {
        const res = applyFill(pf, {
          symbol,
          side: 'sell',
          qty: open.qty,
          price,
          time: bar.time,
          reason: sig.reason,
          mode: 'paper',
          id: `bt-${seq++}`,
        });
        if (res.ok) pf = res.portfolio;
      }
    }

    const equity = equityOf(pf, prices);
    pf = updatePeak(pf, equity);
    equityCurve.push({ time: bar.time, equity });
    if (prevEquity > 0) dailyReturns.push((equity - prevEquity) / prevEquity);
    prevEquity = equity;
  }

  // Metrics.
  const finalEquity = equityCurve.at(-1)?.equity ?? startingCash;
  const totalReturnPct = (finalEquity - startingCash) / startingCash;
  const firstClose = bars[0]?.close ?? 0;
  const lastClose = bars.at(-1)?.close ?? 0;
  const buyHoldReturnPct = firstClose > 0 ? (lastClose - firstClose) / firstClose : 0;

  let peak = startingCash;
  let maxDd = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    if (dd > maxDd) maxDd = dd;
  }

  const sells = pf.trades.filter((t) => t.side === 'sell');
  const wins = sells.filter((t) => t.realizedPnl > 0).length;
  const winRate = sells.length > 0 ? wins / sells.length : 0;

  const sd = stddev(dailyReturns);
  const meanRet = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const sharpe = sd > 0 ? (meanRet / sd) * Math.sqrt(TRADING_DAYS) : 0;

  return {
    symbol,
    strategy,
    startingCash,
    finalEquity,
    totalReturnPct,
    buyHoldReturnPct,
    maxDrawdownPct: maxDd,
    winRate,
    numTrades: pf.trades.length,
    sharpe,
    equityCurve,
  };
};
