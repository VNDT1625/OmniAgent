/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Market quotes for the Realtime → Stocks tab.
 *
 * Three keyless, no-auth sources, layered for accuracy + resilience:
 *   - **Yahoo Finance v8 chart** (`query1.finance.yahoo.com`) — primary source
 *     for indices + equities. Its `meta` block carries `regularMarketPrice` and
 *     `previousClose`, so the change % is a true **daily** change (vs the prior
 *     session close), correct even when the market is closed.
 *   - **Stooq** (`stooq.com/q/l`) — fallback for any symbol Yahoo fails to
 *     return, using an intraday (last vs open) change. Clearly a degraded
 *     signal, used only to avoid blanks.
 *   - **CoinGecko** public API — crypto spot price + true 24h change %.
 *
 * Results are normalised into {@link MarketQuote} and cached briefly so the
 * renderer can poll without hammering any source. Best-effort throughout: a
 * failed source/symbol contributes nothing rather than failing the whole call.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

export type MarketKind = 'index' | 'stock' | 'crypto';

/** A normalised market quote for one instrument. */
export type MarketQuote = {
  /** Display ticker, e.g. `AAPL`, `BTC`, `S&P 500`. */
  symbol: string;
  /** Human-readable name. */
  name: string;
  /** Last price, or `null` when unavailable. */
  price: number | null;
  /** Percentage change (daily vs prev close; intraday for Stooq fallback; 24h for crypto). */
  changePercent: number | null;
  /** Quote currency (ISO 4217). */
  currency: string;
  kind: MarketKind;
  /** Provenance of the quote, for transparency in the UI. */
  source: 'yahoo' | 'stooq' | 'coingecko';
};

export type MarketQuotesResult = { ok: true; quotes: MarketQuote[]; fetchedAt: number } | { ok: false; error: string };

export type MarketFetcherDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const STOOQ_URL = 'https://stooq.com/q/l/';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;
const YAHOO_CONCURRENCY = 4;
const USER_AGENT = 'TomniAgentic-News/1.0 (+https://github.com/VNDT1625/OmniAgent)';

type Instrument = { yahoo: string; stooq: string; symbol: string; name: string; kind: MarketKind };

/** Default index + equity watchlist (Yahoo + Stooq symbols for fallback). */
const INSTRUMENTS: Instrument[] = [
  { yahoo: '^GSPC', stooq: '^spx', symbol: 'S&P 500', name: 'S&P 500 Index', kind: 'index' },
  { yahoo: '^IXIC', stooq: '^ndq', symbol: 'Nasdaq', name: 'Nasdaq Composite', kind: 'index' },
  { yahoo: '^DJI', stooq: '^dji', symbol: 'Dow Jones', name: 'Dow Jones Industrial', kind: 'index' },
  { yahoo: 'AAPL', stooq: 'aapl.us', symbol: 'AAPL', name: 'Apple Inc.', kind: 'stock' },
  { yahoo: 'MSFT', stooq: 'msft.us', symbol: 'MSFT', name: 'Microsoft', kind: 'stock' },
  { yahoo: 'NVDA', stooq: 'nvda.us', symbol: 'NVDA', name: 'NVIDIA', kind: 'stock' },
  { yahoo: 'GOOGL', stooq: 'googl.us', symbol: 'GOOGL', name: 'Alphabet', kind: 'stock' },
  { yahoo: 'AMZN', stooq: 'amzn.us', symbol: 'AMZN', name: 'Amazon', kind: 'stock' },
  { yahoo: 'TSLA', stooq: 'tsla.us', symbol: 'TSLA', name: 'Tesla', kind: 'stock' },
];

/** Default CoinGecko watchlist. */
const CRYPTO_IDS: Array<{ id: string; symbol: string; name: string }> = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
  { id: 'solana', symbol: 'SOL', name: 'Solana' },
];

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Friendly names for common symbols; custom symbols fall back to the ticker. */
const KNOWN_NAMES: Record<string, string> = {
  '^GSPC': 'S&P 500 Index',
  '^IXIC': 'Nasdaq Composite',
  '^DJI': 'Dow Jones Industrial',
  '^FTSE': 'FTSE 100',
  '^N225': 'Nikkei 225',
  AAPL: 'Apple Inc.',
  MSFT: 'Microsoft',
  NVDA: 'NVIDIA',
  GOOGL: 'Alphabet',
  AMZN: 'Amazon',
  TSLA: 'Tesla',
  'BTC-USD': 'Bitcoin',
  'ETH-USD': 'Ethereum',
  'SOL-USD': 'Solana',
};

