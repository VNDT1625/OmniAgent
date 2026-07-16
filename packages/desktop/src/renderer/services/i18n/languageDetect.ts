/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight, dependency-free heuristic to estimate how much of a piece of
 * text is written in a language *other* than the app's active language. Used to
 * adaptively escalate the response-language constraint: the cheap tag stays the
 * default, and the strong directive only kicks in for a conversation once a
 * reply actually drifts away from the user's language.
 *
 * This is intentionally a heuristic, not a real language detector:
 *  - Script-distinct languages (Chinese/Japanese/Korean/Cyrillic) are detected
 *    accurately by Unicode block.
 *  - Latin-script languages (English/Vietnamese/Turkish) are disambiguated by
 *    diacritic density, which is robust for the dominant failure mode (a reply
 *    entirely in the wrong language) while avoiding over-escalation when a
 *    reply mixes in some foreign technical terms.
 *
 * Pure module (no i18n / DOM imports) so it is trivially unit-testable.
 */

/** Language group that determines which scripts count as "native". */
type LangGroup = 'han' | 'jpn' | 'kor' | 'cyrillic' | 'latin-en' | 'latin-vi' | 'latin-tr';

const GROUP_BY_CODE: Record<string, LangGroup> = {
  'zh-CN': 'han',
  'zh-TW': 'han',
  'ja-JP': 'jpn',
  'ko-KR': 'kor',
  'ru-RU': 'cyrillic',
  'uk-UA': 'cyrillic',
  'en-US': 'latin-en',
  'vi-VN': 'latin-vi',
  'tr-TR': 'latin-tr',
};

// Strip code fences, inline code and URLs — those are English by nature and
// must not count against the prose language.
const RE_FENCED = /```[\s\S]*?```/g;
const RE_INLINE = /`[^`]*`/g;
const RE_URL = /https?:\/\/\S+/g;

const RE_HAN = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const RE_KANA = /[\u3040-\u30FF]/;
const RE_HANGUL = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/;
const RE_CYRILLIC = /[\u0400-\u04FF]/;
const RE_LATIN_PLAIN = /[A-Za-z]/;
const RE_LATIN_DIACRITIC = /[\u00C0-\u024F\u1E00-\u1EFF]/;

// Minimum letters required before a verdict is trustworthy.
const MIN_LETTERS = 16;
// Expected diacritic density of genuine Vietnamese / Turkish prose. Tuned so a
// reply fully in the language reads as native and a reply fully in English
// reads as foreign, while a localized reply with some foreign terms stays low.
const VI_EXPECTED_DENSITY = 0.1;
const TR_EXPECTED_DENSITY = 0.05;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

type Counts = { han: number; kana: number; hangul: number; cyr: number; latinPlain: number; latinDia: number };

const countScripts = (text: string): Counts => {
  const counts: Counts = { han: 0, kana: 0, hangul: 0, cyr: 0, latinPlain: 0, latinDia: 0 };
  for (const ch of text) {
    if (RE_HAN.test(ch)) counts.han++;
    else if (RE_KANA.test(ch)) counts.kana++;
    else if (RE_HANGUL.test(ch)) counts.hangul++;
    else if (RE_CYRILLIC.test(ch)) counts.cyr++;
    else if (RE_LATIN_PLAIN.test(ch)) counts.latinPlain++;
    else if (RE_LATIN_DIACRITIC.test(ch)) counts.latinDia++;
    // digits, punctuation, whitespace, emoji, CJK punctuation → ignored
  }
  return counts;
};

/**
 * Estimate the fraction (0..1) of `text` that is in a language other than the
 * one identified by `langCode`. Returns `0` for empty/too-short input or an
 * unknown language code (i.e. "no evidence of drift").
 */
export const foreignLanguageRatio = (text: string, langCode: string): number => {
  const group = GROUP_BY_CODE[langCode];
  if (!group) return 0;

  const prose = text.replace(RE_FENCED, ' ').replace(RE_INLINE, ' ').replace(RE_URL, ' ');
  const c = countScripts(prose);
  const total = c.han + c.kana + c.hangul + c.cyr + c.latinPlain + c.latinDia;
  if (total < MIN_LETTERS) return 0;

  switch (group) {
    case 'han':
      return clamp01((total - c.han) / total);
    case 'jpn':
      return clamp01((total - c.han - c.kana) / total);
    case 'kor':
      return clamp01((total - c.hangul) / total);
    case 'cyrillic':
      return clamp01((total - c.cyr) / total);
    case 'latin-en':
      // Native = plain ASCII Latin; everything else (diacritics, CJK, Cyrillic) is foreign.
      return clamp01((total - c.latinPlain) / total);
    case 'latin-vi':
    case 'latin-tr': {
      const expected = group === 'latin-vi' ? VI_EXPECTED_DENSITY : TR_EXPECTED_DENSITY;
      const latinTotal = c.latinPlain + c.latinDia;
      const nonLatin = c.han + c.kana + c.hangul + c.cyr;
      const density = latinTotal > 0 ? c.latinDia / latinTotal : 0;
      const nativeFrac = clamp01(density / expected);
      const nativeLatin = latinTotal * nativeFrac;
      const foreign = nonLatin + (latinTotal - nativeLatin);
      return clamp01(foreign / total);
    }
    default:
      return 0;
  }
};
