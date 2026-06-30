/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Trading strategies + technical indicators.
 *
 * All pure + deterministic so they are unit-testable and backtest-reproducible.
 * Each strategy maps a price history (oldest→newest) + optional context into a
 * {@link Signal}. The `ensemble` strategy is the headline one: it blends the
 * technical strategies with the app's unique news-sentiment signal and only
 * acts on net agreement — diversification of signals is what reduces overfit,
 * not a single "magic" rule.
 *
 * No Node/DOM imports — safe anywhere.
 */

import type { Signal, StrategyContext, StrategyId, StrategyParams } from './botTypes';

const HOLD: Signal = { action: 'hold', strength: 0, reason: 'no signal' };

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

/** Simple moving average of the last `period` values, or null if not enough data. */
export const sma = (values: number[], period: number): number | null => {
  if (period <= 0 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
};

/**
 * Wilder's RSI over `period`, or null if not enough data. Returns 0..100.
 */
export const rsi = (closes: number[], period: number): number | null => {
  if (period <= 0 || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  // Seed with the first `period` changes.
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};

/** Standard deviation of the last `period` values (population), or null. */
export const stddev = (values: number[], period: number): number | null => {
  if (period <= 1 || values.length < period) return null;
  const slice = values.slice(values.length - period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  return Math.sqrt(variance);
};

// ---------------------------------------------------------------------------
// Individual strategies
// ---------------------------------------------------------------------------

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Fast/slow SMA crossover (trend following). */
export const smaCrossover = (closes: number[], params: StrategyParams): Signal => {
  const fast = params.fastPeriod ?? 10;
  const slow = params.slowPeriod ?? 30;
  const f = sma(closes, fast);
  const s = sma(closes, slow);
  if (f == null || s == null) return HOLD;
  const spread = (f - s) / s;
  if (f > s)
    return {
      action: 'buy',
      strength: clamp01(Math.abs(spread) * 20),
      reason: `SMA${fast}>${slow} (+${(spread * 100).toFixed(2)}%)`,
    };
  if (f < s)
    return {
      action: 'sell',
      strength: clamp01(Math.abs(spread) * 20),
      reason: `SMA${fast}<${slow} (${(spread * 100).toFixed(2)}%)`,
    };
  return HOLD;
};

/** RSI mean-reversion (buy oversold, sell overbought). */
export const rsiReversion = (closes: number[], params: StrategyParams): Signal => {
  const period = params.rsiPeriod ?? 14;
  const oversold = params.rsiOversold ?? 30;
  const overbought = params.rsiOverbought ?? 70;
  const r = rsi(closes, period);
  if (r == null) return HOLD;
  if (r <= oversold)
    return { action: 'buy', strength: clamp01((oversold - r) / oversold), reason: `RSI ${r.toFixed(1)} ≤ ${oversold}` };
  if (r >= overbought)
    return {
      action: 'sell',
      strength: clamp01((r - overbought) / (100 - overbought)),
      reason: `RSI ${r.toFixed(1)} ≥ ${overbought}`,
    };
  return HOLD;
};

/** Donchian-style breakout: buy new highs, sell new lows. */
export const breakout = (closes: number[], params: StrategyParams): Signal => {
  const period = params.breakoutPeriod ?? 20;
  if (closes.length < period + 1) return HOLD;
  const window = closes.slice(closes.length - period - 1, closes.length - 1);
  const hi = Math.max(...window);
  const lo = Math.min(...window);
  const last = closes[closes.length - 1];
  if (last > hi)
    return { action: 'buy', strength: clamp01(((last - hi) / hi) * 20), reason: `breakout > ${period}-bar high` };
  if (last < lo)
    return { action: 'sell', strength: clamp01(((lo - last) / lo) * 20), reason: `breakdown < ${period}-bar low` };
  return HOLD;
};

/** News-sentiment momentum (the app's edge): act on strong aggregate sentiment. */
export const newsSentiment = (params: StrategyParams, ctx: StrategyContext): Signal => {
  const threshold = params.sentimentThreshold ?? 0.25;
  const s = ctx.newsSentiment;
  if (s == null) return HOLD;
  if (s >= threshold) return { action: 'buy', strength: clamp01(s), reason: `news sentiment +${s.toFixed(2)}` };
  if (s <= -threshold) return { action: 'sell', strength: clamp01(-s), reason: `news sentiment ${s.toFixed(2)}` };
  return HOLD;
};

// ---------------------------------------------------------------------------
// Ensemble
// ---------------------------------------------------------------------------

/** Map a signal to a signed, strength-weighted vote in [-1, 1]. */
const vote = (sig: Signal): number => (sig.action === 'buy' ? sig.strength : sig.action === 'sell' ? -sig.strength : 0);

/**
 * Weighted blend of all sub-strategies. Only acts when net agreement clears the
 * threshold, so a single noisy signal can't trigger a trade. This is the
 * default + recommended strategy.
 */
export const ensemble = (closes: number[], params: StrategyParams, ctx: StrategyContext): Signal => {
  const components: Array<{ sig: Signal; weight: number; label: string }> = [
    { sig: smaCrossover(closes, params), weight: 0.3, label: 'SMA' },
    { sig: rsiReversion(closes, params), weight: 0.2, label: 'RSI' },
    { sig: breakout(closes, params), weight: 0.25, label: 'BRK' },
    { sig: newsSentiment(params, ctx), weight: 0.25, label: 'NEWS' },
  ];
  let net = 0;
  let weightSum = 0;
  const agree: string[] = [];
  for (const c of components) {
    const v = vote(c.sig);
    if (v !== 0) {
      net += v * c.weight;
      weightSum += c.weight;
      agree.push(`${c.label}:${c.sig.action[0].toUpperCase()}`);
    }
  }
  if (weightSum === 0) return HOLD;
  const threshold = params.ensembleThreshold ?? 0.18;
  const strength = clamp01(Math.abs(net));
  if (net >= threshold) return { action: 'buy', strength, reason: `ensemble +${net.toFixed(2)} [${agree.join(' ')}]` };
  if (net <= -threshold) return { action: 'sell', strength, reason: `ensemble ${net.toFixed(2)} [${agree.join(' ')}]` };
  return { action: 'hold', strength, reason: `ensemble ${net.toFixed(2)} below threshold` };
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Run the named strategy against a close-price history (oldest→newest). */
export const runStrategy = (
  strategy: StrategyId,
  closes: number[],
  params: StrategyParams = {},
  ctx: StrategyContext = {}
): Signal => {
  switch (strategy) {
    case 'sma_crossover':
      return smaCrossover(closes, params);
    case 'rsi_reversion':
      return rsiReversion(closes, params);
    case 'breakout':
      return breakout(closes, params);
    case 'news_sentiment':
      return newsSentiment(params, ctx);
    case 'ensemble':
    default:
      return ensemble(closes, params, ctx);
  }
};
