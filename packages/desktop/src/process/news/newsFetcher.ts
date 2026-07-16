/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Network + classification stage of the News aggregator.
 *
 * Given a {@link NewsFeed}, this fetches its XML over HTTP (Node's global
 * `fetch`), parses it with the dependency-light {@link parseFeed}, strips HTML
 * from each summary with the project's `html-to-text`, and runs every article
 * through the rule-based {@link classifyItem} (no AI). The result is a list of
 * {@link IngestItemInput}s ready for `NewsStore.ingestItems`.
 *
 * Fetching is deliberately lightweight (a feed is a few KB of XML), so it does
 * not take a ResourceCoordinator lease — the scheduler instead bounds how many
 * feeds refresh in parallel. Network/parse failures are returned as a typed
 * error result rather than thrown, so one broken feed never aborts a refresh.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { convert as htmlToText } from 'html-to-text';
import { buildKeywordIndex, classifyItem } from './newsClassifier';
import { parseFeed } from './rssParser';
import type { IngestItemInput } from './newsStore';
import type { KeywordRule, NewsFeed } from './newsTypes';

/**
 * Only http(s) feed URLs are allowed. Rejecting other schemes (file:, ftp:,
 * data:, etc.) keeps the Main-process fetch from being pointed at the local
 * filesystem or other unintended targets via a crafted feed URL.
 */
export const isHttpUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Per-request timeout so a hung host can't stall the whole refresh. */
const FETCH_TIMEOUT_MS = 15_000;

/** A browser-like UA — some hosts reject requests with no/unknown UA. */
const USER_AGENT = 'Mozilla/5.0 (compatible; TomniAgentic-News/1.0; +https://github.com/VNDT1625/OmniAgent)';

/** Cap summary length so the store stays compact. */
const MAX_SUMMARY_CHARS = 500;

/** How many articles per refresh may be enriched with og:image (bounds cost). */
const MAX_OG_ENRICH = 24;
/** Concurrency for og:image page fetches. */
const OG_CONCURRENCY = 6;
/** Shorter timeout for og:image page fetches (we only need the <head>). */
const OG_TIMEOUT_MS = 8_000;

/** Outcome of fetching one feed. */
export type FetchFeedResult = { ok: true; feedTitle: string; items: IngestItemInput[] } | { ok: false; error: string };

