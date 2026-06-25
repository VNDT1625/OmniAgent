/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daily price history from Stooq (keyless CSV) for backtesting.
 *
 * `https://stooq.com/q/d/l/?s=<sym>&i=d` returns a `Date,Open,High,Low,Close,Volume`
 * CSV of the full daily history. We map display tickers to Stooq symbols, fetch,
 * parse into {@link OHLCBar}s (oldest→newest), and cache per symbol.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { OHLCBar } from './botTypes';

const STOOQ_HISTORY_URL = 'https://stooq.com/q/d/l/';
const FETCH_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 6 * 60 * 60_000; // history is daily — 6h cache is ample.
const USER_AGENT = 'AionUi-News/1.0 (+https://aionui.com)';

/** Display ticker → Stooq history symbol. */
const STOOQ_SYMBOL: Record<string, string> = {
  'S&P 500': '^spx',
  Nasdaq: '^ndq',
  'Dow Jones': '^dji',
  AAPL: 'aapl.us',
  MSFT: 'msft.us',
  NVDA: 'nvda.us',
  GOOGL: 'googl.us',
  AMZN: 'amzn.us',
  TSLA: 'tsla.us',
};

export type HistoryResult = { ok: true; bars: OHLCBar[] } | { ok: false; error: string };

export type HistoryDeps = { fetch?: typeof fetch; now?: () => number; timeoutMs?: number };

const num = (v: string): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Parse a Stooq daily-history CSV (oldest→newest in the file already). */
export const parseHistoryCsv = (csv: string): OHLCBar[] => {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase().split(',');
  const iDate = header.indexOf('date');
  const iOpen = header.indexOf('open');
  const iHigh = header.indexOf('high');
  const iLow = header.indexOf('low');
  const iClose = header.indexOf('close');
  const iVol = header.indexOf('volume');
  if (iDate < 0 || iClose < 0) return [];
  const bars: OHLCBar[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const time = Date.parse(c[iDate]);
    const close = num(c[iClose]);
    if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
    bars.push({
      time,
      open: iOpen >= 0 ? num(c[iOpen]) : close,
      high: iHigh >= 0 ? num(c[iHigh]) : close,
      low: iLow >= 0 ? num(c[iLow]) : close,
      close,
      volume: iVol >= 0 ? num(c[iVol]) || 0 : 0,
    });
  }
  return bars;
};

const cache = new Map<string, { at: number; bars: OHLCBar[] }>();

/** Resolve the Stooq symbol for a display ticker (or the lower-cased input). */
export const stooqSymbolFor = (symbol: string): string => STOOQ_SYMBOL[symbol] ?? symbol.toLowerCase();

/**
 * Fetch daily history for a display ticker. Cached for {@link CACHE_TTL_MS}.
 * Never throws.
 */
export const fetchDailyHistory = async (
  symbol: string,
  options: { limit?: number; force?: boolean } = {},
  deps: HistoryDeps = {}
): Promise<HistoryResult> => {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const stooq = stooqSymbolFor(symbol);

  const cached = cache.get(stooq);
  if (!options.force && cached && now() - cached.at < CACHE_TTL_MS) {
    return { ok: true, bars: options.limit ? cached.bars.slice(-options.limit) : cached.bars };
  }

  const url = `${STOOQ_HISTORY_URL}?s=${encodeURIComponent(stooq)}&i=d`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv' } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const bars = parseHistoryCsv(await res.text());
    if (bars.length === 0) return { ok: false, error: 'no history' };
    cache.set(stooq, { at: now(), bars });
    return { ok: true, bars: options.limit ? bars.slice(-options.limit) : bars };
  } catch (error) {
    if (cached) return { ok: true, bars: cached.bars };
    return { ok: false, error: controller.signal.aborted ? 'timeout' : error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
};

/** Clear the history cache (test helper). */
export const clearHistoryCache = (): void => cache.clear();