/** Infer instrument kind from a Yahoo symbol shape. */
const inferKind = (symbol: string): MarketKind => {
  if (symbol.startsWith('^')) return 'index';
  if (/-USD[TC]?$/i.test(symbol)) return 'crypto';
  return 'stock';
};

/** Display ticker (strip the `-USD` suffix for crypto). */
const displaySymbol = (symbol: string, kind: MarketKind): string =>
  kind === 'crypto' ? symbol.replace(/-USD[TC]?$/i, '') : symbol;

/** Build instruments for a user-supplied Yahoo symbol list. */
const instrumentsFromSymbols = (symbols: string[]): Instrument[] =>
  symbols.map((raw) => {
    const yahoo = raw.trim();
    const kind = inferKind(yahoo);
    return {
      yahoo,
      stooq: '',
      symbol: displaySymbol(yahoo, kind),
      name: KNOWN_NAMES[yahoo] ?? displaySymbol(yahoo, kind),
      kind,
    };
  });

const withTimeout = async (
  doFetch: typeof fetch,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
};

/** Run `worker` over `items` with at most `limit` in flight. */
const mapLimit = async <T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
};

type YahooChart = {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: unknown;
        previousClose?: unknown;
        chartPreviousClose?: unknown;
        currency?: unknown;
      };
    }>;
  };
};

/** Fetch one instrument from Yahoo v8 chart. Returns `null` on any failure. */
const fetchYahoo = async (inst: Instrument, doFetch: typeof fetch, timeoutMs: number): Promise<MarketQuote | null> => {
  const url = `${YAHOO_CHART_URL}${encodeURIComponent(inst.yahoo)}?range=1d&interval=1d`;
  try {
    const res = await withTimeout(doFetch, url, timeoutMs, { 'User-Agent': USER_AGENT, Accept: 'application/json' });
    if (!res.ok) return null;
    const json = (await res.json()) as YahooChart;
    const meta = json.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = numOrNull(meta.regularMarketPrice);
    const prevClose = numOrNull(meta.previousClose) ?? numOrNull(meta.chartPreviousClose);
    if (price == null) return null;
    const changePercent = prevClose != null && prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : null;
    const currency = typeof meta.currency === 'string' ? meta.currency : 'USD';
    return { symbol: inst.symbol, name: inst.name, price, changePercent, currency, kind: inst.kind, source: 'yahoo' };
  } catch {
    return null;
  }
};

/** Parse a Stooq light-quote CSV into a map of stooq-symbol → {open,close}. */
const parseStooqCsv = (csv: string): Map<string, { open: number | null; close: number | null }> => {
  const out = new Map<string, { open: number | null; close: number | null }>();
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return out;
  const header = lines[0].toLowerCase().split(',');
  const iSym = header.indexOf('symbol');
  const iOpen = header.indexOf('open');
  const iClose = header.indexOf('close');
  if (iSym < 0) return out;
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const sym = cols[iSym]?.toLowerCase();
    if (!sym) continue;
    out.set(sym, {
      open: iOpen >= 0 ? numOrNull(Number(cols[iOpen])) : null,
      close: iClose >= 0 ? numOrNull(Number(cols[iClose])) : null,
    });
  }
  return out;
};

/** Fetch Stooq fallback quotes for the given instruments (single batch request). */
const fetchStooqFallback = async (
  instruments: Instrument[],
  doFetch: typeof fetch,
  timeoutMs: number
): Promise<Map<string, MarketQuote>> => {
  const result = new Map<string, MarketQuote>();
  if (instruments.length === 0) return result;
  const url = `${STOOQ_URL}?s=${encodeURIComponent(instruments.map((i) => i.stooq).join(','))}&f=sd2t2ohlcv&h&e=csv`;
  try {
    const res = await withTimeout(doFetch, url, timeoutMs, { 'User-Agent': USER_AGENT, Accept: 'text/csv' });
    if (!res.ok) return result;
    const parsed = parseStooqCsv(await res.text());
    for (const inst of instruments) {
      const row = parsed.get(inst.stooq.toLowerCase());
      if (!row) continue;
      const changePercent =
        row.open != null && row.open !== 0 && row.close != null ? ((row.close - row.open) / row.open) * 100 : null;
      result.set(inst.symbol, {
        symbol: inst.symbol,
        name: inst.name,
        price: row.close,
        changePercent,
        currency: 'USD',
        kind: inst.kind,
        source: 'stooq',
      });
    }
  } catch {
    /* ignore — fallback is best-effort */
  }
  return result;
};

