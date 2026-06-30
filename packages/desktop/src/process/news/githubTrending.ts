/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GitHub "trending" repositories for the News technology tab.
 *
 * GitHub has no official trending API, so this uses the public Search API
 * (`/search/repositories`) with a recency window + `sort=stars` as a keyless,
 * no-auth proxy for "what is hot right now": repositories created within the
 * lookback window, ranked by total stars. This is the same approach most
 * open-source "trending" clones take, and it requires no token (unauthenticated
 * search is rate-limited to ~10 req/min, which a short in-memory cache keeps us
 * well under).
 *
 * The result feeds a compact "Top 10 GitHub" panel that replaces the trending
 * news list on the technology category.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** A single trending repository, normalised for the renderer. */
export type GithubRepo = {
  /** GitHub numeric id (stable React key). */
  id: number;
  /** `owner/name`. */
  fullName: string;
  /** Repository short name. */
  name: string;
  /** Owner login. */
  owner: string;
  /** Repository description, or `null` when absent. */
  description: string | null;
  /** HTML URL to open in the browser. */
  url: string;
  /** Total star count. */
  stars: number;
  /** Stars gained within the lookback window (proxy for momentum). */
  starsRecent: number;
  /** Primary language, or `null`. */
  language: string | null;
};

/** Lookback windows offered to the UI. */
export type GithubTrendingSince = 'daily' | 'weekly' | 'monthly';

export type GithubTrendingResult = { ok: true; repos: GithubRepo[]; fetchedAt: number } | { ok: false; error: string };

/** Injected dependencies (all defaulted; injectable for tests). */
export type GithubTrendingDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

const API_URL = 'https://api.github.com/search/repositories';
const FETCH_TIMEOUT_MS = 12_000;
const USER_AGENT = 'AionUi-News/1.0 (+https://aionui.com)';
/** Cache TTL — search results barely move minute-to-minute; 30 min is plenty. */
const CACHE_TTL_MS = 30 * 60_000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

/** Days of lookback per window. */
const SINCE_DAYS: Record<GithubTrendingSince, number> = { daily: 2, weekly: 9, monthly: 32 };

type RawRepo = {
  id?: unknown;
  full_name?: unknown;
  name?: unknown;
  description?: unknown;
  html_url?: unknown;
  stargazers_count?: unknown;
  language?: unknown;
  owner?: { login?: unknown } | null;
};

type SearchResponse = { items?: RawRepo[] };

const isString = (v: unknown): v is string => typeof v === 'string';
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** YYYY-MM-DD for the GitHub `created:>` qualifier (UTC). */
const isoDay = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

const normaliseRepo = (raw: RawRepo): GithubRepo | null => {
  if (!isFiniteNumber(raw.id) || !isString(raw.full_name) || !isString(raw.html_url)) return null;
  const stars = isFiniteNumber(raw.stargazers_count) ? raw.stargazers_count : 0;
  const owner = raw.owner && isString(raw.owner.login) ? raw.owner.login : raw.full_name.split('/')[0];
  return {
    id: raw.id,
    fullName: raw.full_name,
    name: isString(raw.name) ? raw.name : (raw.full_name.split('/').at(-1) ?? raw.full_name),
    owner,
    description: isString(raw.description) ? raw.description : null,
    url: raw.html_url,
    stars,
    // The search window is recency-bounded, so for newly-created repos total
    // stars ≈ stars earned in-window; surface it as the momentum signal.
    starsRecent: stars,
    language: isString(raw.language) ? raw.language : null,
  };
};

/** Per-window in-memory cache. */
const cache = new Map<string, { at: number; result: GithubTrendingResult }>();

/**
 * Fetch trending repositories for a window. Results are cached for
 * {@link CACHE_TTL_MS}; pass `force` to bypass the cache. Never throws — a
 * network/parse failure resolves to `{ ok: false }`.
 */
export const fetchGithubTrending = async (
  options: { since?: GithubTrendingSince; limit?: number; force?: boolean } = {},
  deps: GithubTrendingDeps = {}
): Promise<GithubTrendingResult> => {
  const since = options.since ?? 'weekly';
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const cacheKey = `${since}:${limit}`;

  const cached = cache.get(cacheKey);
  if (!options.force && cached && now() - cached.at < CACHE_TTL_MS && cached.result.ok) {
    return cached.result;
  }

  const createdAfter = isoDay(now() - SINCE_DAYS[since] * 86_400_000);
  const query = `created:>${createdAfter}`;
  const url = `${API_URL}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${limit}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} ${response.statusText}`.trim() };
    }
    const json = (await response.json()) as SearchResponse;
    const repos = (json.items ?? []).map(normaliseRepo).filter((r): r is GithubRepo => r !== null);
    const result: GithubTrendingResult = { ok: true, repos, fetchedAt: now() };
    cache.set(cacheKey, { at: now(), result });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Serve a stale cache entry rather than nothing when the network blips.
    if (cached?.result.ok) return cached.result;
    return { ok: false, error: controller.signal.aborted ? `Timed out after ${timeoutMs}ms` : message };
  } finally {
    clearTimeout(timer);
  }
};

/** Clear the in-memory cache (test helper / deterministic teardown). */
export const clearGithubTrendingCache = (): void => cache.clear();
