/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { tick, type TickContext } from '@process/news/bots/tradingBot';
import {
  defaultRiskLimits,
  emptyPortfolio,
  type Position,
  type TradingBotConfig,
  type TradingBotState,
} from '@process/news/bots/botTypes';

const cfg = (over: Partial<TradingBotConfig> = {}): TradingBotConfig => ({
  id: 'bot1',
  kind: 'trading',
  enabled: true,
  mode: 'paper',
  symbols: ['AAPL'],
  strategy: 'sma_crossover',
  params: { fastPeriod: 5, slowPeriod: 20 },
  risk: defaultRiskLimits(),
  intervalSec: 60,
  startingCash: 10_000,
  liveArmed: false,
  ...over,
});

const state = (over: Partial<TradingBotState> = {}, configOver: Partial<TradingBotConfig> = {}): TradingBotState => ({
  config: cfg(configOver),
  portfolio: emptyPortfolio(10_000),
  equity: 10_000,
  returnPct: 0,
  drawdownPct: 0,
  haltedReason: null,
  lastTickAt: null,
  lastSignals: {},
  ...over,
});

const ctx = (over: Partial<TickContext> = {}): TickContext => ({
  prices: { AAPL: 140 },
  closesBySymbol: { AAPL: Array.from({ length: 30 }, (_, i) => 100 + i) },
  sentimentBySymbol: {},
  now: Date.parse('2026-06-09T12:00:00Z'),
  idGen: (() => {
    let n = 0;
    return () => `t${n++}`;
  })(),
  ...over,
});

const withPosition = (qty: number, avgPrice: number): Position[] => [{ symbol: 'AAPL', qty, avgPrice, openedAt: 0 }];

describe('tradingBot.tick', () => {
  it('opens a position on a buy signal (paper)', () => {
    const res = tick(state(), ctx());
    expect(res.trades.length).toBe(1);
    expect(res.trades[0].side).toBe('buy');
    expect(res.state.portfolio.positions[0].symbol).toBe('AAPL');
  });

  it('exits via stop-loss before evaluating new signals', () => {
    const pf = { ...emptyPortfolio(10_000), cash: 9_000, positions: withPosition(10, 100) };
    const res = tick(state({ portfolio: pf }), ctx({ prices: { AAPL: 90 } }));
    const sell = res.trades.find((t) => t.side === 'sell');
    expect(sell?.reason).toBe('stop-loss');
    expect(res.state.portfolio.positions).toHaveLength(0);
  });

  it('halts new entries when the daily loss limit is breached', () => {
    // Position deep underwater → equity well below the 5% limit.
    const pf = { ...emptyPortfolio(10_000), cash: 0, positions: withPosition(100, 100) };
    const res = tick(
      state({ portfolio: pf }, { risk: { ...defaultRiskLimits(), stopLossPct: 0, dailyLossLimitPct: 0.05 } }),
      ctx({ prices: { AAPL: 50 } })
    );
    expect(res.state.haltedReason).toContain('daily loss limit');
    expect(res.trades.some((t) => t.side === 'buy')).toBe(false);
  });

  it('refuses live trading without an armed executor', () => {
    const res = tick(state({}, { mode: 'live', liveArmed: false }), ctx());
    expect(res.state.haltedReason).toContain('live trading not configured');
    expect(res.trades.some((t) => t.side === 'buy')).toBe(false);
  });

  it('mirrors to the live executor when armed', () => {
    const liveExecutor = vi.fn();
    const res = tick(state({}, { mode: 'live', liveArmed: true }), ctx({ liveExecutor }));
    expect(res.trades[0]?.side).toBe('buy');
    expect(liveExecutor).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'AAPL', side: 'buy' }));
  });

  it('respects maxTradesPerDay', () => {
    const today = Date.parse('2026-06-09T09:00:00Z');
    const pf = {
      ...emptyPortfolio(10_000),
      trades: Array.from({ length: 3 }, (_, i) => ({
        id: `x${i}`,
        symbol: 'AAPL',
        side: 'buy' as const,
        qty: 1,
        price: 100,
        time: today,
        realizedPnl: 0,
        reason: 'r',
        mode: 'paper' as const,
      })),
    };
    const res = tick(state({ portfolio: pf }, { risk: { ...defaultRiskLimits(), maxTradesPerDay: 3 } }), ctx());
    expect(res.trades.some((t) => t.side === 'buy')).toBe(false);
  });
});
