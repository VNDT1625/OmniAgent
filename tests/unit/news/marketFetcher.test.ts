/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchMarketQuotes, clearMarketCache } from '@process/news/marketFetcher';

const yahooResponse = (price: number, prevClose: number) =>
  new Response(
    JSON.stringify({
      chart: { result: [{ meta: { regularMarketPrice: price, previousClose: prevClose, currency: 'USD' } }] },
    }),
    { status: 200 }
  );

const STOOQ_CSV = [
  'Symbol,Date,Time,Open,High,Low,Close,Volume',
  '^spx,2026-06-09,22:00:00,5000,5100,4990,5050,0',
  '^ndq,2026-06-09,22:00:00,N/D,N/D,N/D,N/D,N/D',
].join('\n');

const CRYPTO_JSON = {
  bitcoin: { usd: 65000, usd_24h_change: 2.5 },
  ethereum: { usd: 3200, usd_24h_change: -1.2 },
  solana: { usd: 150, usd_24h_change: 0 },
};

describe('marketFetcher', () => {
  beforeEach(() => clearMarketCache());

  it('uses Yahoo as primary with a true daily change (vs previous close)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v8/finance/chart/')) return yahooResponse(206, 200);
      if (url.includes('coingecko.com')) return new Response(JSON.stringify(CRYPTO_JSON), { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const res = await fetchMarketQuotes({}, { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const aapl = res.quotes.find((q) => q.symbol === 'AAPL');
    expect(aapl?.source).toBe('yahoo');
    expect(aapl?.changePercent).toBeCloseTo(((206 - 200) / 200) * 100, 5);
    const btc = res.quotes.find((q) => q.symbol === 'BTC');
    expect(btc).toMatchObject({ price: 65000, changePercent: 2.5, kind: 'crypto', source: 'coingecko' });
  });

  it('falls back to Stooq (intraday) when Yahoo fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v8/finance/chart/')) return new Response('blocked', { status: 429 });
      if (url.includes('stooq.com')) return new Response(STOOQ_CSV, { status: 200 });
      if (url.includes('coingecko.com')) return new Response(JSON.stringify(CRYPTO_JSON), { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const res = await fetchMarketQuotes({}, { fetch: fetchMock as unknown as typeof fetch });
    if (!res.ok) throw new Error('expected ok');
    const spx = res.quotes.find((q) => q.symbol === 'S&P 500');
    expect(spx?.source).toBe('stooq');
    expect(spx?.changePercent).toBeCloseTo(((5050 - 5000) / 5000) * 100, 5);
    const ndq = res.quotes.find((q) => q.symbol === 'Nasdaq');
    expect(ndq?.price).toBeNull(); // N/D row
  });

  it('caches across calls and bypasses with force', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v8/finance/chart/')) return yahooResponse(100, 100);
      if (url.includes('coingecko.com')) return new Response(JSON.stringify(CRYPTO_JSON), { status: 200 });
      return new Response('', { status: 404 });
    });
    await fetchMarketQuotes({}, { fetch: fetchMock as unknown as typeof fetch });
    const afterFirst = fetchMock.mock.calls.length;
    await fetchMarketQuotes({}, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
    await fetchMarketQuotes({ force: true }, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('fails only when every source returns nothing', async () => {
    const fetchMock = vi.fn(async () => new Response('err', { status: 500 }));
    const res = await fetchMarketQuotes({}, { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(false);
  });

  it('fetches a custom symbol list via Yahoo and infers kind', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v8/finance/chart/')) return yahooResponse(50, 40);
      throw new Error(`unexpected ${url}`);
    });
    const res = await fetchMarketQuotes(
      { symbols: ['NFLX', '^FTSE', 'BTC-USD'] },
      { fetch: fetchMock as unknown as typeof fetch }
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.quotes.map((q) => q.symbol).toSorted()).toEqual(['BTC', '^FTSE', 'NFLX'].toSorted());
    expect(res.quotes.find((q) => q.symbol === '^FTSE')?.kind).toBe('index');
    expect(res.quotes.find((q) => q.symbol === 'BTC')?.kind).toBe('crypto');
    expect(res.quotes.find((q) => q.symbol === 'NFLX')?.kind).toBe('stock');
    // No Stooq/CoinGecko calls in custom mode.
    expect(fetchMock.mock.calls.every(([u]) => String(u).includes('yahoo'))).toBe(true);
  });

  it('caches custom and default sets separately', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/v8/finance/chart/')) return yahooResponse(10, 10);
      if (url.includes('coingecko.com')) return new Response(JSON.stringify(CRYPTO_JSON), { status: 200 });
      return new Response('', { status: 404 });
    });
    await fetchMarketQuotes({}, { fetch: fetchMock as unknown as typeof fetch });
    const afterDefault = fetchMock.mock.calls.length;
    // A custom set is a different cache key → triggers new fetches.
    await fetchMarketQuotes({ symbols: ['NFLX'] }, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterDefault);
  });
});
