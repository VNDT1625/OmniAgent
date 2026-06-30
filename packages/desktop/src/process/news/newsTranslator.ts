/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * No-LLM news translation.
 *
 * Translates article titles/summaries into the app's language using a
 * **dedicated machine-translation engine**, never a chat model — so it costs
 * the user no tokens and keeps the News feature's "no AI required" promise in
 * spirit (a focused MT service, not a generative model). The default engine is
 * MyMemory's free REST API (`api.mymemory.translated.net`) which needs **no API
 * key** (anonymous daily quota). The engine is pluggable behind {@link Translator}
 * so a local/offline backend (e.g. Bergamot WASM) or a self-hosted
 * LibreTranslate URL can be dropped in later.
 *
 * Source-language detection is script-based (Unicode ranges) — also no AI, no
 * network — which is accurate enough to decide "does this need translating?"
 * for short news strings.
 *
 * Translation is best-effort (like og:image enrichment): any failure leaves the
 * original text untouched. Already-translated items are skipped so refreshes do
 * not burn the daily quota.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { IngestItemInput } from './newsStore';

/** A pluggable translation engine. Returns `null` per item it could not translate. */
export type Translator = {
  /** Translate one string from `from` → `to`. Resolves `null` on any failure. */
  translate(text: string, from: string, to: string): Promise<string | null>;
};

export type TranslatorDeps = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Soft daily character budget (UTC). Once exceeded, {@link Translator.translate}
   * short-circuits to `null` without calling the API, so the free MyMemory quota
   * is never hammered. Defaults to 40_000 (well under the anonymous daily cap).
   */
  dailyCharBudget?: number;
  now?: () => number;
};

const MYMEMORY_URL = 'https://api.mymemory.translated.net/get';
/** MyMemory caps each `q` at 500 bytes; keep a safety margin for multi-byte text. */
const MAX_Q_BYTES = 480;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_DAILY_CHAR_BUDGET = 40_000;

// ---------------------------------------------------------------------------
// Locale ↔ MT language code
// ---------------------------------------------------------------------------

/**
 * Map an app i18n locale to the MT language code MyMemory expects. Chinese
 * keeps its region (`zh-CN`/`zh-TW`); everything else collapses to the base
 * ISO-639-1 tag.
 */
export const localeToMtLang = (locale: string): string => {
  const lc = locale.toLowerCase();
  if (lc === 'zh-cn' || lc === 'zh-hans') return 'zh-CN';
  if (lc === 'zh-tw' || lc === 'zh-hant') return 'zh-TW';
  return lc.split('-')[0];
};

/** Base language key used for the translation cache (`zh-CN` → `zh`). */
export const baseLang = (lang: string): string => lang.toLowerCase().split('-')[0];

// ---------------------------------------------------------------------------
// Script-based language detection (no AI, no network)
// ---------------------------------------------------------------------------

const RE_CYRILLIC = /[\u0400-\u04FF]/;
const RE_HANGUL = /[\uAC00-\uD7A3\u1100-\u11FF]/;
const RE_KANA = /[\u3040-\u30FF]/;
const RE_HAN = /[\u4E00-\u9FFF]/;
const RE_ARABIC = /[\u0600-\u06FF]/;
/** Vietnamese-specific Latin letters (đ + tone-marked vowels in the Latin Extended blocks). */
const RE_VIETNAMESE = /[ăâđêôơưĂÂĐÊÔƠƯ\u1EA0-\u1EF9]/;

/**
 * Best-effort source-language guess from a string's dominant script. Returns an
 * ISO-639-1 tag, or `null` when it looks like plain Latin/ambiguous text (we
 * treat that as English elsewhere). Cheap and deterministic.
 */
export const detectLang = (text: string): string | null => {
  if (!text) return null;
  if (RE_KANA.test(text)) return 'ja';
  if (RE_HANGUL.test(text)) return 'ko';
  if (RE_CYRILLIC.test(text)) return 'ru';
  if (RE_ARABIC.test(text)) return 'ar';
  if (RE_VIETNAMESE.test(text)) return 'vi';
  // Han without kana/hangul ⇒ Chinese (after ja/ko ruled out).
  if (RE_HAN.test(text)) return 'zh';
  // Pure Latin ⇒ unknown (caller defaults to English).
  return null;
};

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf-8');

