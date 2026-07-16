/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rule-based news classifier — assigns a topic to an article **without any AI**.
 *
 * This mirrors how professional aggregators (Feedly, Apple News, FreshRSS)
 * categorise without ML: a deterministic priority pipeline of increasingly
 * fuzzy signals. The first layer that produces a confident answer wins.
 *
 *   1. **Feed category** — the user (or an OPML import) tagged the *whole* feed
 *      with a topic. This is the strongest signal because publishers expose
 *      topic-specific feed URLs (e.g. `vnexpress.net/rss/the-thao.rss`). When a
 *      feed has a category, every article inherits it. (`source: 'feed'`)
 *   2. **Item tags** — the feed's own `<category>` / Atom `term` strings, mapped
 *      to our taxonomy via the keyword table. Publisher-provided, so trusted
 *      above free-text matching. (`source: 'tag'`)
 *   3. **Keyword match** — tokenise title + summary, score each topic by keyword
 *      hits (built-in EN+VI table, extended by user rules), pick the best.
 *      (`source: 'keyword'`)
 *   4. **Default** — nothing matched → `general`. (`source: 'default'`)
 *
 * Everything here is pure (no I/O), so the whole policy is unit-testable.
 *
 * Process boundary: plain module — safe in Main or renderer (no Node/DOM).
 */

import type { CategorySource, KeywordRule, NewsCategoryId } from './newsTypes';

/**
 * Built-in keyword table (lower-cased). Bilingual EN + VI to fit the project's
 * primary audiences. Order does not matter — scoring counts hits per category.
 * Diacritic-insensitive matching (see {@link normalise}) means VI terms can be
 * written without tones here and still match toned article text.
 */
const BUILTIN_KEYWORDS: Record<Exclude<NewsCategoryId, 'general'>, string[]> = {
  world: ['world', 'global', 'international', 'foreign', 'quoc te', 'the gioi', 'toan cau'],
  politics: [
    'politic',
    'election',
    'government',
    'parliament',
    'senate',
    'congress',
    'diplomat',
    'chinh tri',
    'bau cu',
    'chinh phu',
    'quoc hoi',
    'ngoai giao',
  ],
  business: [
    'business',
    'economy',
    'economic',
    'market',
    'stock',
    'finance',
    'trade',
    'inflation',
    'startup',
    'kinh te',
    'kinh doanh',
    'chung khoan',
    'tai chinh',
    'thi truong',
    'doanh nghiep',
    'lam phat',
  ],
  technology: [
    'technology',
    'tech',
    'software',
    'hardware',
    'ai',
    'artificial intelligence',
    'app',
    'smartphone',
    'internet',
    'cyber',
    'chip',
    'cong nghe',
    'phan mem',
    'tri tue nhan tao',
    'dien thoai',
    'may tinh',
  ],
  science: [
    'science',
    'research',
    'study',
    'space',
    'nasa',
    'physics',
    'biology',
    'climate',
    'khoa hoc',
    'nghien cuu',
    'vu tru',
    'vat ly',
    'sinh hoc',
    'khi hau',
  ],
  health: [
    'health',
    'medical',
    'medicine',
    'disease',
    'virus',
    'covid',
    'vaccine',
    'hospital',
    'mental health',
    'suc khoe',
    'y te',
    'benh',
    'vac xin',
    'benh vien',
    'dich benh',
  ],
  sports: [
    'sport',
    'football',
    'soccer',
    'basketball',
    'tennis',
    'olympic',
    'match',
    'league',
    'champion',
    'the thao',
    'bong da',
    'bong ro',
    'quan vot',
    'giai dau',
    'tran dau',
    'vo dich',
  ],
  entertainment: [
    'entertainment',
    'movie',
    'film',
    'music',
    'celebrity',
    'tv',
    'show',
    'game',
    'gaming',
    'concert',
    'giai tri',
    'phim',
    'am nhac',
    'ca si',
    'nghe si',
    'tro choi',
  ],
};

/**
 * Strip diacritics + lower-case so VI keyword terms (written tone-free) match
 * toned article text. Uses Unicode NFD decomposition + combining-mark removal.
 */
export const normalise = (text: string): string =>
  text
    .normalize('NFD')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0300-\u036f]/g, '')
    // Vietnamese đ/Đ are not decomposed by NFD — map explicitly.
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();

/** A compiled lookup from a normalised keyword to the category it implies. */
type KeywordIndex = Map<string, NewsCategoryId>;

/**
 * Build the effective keyword index from the built-ins plus user rules. User
 * rules are applied last so they override a built-in mapping for the same term.
 */
export const buildKeywordIndex = (userRules: KeywordRule[] = []): KeywordIndex => {
  const index: KeywordIndex = new Map();
  for (const [category, words] of Object.entries(BUILTIN_KEYWORDS)) {
    for (const word of words) index.set(normalise(word), category as NewsCategoryId);
  }
  for (const rule of userRules) {
    for (const word of rule.keywords) {
      const key = normalise(word).trim();
      if (key) index.set(key, rule.category);
    }
  }
  return index;
};

/** Inputs the classifier needs about one article. */
export type ClassifyInput = {
  /** Category assigned to the whole feed, if any (layer 1). */
  feedCategory: NewsCategoryId | null;
  title: string;
  summary: string;
  /** Lower-cased `<category>`/term strings from the feed item (layer 2). */
  tags: string[];
};

/** The classifier's decision. */
export type ClassifyResult = { category: NewsCategoryId; source: CategorySource };

/**
 * Score every category by counting keyword hits in the article text, returning
 * the highest-scoring category (ties broken by taxonomy order via first-seen).
 * Returns `null` when no keyword matched at all.
 */
const scoreByKeywords = (text: string, index: KeywordIndex): NewsCategoryId | null => {
  const haystack = normalise(text);
  const scores = new Map<NewsCategoryId, number>();
  for (const [keyword, category] of index) {
    if (!keyword) continue;
    // Count occurrences (a longer/more specific term naturally scores per hit).
    let from = haystack.indexOf(keyword);
    while (from !== -1) {
      scores.set(category, (scores.get(category) ?? 0) + 1);
      from = haystack.indexOf(keyword, from + keyword.length);
    }
  }
  let best: NewsCategoryId | null = null;
  let bestScore = 0;
  for (const [category, score] of scores) {
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
};

/**
 * Classify a single article through the 4-layer pipeline. Pure + deterministic.
 *
 * @param input  Article signals (feed category, title, summary, item tags).
 * @param index  Pre-built keyword index (see {@link buildKeywordIndex}); pass a
 *               shared instance when classifying many items for efficiency.
 */
export const classifyItem = (input: ClassifyInput, index: KeywordIndex): ClassifyResult => {
  // Layer 1 — explicit feed category (most reliable).
  if (input.feedCategory) return { category: input.feedCategory, source: 'feed' };

  // Layer 2 — publisher-provided item tags mapped through the keyword index.
  for (const tag of input.tags) {
    const mapped = index.get(normalise(tag).trim());
    if (mapped) return { category: mapped, source: 'tag' };
  }

  // Layer 3 — free-text keyword scoring over title + summary.
  const byKeyword = scoreByKeywords(`${input.title} ${input.summary}`, index);
  if (byKeyword) return { category: byKeyword, source: 'keyword' };

  // Layer 4 — give up, bucket as general.
  return { category: 'general', source: 'default' };
};
