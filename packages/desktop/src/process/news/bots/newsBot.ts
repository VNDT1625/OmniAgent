/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * News bot — the brain of the News tab's bot.
 *
 * Watches the aggregated news/social items and, with NO LLM (a transparent
 * finance-oriented lexicon + cross-source trend strength), raises alerts for
 * keyword-matched, high-sentiment, or multi-source-corroborated stories. It
 * also exposes per-symbol aggregate sentiment that the trading bot consumes as
 * one of its ensemble signals — this is the cross-feature edge AionUi has that
 * a standalone trading bot does not.
 *
 * Pure + deterministic. No Node/DOM imports.
 */

import type { NewsItem } from '../newsTypes';
import type { NewsAlert, NewsBotConfig } from './botTypes';

// ---------------------------------------------------------------------------
// Lexicon sentiment (no AI)
// ---------------------------------------------------------------------------

const POSITIVE = new Set([
  'beat',
  'beats',
  'surge',
  'surges',
  'soar',
  'soars',
  'rally',
  'rallies',
  'gain',
  'gains',
  'jump',
  'jumps',
  'record',
  'profit',
  'profits',
  'growth',
  'upgrade',
  'upgraded',
  'bullish',
  'outperform',
  'breakthrough',
  'win',
  'wins',
  'approved',
  'boost',
  'boosts',
  'rise',
  'rises',
  'strong',
  'success',
  'partnership',
  'expand',
  'expands',
  'optimistic',
  'recover',
  'recovery',
  'milestone',
  'demand',
  'raises',
]);

const NEGATIVE = new Set([
  'miss',
  'misses',
  'plunge',
  'plunges',
  'crash',
  'crashes',
  'slump',
  'fall',
  'falls',
  'drop',
  'drops',
  'loss',
  'losses',
  'downgrade',
  'downgraded',
  'bearish',
  'underperform',
  'lawsuit',
  'probe',
  'fraud',
  'recall',
  'layoff',
  'layoffs',
  'ban',
  'banned',
  'warning',
  'weak',
  'decline',
  'declines',
  'cut',
  'cuts',
  'fail',
  'fails',
  'bankruptcy',
  'default',
  'sanction',
  'sanctions',
  'fine',
  'fined',
  'slowdown',
  'risk',
  'fears',
]);

const NEGATORS = new Set(['no', 'not', 'never', "n't", 'without', 'fails', 'unable']);

/** Tokenise to lower-cased word tokens. */
const tokenize = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

/**
 * Lexicon sentiment in [-1, 1]. A preceding negator within one token flips the
 * polarity. Normalised by hit count so long texts don't dominate.
 */
export const scoreSentiment = (text: string): number => {
  if (!text) return 0;
  const tokens = tokenize(text);
  let score = 0;
  let hits = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const polarity = POSITIVE.has(tok) ? 1 : NEGATIVE.has(tok) ? -1 : 0;
    if (polarity === 0) continue;
    const negated = i > 0 && NEGATORS.has(tokens[i - 1]);
    score += negated ? -polarity : polarity;
    hits += 1;
  }
  if (hits === 0) return 0;
  // Squash to [-1,1]: average polarity, scaled by confidence in the hit count.
  const avg = score / hits;
  const confidence = Math.min(1, hits / 3);
  return Math.max(-1, Math.min(1, avg * confidence));
};

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

const matchedKeywordsOf = (text: string, keywords: string[]): string[] => {
  const lc = text.toLowerCase();
  return keywords.filter((k) => k && lc.includes(k));
};

/** Distinct-source count for a title, by exact-ish normalised title across items. */
const sourceCountByTitle = (items: NewsItem[]): Map<string, number> => {
  const feedsByKey = new Map<string, Set<string>>();
  for (const it of items) {
    const key = it.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .slice(0, 60);
    if (!key) continue;
    const set = feedsByKey.get(key) ?? new Set<string>();
    set.add(it.feedId);
    feedsByKey.set(key, set);
  }
  const out = new Map<string, number>();
  for (const [key, set] of feedsByKey) out.set(key, set.size);
  return out;
};

/**
 * Compute fresh alerts from the current items. An item alerts when it matches a
 * watch keyword (or no keywords are set) AND either its |sentiment| clears the
 * threshold or it is corroborated by ≥ 2 distinct sources. Newest first, capped.
 */
export const computeNewsAlerts = (
  items: NewsItem[],
  config: NewsBotConfig,
  idGen: (item: NewsItem) => string
): NewsAlert[] => {
  const counts = sourceCountByTitle(items);
  const keyOf = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .slice(0, 60);
  const alerts: NewsAlert[] = [];
  const seen = new Set<string>();

  const sorted = [...items].toSorted((a, b) => (b.publishedAt ?? b.fetchedAt) - (a.publishedAt ?? a.fetchedAt));
  for (const item of sorted) {
    const text = `${item.title} ${item.summary}`;
    const matched = config.watchKeywords.length === 0 ? [] : matchedKeywordsOf(text, config.watchKeywords);
    if (config.watchKeywords.length > 0 && matched.length === 0) continue;
    const sentiment = scoreSentiment(text);
    const sourceCount = counts.get(keyOf(item.title)) ?? 1;
    const strong = Math.abs(sentiment) >= config.alertThreshold;
    const corroborated = sourceCount >= 2;
    if (!strong && !corroborated) continue;
    const dedupeKey = keyOf(item.title);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    alerts.push({
      id: idGen(item),
      time: item.publishedAt ?? item.fetchedAt,
      title: item.title,
      link: item.link,
      sentiment,
      sourceCount,
      matchedKeywords: matched,
    });
    if (alerts.length >= config.maxAlerts) break;
  }
  return alerts;
};

// ---------------------------------------------------------------------------
// Per-symbol sentiment (consumed by the trading bot)
// ---------------------------------------------------------------------------

/**
 * Aggregate news sentiment per trading symbol. `symbolAliases` maps a ticker to
 * the words that identify it in news text (e.g. AAPL → ['apple','aapl']).
 * Returns ticker → mean sentiment in [-1, 1] (only symbols with ≥1 mention).
 */
export const aggregateSymbolSentiment = (
  items: NewsItem[],
  symbolAliases: Record<string, string[]>
): Record<string, number> => {
  const sums: Record<string, { total: number; n: number }> = {};
  for (const item of items) {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    for (const [symbol, aliases] of Object.entries(symbolAliases)) {
      if (aliases.some((a) => a && text.includes(a))) {
        const s = scoreSentiment(`${item.title} ${item.summary}`);
        const acc = sums[symbol] ?? { total: 0, n: 0 };
        acc.total += s;
        acc.n += 1;
        sums[symbol] = acc;
      }
    }
  }
  const out: Record<string, number> = {};
  for (const [symbol, { total, n }] of Object.entries(sums)) if (n > 0) out[symbol] = total / n;
  return out;
};

/** Default ticker → news aliases for the built-in watchlist. */
export const DEFAULT_SYMBOL_ALIASES: Record<string, string[]> = {
  AAPL: ['apple', 'aapl', 'iphone'],
  MSFT: ['microsoft', 'msft'],
  NVDA: ['nvidia', 'nvda'],
  GOOGL: ['google', 'alphabet', 'googl'],
  AMZN: ['amazon', 'amzn'],
  TSLA: ['tesla', 'tsla', 'musk'],
};
