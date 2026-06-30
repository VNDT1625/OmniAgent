/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { backtest } from '@process/news/bots/backtest';
import type { OHLCBar } from '@process/news/bots/botTypes';

const bars = (closes: number[]): OHLCBar[] =>
  closes.map((c, i) => ({ time: i * 86_400_000, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 }));

describe('backtest', () => {
  it('produces consistent metrics on a trending series', () => {
    // 80 bars: smooth uptrend so a trend strategy participates.
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 1.5);
    const res = backtest(
      'AAPL',
      bars(closes),
      'sma_crossover',
      { fastPeriod: 5, slowPeriod: 20 },
      { maxPositionPct: 0.5, stopLossPct: 0, takeProfitPct: 0 },
      10_000
    );
    expect(res.symbol).toBe('AAPL');
    expect(res.equityCurve.length).toBe(80);
    expect(res.buyHoldReturnPct).toBeCloseTo((closes.at(-1)! - closes[0]) / closes[0], 5);
    expect(res.finalEquity).toBeGreaterThan(0);
    expect(res.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(res.numTrades).toBeGreaterThan(0);
  });

  it('does not trade when there is not enough warmup data', () => {
    const res = backtest('AAPL', bars([100, 101, 102]), 'sma_crossover', { slowPeriod: 30 }, undefined, 10_000);
    expect(res.numTrades).toBe(0);
    expect(res.finalEquity).toBe(10_000);
  });

  it('respects stop-loss on a crash after entry', () => {
    // Rise to trigger a buy, then crash hard — stop-loss must cap the loss.
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const crash = Array.from({ length: 40 }, (_, i) => 129 - i * 2);
    const res = backtest(
      'AAPL',
      bars([...up, ...crash]),
      'sma_crossover',
      { fastPeriod: 5, slowPeriod: 20 },
      { maxPositionPct: 1, stopLossPct: 0.05, takeProfitPct: 0 },
      10_000
    );
    // A 5% stop on a gradual decline caps the loss well above a no-stop wipeout.
    expect(res.finalEquity).toBeGreaterThan(8_000);
  });
});