type CoinGeckoResponse = Record<string, { usd?: number; usd_24h_change?: number }>;

/** Fetch crypto quotes from CoinGecko. Returns `[]` on failure. */
const fetchCryptoQuotes = async (doFetch: typeof fetch, timeoutMs: number): Promise<MarketQuote[]> => {
  const ids = CRYPTO_IDS.map((c) => c.id).join(',');
  const url = `${COINGECKO_URL}?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true`;
  try {
    const res = await withTimeout(doFetch, url, timeoutMs, { Accept: 'application/json' });
    if (!res.ok) return [];
    const json = (await res.json()) as CoinGeckoResponse;
    return CRYPTO_IDS.map((meta) => {
      const row = json[meta.id];
      return {
        symbol: meta.symbol,
        name: meta.name,
        price: numOrNull(row?.usd),
        changePercent: numOrNull(row?.usd_24h_change),
        currency: 'USD',
        kind: 'crypto' as const,
        source: 'coingecko' as const,
      };
    });
  } catch {
    return [];
  }
};

let cache = new Map<string, { at: number; result: MarketQuotesResult }>();

/**
 * Fetch the market watchlist. With no `symbols`, returns the built-in default
 * set (Yahoo + Stooq fallback for equities/indices, CoinGecko for crypto). With
 * a custom `symbols` list (Yahoo tickers), fetches all of them via Yahoo (true
 * daily change). Cached per symbol-set for {@link CACHE_TTL_MS}; `force`
 * bypasses. Never throws.
 */
export const fetchMarketQuotes = async (
  options: { force?: boolean; symbols?: string[] } = {},
  deps: MarketFetcherDeps = {}
): Promise<MarketQuotesResult> => {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const custom = (options.symbols ?? []).filter((s) => s.trim().length > 0);
  const cacheKey = custom.length > 0 ? `custom:${custom.join(',')}` : 'default';

  const cached = cache.get(cacheKey);
  if (!options.force && cached && now() - cached.at < CACHE_TTL_MS && cached.result.ok) {
    return cached.result;
  }

  let quotes: MarketQuote[];
  if (custom.length > 0) {
    // Custom watchlist: everything through Yahoo (handles stocks/indices/crypto).
    const instruments = instrumentsFromSymbols(custom);
    const fetched = await mapLimit(instruments, YAHOO_CONCURRENCY, (inst) => fetchYahoo(inst, doFetch, timeoutMs));
    quotes = fetched.filter((q): q is MarketQuote => !!q);
  } else {
    // Default watchlist: Yahoo primary + Stooq fallback + CoinGecko crypto.
    const [yahooQuotes, crypto] = await Promise.all([
      mapLimit(INSTRUMENTS, YAHOO_CONCURRENCY, (inst) => fetchYahoo(inst, doFetch, timeoutMs)),
      fetchCryptoQuotes(doFetch, timeoutMs),
    ]);
    const bySymbol = new Map<string, MarketQuote>();
    INSTRUMENTS.forEach((inst, i) => {
      const q = yahooQuotes[i];
      if (q) bySymbol.set(inst.symbol, q);
    });
    const missing = INSTRUMENTS.filter((inst) => !bySymbol.has(inst.symbol));
    if (missing.length > 0) {
      const stooq = await fetchStooqFallback(missing, doFetch, timeoutMs);
      for (const [symbol, quote] of stooq) bySymbol.set(symbol, quote);
    }
    quotes = [...INSTRUMENTS.map((inst) => bySymbol.get(inst.symbol)).filter((q): q is MarketQuote => !!q), ...crypto];
  }

  if (quotes.length === 0) {
    if (cached?.result.ok) return cached.result;
    return { ok: false, error: 'market-unavailable' };
  }
  const result: MarketQuotesResult = { ok: true, quotes, fetchedAt: now() };
  cache.set(cacheKey, { at: now(), result });
  return result;
};

/** Clear the in-memory cache (test helper / deterministic teardown). */
export const clearMarketCache = (): void => {
  cache = new Map();
};