/** Truncate a string so its UTF-8 byte length fits MyMemory's per-request cap. */
const clampToBytes = (text: string, maxBytes: number): string => {
  if (byteLength(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (byteLength(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
};

// ---------------------------------------------------------------------------
// MyMemory engine
// ---------------------------------------------------------------------------

type MyMemoryResponse = {
  responseStatus?: number | string;
  responseData?: { translatedText?: unknown };
};

/** Create the default MyMemory-backed translator (free, keyless). */
export const createMyMemoryTranslator = (deps: TranslatorDeps = {}): Translator => {
  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;
  const dailyBudget = deps.dailyCharBudget ?? DEFAULT_DAILY_CHAR_BUDGET;
  const now = deps.now ?? Date.now;
  let usageDay = '';
  let usageChars = 0;

  /** Reserve `n` chars against today's budget; returns false when over budget. */
  const reserve = (n: number): boolean => {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (day !== usageDay) {
      usageDay = day;
      usageChars = 0;
    }
    if (usageChars + n > dailyBudget) return false;
    usageChars += n;
    return true;
  };

  return {
    async translate(text, from, to) {
      const trimmed = text.trim();
      if (!trimmed) return '';
      const q = clampToBytes(trimmed, MAX_Q_BYTES);
      if (!reserve(q.length)) return null;
      const url = `${MYMEMORY_URL}?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(`${from}|${to}`)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const json = (await res.json()) as MyMemoryResponse;
        const status = Number(json.responseStatus);
        const translated = json.responseData?.translatedText;
        if (status !== 200 || typeof translated !== 'string' || translated.length === 0) return null;
        return translated;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

/** A translator that never translates — the `none`/disabled engine. */
export const noopTranslator: Translator = {
  translate: async () => null,
};

// ---------------------------------------------------------------------------
// Item-level translation
// ---------------------------------------------------------------------------

export type TranslateOptions = {
  /** Target app language (MT code, e.g. `vi`, `zh-CN`). */
  targetLang: string;
  /** Declared source language of the feed, or `null` to auto-detect per item. */
  feedLang?: string | null;
  /** Skip items for which this returns `true` (already cached for target). */
  isAlreadyTranslated?: (item: IngestItemInput) => boolean;
  /** Max items to translate per call (quota guard). Defaults to 30. */
  maxItems?: number;
};

const DEFAULT_MAX_ITEMS = 30;

/**
 * Translate the title + summary of freshly-fetched items into `targetLang`,
 * writing the result into `item.translations[base(targetLang)]` and recording
 * `item.sourceLang`. Items whose source language already equals the target, or
 * that are already translated, are left untouched. Best-effort and bounded.
 */
export const translateIngestItems = async (
  items: IngestItemInput[],
  translator: Translator,
  options: TranslateOptions
): Promise<IngestItemInput[]> => {
  const targetBase = baseLang(options.targetLang);
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  let budget = maxItems;

  for (const item of items) {
    if (budget <= 0) break;
    if (options.isAlreadyTranslated?.(item)) continue;

    const detected = options.feedLang ? baseLang(options.feedLang) : (detectLang(item.title) ?? 'en');
    item.sourceLang = detected;
    // No work when the source is already the app language.
    if (detected === targetBase) continue;
    if (item.translations?.[targetBase]) continue;

    budget -= 1;
    const fromLang = options.feedLang ?? detected;
    const [title, summary] = await Promise.all([
      translator.translate(item.title, fromLang, options.targetLang),
      item.summary ? translator.translate(item.summary, fromLang, options.targetLang) : Promise.resolve(''),
    ]);
    // Only cache when the title translated; a partial failure falls back to original.
    if (title) {
      item.translations = { ...item.translations, [targetBase]: { title, summary: summary ?? '' } };
    }
  }
  return items;
};
