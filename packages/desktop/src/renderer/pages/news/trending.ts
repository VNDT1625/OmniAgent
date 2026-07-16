/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rule-based "real trending" computation — no AI, no external API.
 *
 * The signal is **how many distinct sources (feeds) cover the same story**,
 * mirroring how Google News / Ground News surface trends: a story carried by
 * many outlets is genuinely hot, whereas a single-outlet item is just recent.
 *
 * Pipeline (all pure, deterministic):
 *   1. Tokenize each article title → drop stopwords (VI + EN) + short tokens.
 *   2. Greedily cluster articles whose keyword sets overlap enough (Jaccard).
 *   3. Score each cluster by distinct-feed count (primary) + recency (tiebreak).
 *   4. If no cluster spans ≥ 2 feeds, there is no real trend → caller falls back
 *      to "latest" and relabels the section.
 *
 * Process boundary: Renderer module (pure data). No Node/DOM APIs.
 */

import type { NewsItem } from '@process/news/newsTypes';

/** Stopwords to ignore when comparing titles (lower-cased, diacritic-free). */
const STOPWORDS = new Set([
  // English
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'as',
  'that',
  'this',
  'it',
  'its',
  'has',
  'have',
  'had',
  'will',
  'would',
  'can',
  'could',
  'new',
  'says',
  'say',
  'after',
  'over',
  'into',
  'out',
  'up',
  'down',
  // Vietnamese (diacritic-free forms — see normalise)
  'va',
  'cua',
  'cho',
  'tu',
  'voi',
  'tai',
  'la',
  'co',
  'khong',
  'duoc',
  'mot',
  'cac',
  'nhung',
  'den',
  'trong',
  'tren',
  'sau',
  'truoc',
  'khi',
  'da',
  'se',
  'bi',
  've',
  'ra',
  'vao',
  'nay',
  'do',
  'thi',
  'nguoi',
  'nam',
  'theo',
  'hon',
  'cung',
  'cu',
  'lai',
  'di',
  'lam',
  'bao',
  'moi',
]);

/** Strip diacritics + lower-case so VI titles compare tone-insensitively. */
export const normalise = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

/** Extract significant keyword tokens from a title. */
export const keywordsOf = (title: string): Set<string> => {
  const tokens = normalise(title)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(tokens);
};

/** Jaccard similarity between two keyword sets (0..1). */
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  return inter / (a.size + b.size - inter);
};

/** A cluster of articles believed to be the same story. */
export type TrendCluster = {
  /** Representative article (most recent in the cluster). */
  lead: NewsItem;
  /** All articles in the cluster. */
  items: NewsItem[];
  /** Number of distinct feeds covering this story (the trend strength). */
  sourceCount: number;
};

/** Minimum keyword overlap to treat two titles as the same story. */
const SIMILARITY_THRESHOLD = 0.34;

/**
 * Cluster articles by title-keyword overlap, then rank by distinct-feed count.
 *
 * @returns Clusters sorted strongest-first. Each cluster's `sourceCount` is the
 *          number of distinct feeds; `items` are de-duplicated per feed (one
 *          representative per feed) so two articles from the same feed don't
 *          inflate the count.
 */
export const computeTrendClusters = (items: NewsItem[]): TrendCluster[] => {
  const recencyKey = (i: NewsItem) => i.publishedAt ?? i.fetchedAt;
  // Newest first so each cluster's lead is the freshest article.
  const sorted = [...items].filter((i) => i.title.trim().length > 0).toSorted((a, b) => recencyKey(b) - recencyKey(a));

  const clusters: Array<{ keywords: Set<string>; items: NewsItem[] }> = [];

  for (const item of sorted) {
    const kw = keywordsOf(item.title);
    if (kw.size === 0) continue;
    // Find the best matching existing cluster.
    let best: { cluster: (typeof clusters)[number]; score: number } | null = null;
    for (const cluster of clusters) {
      const score = jaccard(kw, cluster.keywords);
      if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
        best = { cluster, score };
      }
    }
    if (best) {
      best.cluster.items.push(item);
      for (const w of kw) best.cluster.keywords.add(w);
    } else {
      clusters.push({ keywords: new Set(kw), items: [item] });
    }
  }

  // Build result clusters with distinct-feed dedup + source count.
  const result: TrendCluster[] = clusters.map((c) => {
    const byFeed = new Map<string, NewsItem>();
    for (const it of c.items) {
      const prev = byFeed.get(it.feedId);
      if (!prev || recencyKey(it) > recencyKey(prev)) byFeed.set(it.feedId, it);
    }
    const deduped = [...byFeed.values()].toSorted((a, b) => recencyKey(b) - recencyKey(a));
    return { lead: deduped[0], items: deduped, sourceCount: byFeed.size };
  });

  // Rank: more distinct sources first, then more recent.
  result.sort((a, b) => {
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    return recencyKey(b.lead) - recencyKey(a.lead);
  });

  return result;
};

/** Result of {@link computeTrending}: ranked entries + whether it's a real trend. */
export type TrendingResult = {
  /** Top entries to show (lead article + source count). */
  entries: Array<{ item: NewsItem; sourceCount: number }>;
  /**
   * `true` when at least one story is carried by ≥ 2 distinct feeds — a genuine
   * cross-source trend. `false` means we fell back to "latest" and the UI
   * should relabel the section accordingly.
   */
  isRealTrend: boolean;
};

/**
 * Compute the trending list. Real trend = multi-source clusters; otherwise
 * degrade to most-recent articles (and flag it so the UI can relabel).
 */
export const computeTrending = (items: NewsItem[], limit = 5): TrendingResult => {
  const clusters = computeTrendClusters(items);
  const multiSource = clusters.filter((c) => c.sourceCount >= 2);

  if (multiSource.length > 0) {
    return {
      entries: multiSource.slice(0, limit).map((c) => ({ item: c.lead, sourceCount: c.sourceCount })),
      isRealTrend: true,
    };
  }

  // Fallback: most recent, single source each.
  const recencyKey = (i: NewsItem) => i.publishedAt ?? i.fetchedAt;
  const latest = [...items]
    .filter((i) => i.title.trim().length > 0)
    .toSorted((a, b) => recencyKey(b) - recencyKey(a))
    .slice(0, limit)
    .map((item) => ({ item, sourceCount: 1 }));
  return { entries: latest, isRealTrend: false };
};
