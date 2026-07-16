/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { applyFill, equityOf, unrealizedPnl, positionOf } from '@process/news/bots/paperBroker';
import { emptyPortfolio } from '@process/news/bots/botTypes';

const buy = (pf: ReturnType<typeof emptyPortfolio>, qty: number, price: number, id = 'i') =>
  applyFill(pf, { symbol: 'AAPL', side: 'buy', qty, price, time: 1, reason: 'r', mode: 'paper', id });
const sell = (pf: ReturnType<typeof emptyPortfolio>, qty: number, price: number, id = 'i') =>
  applyFill(pf, { symbol: 'AAPL', side: 'sell', qty, price, time: 2, reason: 'r', mode: 'paper', id });

describe('paperBroker', () => {
  it('buys, holding cash and position correctly', () => {
    const res = buy(emptyPortfolio(1000), 5, 100);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.portfolio.cash).toBe(500);
    expect(positionOf(res.portfolio, 'AAPL')).toMatchObject({ qty: 5, avgPrice: 100 });
  });

  it('rejects buys that exceed cash', () => {
    const res = buy(emptyPortfolio(100), 5, 100);
    expect(res.ok).toBe(false);
  });

  it('averages cost on add and books realized PnL on sell', () => {
    let pf = emptyPortfolio(10_000);
    pf = (buy(pf, 10, 100, 'a') as { ok: true; portfolio: typeof pf }).portfolio;
    pf = (buy(pf, 10, 200, 'b') as { ok: true; portfolio: typeof pf }).portfolio;
    expect(positionOf(pf, 'AAPL')?.avgPrice).toBe(150);
    const res = sell(pf, 20, 180, 'c');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.trade.realizedPnl).toBe((180 - 150) * 20);
    expect(positionOf(res.portfolio, 'AAPL')).toBeUndefined();
  });

  it('rejects selling more than held', () => {
    let pf = emptyPortfolio(10_000);
    pf = (buy(pf, 5, 100) as { ok: true; portfolio: typeof pf }).portfolio;
    expect(sell(pf, 10, 100).ok).toBe(false);
  });

  it('computes equity and unrealized PnL at mark price', () => {
    let pf = emptyPortfolio(1000);
    pf = (buy(pf, 5, 100) as { ok: true; portfolio: typeof pf }).portfolio;
    expect(equityOf(pf, { AAPL: 120 })).toBe(500 + 5 * 120);
    expect(unrealizedPnl(pf, { AAPL: 120 })).toBe((120 - 100) * 5);
  });

  it('rejects invalid orders', () => {
    expect(buy(emptyPortfolio(1000), 0, 100).ok).toBe(false);
    expect(buy(emptyPortfolio(1000), 5, 0).ok).toBe(false);
  });
});
