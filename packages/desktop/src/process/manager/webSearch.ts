/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight web search for the Learn notes' "AI research" action
 * (Requirement 5.9, 5.11).
 *
 * Runs in the **Main process** (Node.js `fetch`) so it is not subject to the
 * renderer's CORS restrictions, and uses **keyless** public endpoints so the
 * user never has to configure an API key (design decision, mirrors
 * `weatherProvider`):
 *
 * - **DuckDuckGo Instant Answer API** (`api.duckduckgo.com`) — returns an
 *   abstract + related topics with source URLs, no key required.
 * - **Wikipedia REST summary** (`*.wikipedia.org`) — a reliable encyclopedic
 *   fallback/companion, no key required.
 *
 * Every failure path (offline, HTTP error, malformed body, empty query) degrades
 * to an empty result set rather than throwing, so the caller can fall back to a
 * model-only answer and tell the user that web context was limited.
 *
 * Testability: the `fetch` implementation is injectable.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** One search result snippet with its source link. */
export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

/** Minimal `fetch` surface used here (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type WebSearchOptions = {
  /** Defaults to the global `fetch`. Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Max results to return (default 6). */
  limit?: number;
  /** Wikipedia language subdomain (default `en`). */
  wikiLang?: string;
};

const DDG_URL = 'https://api.duckduckgo.com/';
const resolveFetch = (options?: WebSearchOptions): FetchLike | undefined =>
  options?.fetchImpl ?? (typeof fetch === 'function' ? (fetch as unknown as FetchLike) : undefined);

/** Collect DuckDuckGo abstract + related-topic results (best-effort). */
const searchDuckDuckGo = async (query: string, fetchImpl: FetchLike): Promise<WebSearchResult[]> => {
  try {
    const url = `${DDG_URL}?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&t=aionui`;
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      Heading?: string;
      AbstractText?: string;
      AbstractURL?: string;
      RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
    };

    const out: WebSearchResult[] = [];
    if (body.AbstractText && body.AbstractURL) {
      out.push({ title: body.Heading || query, url: body.AbstractURL, snippet: body.AbstractText });
    }
    // RelatedTopics may nest one level (grouped topics).
    const flat: Array<{ Text?: string; FirstURL?: string }> = [];
    for (const topic of body.RelatedTopics ?? []) {
      if (topic.Topics) flat.push(...topic.Topics);
      else flat.push(topic);
    }
    for (const topic of flat) {
      if (topic.Text && topic.FirstURL) {
        out.push({ title: topic.Text.split(' - ')[0].slice(0, 120), url: topic.FirstURL, snippet: topic.Text });
      }
    }
    return out;
  } catch {
    return [];
  }
};

/** Fetch a Wikipedia summary for the query (best-effort). */
const searchWikipedia = async (query: string, fetchImpl: FetchLike, lang: string): Promise<WebSearchResult[]> => {
  try {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query.replace(/\s+/g, '_'))}`;
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    if (!body.extract || !body.title) return [];
    const pageUrl =
      body.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(query)}`;
    return [{ title: body.title, url: pageUrl, snippet: body.extract }];
  } catch {
    return [];
  }
};

/** De-duplicate results by URL, preserving order. */
const dedupe = (results: WebSearchResult[]): WebSearchResult[] => {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
  }
  return out;
};

/**
 * Search the web for `query` and return up to `limit` snippet results.
 *
 * Combines Wikipedia (authoritative summary) with DuckDuckGo (breadth). Returns
 * an empty array on any failure — never throws — so the caller can degrade to a
 * model-only answer.
 */
export const searchWeb = async (query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> => {
  const q = query.trim();
  if (q.length === 0) return [];
  const fetchImpl = resolveFetch(options);
  if (!fetchImpl) return [];
  const limit = Math.max(1, options?.limit ?? 6);
  const wikiLang = options?.wikiLang ?? 'en';

  const [wiki, ddg] = await Promise.all([searchWikipedia(q, fetchImpl, wikiLang), searchDuckDuckGo(q, fetchImpl)]);

  return dedupe([...wiki, ...ddg]).slice(0, limit);
};