/** Injected dependencies for {@link fetchFeed} (all defaulted; injectable for tests). */
export type FetchFeedDeps = {
  /** HTTP fetch. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Clock for `fetchedAt`. Defaults to `Date.now`. */
  now?: () => number;
  /** Per-request timeout in ms. Defaults to {@link FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
};

/** Convert an HTML/encoded summary into a trimmed plain-text snippet (no image URLs). */
const toPlainSummary = (raw: string): string => {
  if (!raw) return '';
  let text = raw;
  try {
    text = htmlToText(raw, {
      wordwrap: false,
      selectors: [
        // Strip images entirely — don't emit their src as text.
        { selector: 'img', format: 'skip' },
        // Strip links href — keep only the anchor text.
        { selector: 'a', options: { ignoreHref: true } },
        // Strip figure/figcaption noise.
        { selector: 'figure', format: 'skip' },
      ],
    });
  } catch {
    // Strip HTML tags manually as fallback.
    text = raw.replace(/<[^>]+>/g, ' ');
  }
  // Collapse whitespace and remove leftover bracket-URL artifacts like [https://...]
  text = text
    .replace(/\[https?:\/\/[^\]]*\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
};

/**
 * Fetch an article page and extract its Open Graph / Twitter Card image.
 *
 * This is how professional aggregators (Nosto/Stackla, SocialBu) handle feeds
 * that don't embed an image: visit the linked page and read `og:image` /
 * `twitter:image` from the `<head>`. We only download a small slice of the page
 * (most meta tags live early in `<head>`) and never throw — a miss returns
 * `null` so the article simply shows a text placeholder.
 */
const fetchOgImage = async (
  pageUrl: string,
  doFetch: typeof fetch,
  timeoutMs = OG_TIMEOUT_MS
): Promise<string | null> => {
  if (!pageUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(pageUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    // Read only the first ~64KB — og tags live in <head>, no need for the body.
    const html = (await res.text()).slice(0, 65_536);
    // Match og:image / twitter:image regardless of attribute order.
    const patterns = [
      /<meta[^>]+property=["']og:image(?::url)?["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::url)?["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
    ];
    for (const re of patterns) {
      const m = re.exec(html);
      if (m?.[1]) {
        const url = m[1].trim();
        if (url.startsWith('http')) return url;
        // Resolve protocol-relative or root-relative URLs against the page.
        try {
          return new URL(url, pageUrl).toString();
        } catch {
          return null;
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Run async `worker` over `items` with at most `limit` in flight. */
const mapWithConcurrency = async <T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> => {
  const queue = [...items];
  const run = async (): Promise<void> => {
    const item = queue.shift();
    if (item === undefined) return;
    await worker(item);
    await run();
  };
  const runners: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(run());
  await Promise.all(runners);
};

/**
 * Validate a feed URL by fetching it and checking it returns parseable RSS/Atom.
 * Returns `{ ok: true, title }` on success, `{ ok: false, error }` on failure.
 * Used by the bridge's `addFeed` handler to reject bad URLs before persisting.
 */
export const validateFeedUrl = async (
  url: string,
  deps: FetchFeedDeps = {}
): Promise<{ ok: true; title: string } | { ok: false; error: string }> => {
  if (!isHttpUrl(url)) return { ok: false, error: 'URL phải bắt đầu bằng http:// hoặc https://' };
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status} ${response.statusText}`.trim() };
    const xml = await response.text();
    const parsed = parseFeed(xml);
    if (parsed.items.length === 0 && !parsed.title) {
      return { ok: false, error: 'URL không trả về feed RSS/Atom hợp lệ' };
    }
    return { ok: true, title: parsed.title };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: controller.signal.aborted ? `Timeout sau ${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Fetch, parse, and classify one feed. Never throws — returns a typed
 * `{ ok: false }` on any network/parse failure so the caller can record
 * `feed.lastError` and continue with the next feed.
 *
 * @param feed       The feed to fetch (provides url + per-feed category).
 * @param userRules  User keyword rules layered onto the built-in classifier.
 * @param deps       Injectable fetch/clock/timeout for tests.
 */
export const fetchFeed = async (
  feed: NewsFeed,
  userRules: KeywordRule[] = [],
  deps: FetchFeedDeps = {}
): Promise<FetchFeedResult> => {
  if (!isHttpUrl(feed.url)) return { ok: false, error: 'Unsupported URL scheme (only http/https)' };
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let xml: string;
  try {
    const response = await doFetch(feed.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} ${response.statusText}`.trim() };
    }
    xml = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: controller.signal.aborted ? `Timed out after ${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }

  const parsed = parseFeed(xml);
  const index = buildKeywordIndex(userRules);

  const items: IngestItemInput[] = parsed.items.map((raw) => {
    const summary = toPlainSummary(raw.summary);
    const { category, source } = classifyItem(
      { feedCategory: feed.category, title: raw.title, summary, tags: raw.tags },
      index
    );
    return {
      guid: raw.guid,
      title: raw.title,
      link: raw.link,
      summary,
      author: raw.author,
      imageUrl: raw.imageUrl,
      publishedAt: raw.publishedAt,
      category,
      categorySource: source,
      rawTags: raw.tags,
    };
  });

  // og:image enrichment — for items the feed didn't embed an image for, visit
  // the article page and read og:image/twitter:image (industry-standard
  // fallback). Bounded by MAX_OG_ENRICH + OG_CONCURRENCY to keep cost low.
  const needEnrich = items.filter((it) => !it.imageUrl && it.link).slice(0, MAX_OG_ENRICH);
  if (needEnrich.length > 0) {
    await mapWithConcurrency(needEnrich, OG_CONCURRENCY, async (it) => {
      const og = await fetchOgImage(it.link, doFetch);
      if (og) it.imageUrl = og;
    });
  }

  return { ok: true, feedTitle: parsed.title, items };
};
