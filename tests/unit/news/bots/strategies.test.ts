/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  sma,
  rsi,
  smaCrossover,
  rsiReversion,
  breakout,
  newsSentiment,
  ensemble,
  runStrategy,
} from '@process/news/bots/strategies';

describe('indicators', () => {
  it('sma averages the last N', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1, 2], 5)).toBeNull();
  });

  it('rsi is 100 for monotonic gains and low for losses', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    expect(rsi(up, 14)).toBe(100);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    expect(rsi(down, 14)!).toBeLessThan(5);
  });
});

describe('strategies', () => {
  it('sma crossover buys an uptrend, sells a downtrend', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(smaCrossover(up, { fastPeriod: 5, slowPeriod: 20 }).action).toBe('buy');
    const down = Array.from({ length: 40 }, (_, i) => 200 - i);
    expect(smaCrossover(down, { fastPeriod: 5, slowPeriod: 20 }).action).toBe('sell');
  });

  it('rsi reversion buys oversold, sells overbought', () => {
    const down = Array.from({ length: 20 }, (_, i) => 100 - i * 2);
    expect(rsiReversion(down, { rsiPeriod: 14 }).action).toBe('buy');
    const up = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
    expect(rsiReversion(up, { rsiPeriod: 14 }).action).toBe('sell');
  });

  it('breakout fires on a new high', () => {
    const closes = [...Array.from({ length: 20 }, () => 100), 130];
    expect(breakout(closes, { breakoutPeriod: 20 }).action).toBe('buy');
  });

  it('news sentiment respects the threshold', () => {
    expect(newsSentiment({ sentimentThreshold: 0.3 }, { newsSentiment: 0.5 }).action).toBe('buy');
    expect(newsSentiment({ sentimentThreshold: 0.3 }, { newsSentiment: -0.5 }).action).toBe('sell');
    expect(newsSentiment({ sentimentThreshold: 0.3 }, { newsSentiment: 0.1 }).action).toBe('hold');
    expect(newsSentiment({}, {}).action).toBe('hold');
  });

  it('ensemble requires net agreement', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const sig = ensemble(up, { fastPeriod: 5, slowPeriod: 20 }, { newsSentiment: 0.6 });
    expect(sig.action).toBe('buy');
    expect(sig.reason).toContain('ensemble');
  });

  it('runStrategy dispatches and defaults to ensemble', () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(runStrategy('sma_crossover', up, { fastPeriod: 5, slowPeriod: 20 }).action).toBe('buy');
    expect(runStrategy('ensemble', up, { fastPeriod: 5, slowPeriod: 20 }, { newsSentiment: 0.6 }).action).toBe('buy');
  });
});
