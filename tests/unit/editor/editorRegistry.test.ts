/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Property + unit tests for renderer/pages/editor/editorRegistry — Property 6
 * ("Không bao giờ kẹt mở file" / never stuck): the Universal Editor registry
 * ALWAYS resolves any file to some adapter kind. There is no input — arbitrary
 * file names (unicode, random/absent extensions, dotfiles, trailing dots, mixed
 * path separators, empty string) and arbitrary/absent MIME — for which
 * classification throws or returns `undefined`. When nothing more specific
 * matches, the result falls back to `'raw-text'` (criterion 2.9), and
 * archives / packaged binaries resolve to `'binary-inspect'` (criterion 2.8).
 *
 * fast-check is not a dependency of this repo, so the universal invariants are
 * exercised with a deterministic seeded PRNG + randomized loops (each failure
 * reports its run index and seed so the counterexample is reproducible).
 *
 * The registry is pure TypeScript (no DOM, no React), so this lives in the
 * default node test project (`editorRegistry.test.ts`, not `.dom.test.tsx`).
 *
 * Validates: Requirements 2.8, 2.9
 */

import { describe, expect, it } from 'vitest';
import type { EditorAdapterKind } from '@/renderer/pages/editor/editorRegistry';
import {
  ADAPTER_EXTENSIONS,
  ADAPTER_MIME_PREFIXES,
  ADAPTER_MIME_TYPES,
  ALL_EDITOR_ADAPTER_KINDS,
  classifyFileType,
  RAW_TEXT_ADAPTER_KIND,
  resolveAdapterKind,
} from '@/renderer/pages/editor/editorRegistry';

// --- Deterministic property-testing harness (no external deps) -------------

/** Number of randomized cases per property. */
const PROPERTY_RUNS = 200;

/** mulberry32 — a small, fast, deterministic PRNG seeded by a single integer. */
const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Run `check` over many deterministic seeds. On the first failing case the
 * original assertion error is re-thrown with the run index and seed attached so
 * the counterexample is reproducible.
 */
const forAllSeeds = (runs: number, check: (rng: () => number, run: number) => void): void => {
  for (let run = 0; run < runs; run++) {
    const seed = ((run + 1) * 0x9e3779b1) >>> 0;
    try {
      check(makeRng(seed), run);
    } catch (error) {
      throw new Error(`Property failed on run ${run} (seed ${seed}): ${(error as Error).message}`, { cause: error });
    }
  }
};

// --- Known-value sets derived from the registry tables ---------------------

/** Every adapter kind, as a fast membership set. */
const ALL_KINDS = new Set<string>(ALL_EDITOR_ADAPTER_KINDS);

/** Every extension that maps to a specific adapter (lowercase, no dot). */
const KNOWN_EXTENSIONS = new Set<string>(Object.values(ADAPTER_EXTENSIONS).flat());

/** Every exact MIME type the registry recognizes (lowercase). */
const KNOWN_MIME_TYPES = new Set<string>(Object.values(ADAPTER_MIME_TYPES).flat());

/** MIME family prefixes that map a broad family to a kind (image/, text/, …). */
const KNOWN_MIME_PREFIXES = ADAPTER_MIME_PREFIXES.map((rule) => rule.prefix);

// --- Generators ------------------------------------------------------------

const randInt = (rng: () => number, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

const pick = <T>(rng: () => number, items: readonly T[]): T => items[randInt(rng, 0, items.length - 1)];

/** Wide alphabet incl. unicode, separators and dots to stress the parser. */
const FILENAME_ALPHABET = Array.from('abcXYZ012 -_.()[]/\\中文字éàçñ🤖🌟。，');

const randRawString = (rng: () => number, maxLen = 16): string => {
  const len = randInt(rng, 0, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += pick(rng, FILENAME_ALPHABET);
  return out;
};

const LOWER = 'abcdefghijklmnopqrstuvwxyz';

/** A lowercase token of letters only (used to build extensions/segments). */
const randToken = (rng: () => number, minLen = 1, maxLen = 10): string => {
  const len = randInt(rng, minLen, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += LOWER[randInt(rng, 0, LOWER.length - 1)];
  return out;
};

/** A lowercase extension guaranteed NOT to map to any specific adapter. */
const randUnknownExtension = (rng: () => number): string => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const ext = randToken(rng, 3, 8);
    if (!KNOWN_EXTENSIONS.has(ext)) return ext;
  }
  // Astronomically unlikely fallback — a long token cannot be a real extension.
  return 'zzqqxx';
};

/**
 * A MIME string guaranteed NOT to match any exact entry or family prefix, so it
 * cannot rescue classification away from the raw-text fallback.
 */
const randUnknownMime = (rng: () => number): string => {
  const safeTypes = ['x-aionui', 'blobtype', 'vendor', 'custom', 'unknowntype'];
  for (let attempt = 0; attempt < 50; attempt++) {
    const mime = `${pick(rng, safeTypes)}/${randToken(rng, 3, 10)}`;
    const normalized = mime.toLowerCase();
    if (KNOWN_MIME_TYPES.has(normalized)) continue;
    if (KNOWN_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) continue;
    return mime;
  }
  return 'x-aionui/definitely-unknown';
};

/** Re-case a token to UPPER or an alternating MiXeD case (for case-insensitivity). */
const toUpper = (token: string): string => token.toUpperCase();
const toMixed = (token: string): string =>
  Array.from(token)
    .map((ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
    .join('');

/**
 * Generate an arbitrary file name spanning every awkward shape an editor might
 * be handed: empty, unicode, random/no extension, dotfiles, trailing dots, and
 * paths using `/` and `\` separators.
 */
const genArbitraryFileName = (rng: () => number): string => {
  const category = randInt(rng, 0, 8);
  switch (category) {
    case 0:
      return '';
    case 1:
      return randRawString(rng, 20); // arbitrary unicode soup
    case 2:
      return `${randToken(rng, 1, 8)}.${randUnknownExtension(rng)}`; // unknown extension
    case 3:
      return randToken(rng, 1, 12); // no extension
    case 4:
      return `.${randToken(rng, 1, 8)}`; // dotfile (leading dot)
    case 5:
      return `${randToken(rng, 1, 8)}.`; // trailing dot
    case 6:
      return `/${randToken(rng, 1, 6)}/${randToken(rng, 1, 6)}.${randUnknownExtension(rng)}`; // posix path
    case 7:
      return `C:\\${randToken(rng, 1, 6)}\\${randToken(rng, 1, 6)}.${randToken(rng, 1, 4)}`; // windows path
    default:
      return `${randRawString(rng, 10)}.${randRawString(rng, 4)}`; // unicode + unicode ext
  }
};

/** Arbitrary or absent MIME hint (incl. params and junk). */
const genArbitraryMime = (rng: () => number): string | undefined => {
  const category = randInt(rng, 0, 4);
  switch (category) {
    case 0:
      return undefined;
    case 1:
      return '';
    case 2:
      return randUnknownMime(rng);
    case 3:
      return `${pick(rng, KNOWN_MIME_PREFIXES)}${randToken(rng, 2, 8)}`; // family prefix
    default:
      return `${randUnknownMime(rng)}; charset=utf-8`; // with parameters
  }
};

// --- Property 6 ------------------------------------------------------------

describe('editorRegistry — Property 6: không bao giờ kẹt mở file (Requirements 2.8, 2.9)', () => {
  describe('classification is total: every file resolves to a real adapter kind', () => {
    it('for arbitrary file names + arbitrary/absent MIME, never throws and always returns a known kind', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const fileName = genArbitraryFileName(rng);
        const mime = genArbitraryMime(rng);

        let kind: EditorAdapterKind | undefined;
        expect(() => {
          kind = classifyFileType(fileName, mime);
        }).not.toThrow();
        expect(kind).toBeDefined();
        expect(ALL_KINDS.has(kind as string)).toBe(true);

        // resolveAdapterKind is just the descriptor-shaped wrapper — same guarantee.
        const viaDescriptor = resolveAdapterKind({ fileName, mime });
        expect(viaDescriptor).toBe(kind);
        expect(ALL_KINDS.has(viaDescriptor)).toBe(true);
      });
    });
  });

  describe('unknown file + unknown MIME falls back to raw-text (criterion 2.9 — never stuck)', () => {
    it('an unknown extension with absent or unrecognized MIME always resolves to raw-text', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const ext = randUnknownExtension(rng);
        const fileName = `${randToken(rng, 1, 12)}.${ext}`;
        // Either no hint at all, or a junk MIME that matches no rule.
        const mime = rng() < 0.5 ? undefined : randUnknownMime(rng);

        expect(classifyFileType(fileName, mime)).toBe(RAW_TEXT_ADAPTER_KIND);
        expect(RAW_TEXT_ADAPTER_KIND).toBe('raw-text');
      });
    });
  });

  describe('the extension table is honored exactly, case-insensitively (criterion 2.1 backing)', () => {
    it('every listed extension classifies to its kind in lower, UPPER and MiXeD case', () => {
      for (const kind of ALL_EDITOR_ADAPTER_KINDS) {
        const extensions = ADAPTER_EXTENSIONS[kind as Exclude<EditorAdapterKind, 'raw-text'>];
        if (!extensions) continue; // 'raw-text' has no table — it is the fallback.
        for (const ext of extensions) {
          for (const variant of [ext, toUpper(ext), toMixed(ext)]) {
            const fileName = `document.${variant}`;
            expect(classifyFileType(fileName)).toBe(kind);
          }
        }
      }
    });
  });

  describe('archives / packaged binaries open in inspect mode (criterion 2.8)', () => {
    it('every binary-inspect extension resolves to binary-inspect (no manual-edit adapter)', () => {
      for (const ext of ADAPTER_EXTENSIONS['binary-inspect']) {
        expect(classifyFileType(`bundle.${ext}`)).toBe('binary-inspect');
        expect(classifyFileType(`BUNDLE.${ext.toUpperCase()}`)).toBe('binary-inspect');
      }
    });
  });

  describe('MIME exact matches and family prefixes drive classification when the extension is unknown', () => {
    it('a known exact MIME maps to its kind for a file whose extension is unrecognized', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const entries: Array<[EditorAdapterKind, readonly string[]]> = Object.entries(ADAPTER_MIME_TYPES) as Array<
          [EditorAdapterKind, readonly string[]]
        >;
        const withMimes = entries.filter(([, mimes]) => mimes.length > 0);
        const [kind, mimes] = pick(rng, withMimes);
        const mime = pick(rng, mimes);
        // Unknown extension so the MIME hint is what actually decides the kind.
        const fileName = `payload.${randUnknownExtension(rng)}`;

        expect(classifyFileType(fileName, mime)).toBe(kind);
        // Parameters and casing must not defeat the lookup.
        expect(classifyFileType(fileName, `${mime.toUpperCase()}; charset=utf-8`)).toBe(kind);
      });
    });

    it('image/* , video/* , audio/* , text/* prefixes map to their family when the extension is unknown', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const rule = pick(rng, ADAPTER_MIME_PREFIXES);
        // Build a sub-type that is NOT a known exact MIME (so the prefix rule is exercised).
        let mime = `${rule.prefix}${randToken(rng, 2, 10)}`;
        for (let attempt = 0; attempt < 20 && KNOWN_MIME_TYPES.has(mime.toLowerCase()); attempt++) {
          mime = `${rule.prefix}${randToken(rng, 2, 10)}`;
        }
        const fileName = `asset.${randUnknownExtension(rng)}`;

        expect(classifyFileType(fileName, mime)).toBe(rule.kind);
      });
    });
  });
});

// --- Example-based unit tests (concrete, human-readable guards) -------------

describe('editorRegistry — example-based unit tests', () => {
  it('classifies common documents by extension', () => {
    expect(classifyFileType('report.pdf')).toBe('pdf');
    expect(classifyFileType('memo.docx')).toBe('docx');
    expect(classifyFileType('script.py')).toBe('text-code');
  });

  it('falls back to raw-text for an unknown extension (criterion 2.9)', () => {
    expect(classifyFileType('mystery.zzz')).toBe('raw-text');
  });

  it('opens archives in binary-inspect mode (criterion 2.8)', () => {
    expect(classifyFileType('release.zip')).toBe('binary-inspect');
  });

  it('recognizes well-known extensionless filenames', () => {
    expect(classifyFileType('Dockerfile')).toBe('text-code');
  });

  it('returns raw-text for an empty file name', () => {
    expect(classifyFileType('')).toBe('raw-text');
  });

  it('resolveAdapterKind agrees with classifyFileType for a descriptor', () => {
    expect(resolveAdapterKind({ fileName: 'photo.png' })).toBe('image');
    expect(resolveAdapterKind({ fileName: 'no-extension', mime: 'audio/mpeg' })).toBe('media');
    expect(resolveAdapterKind({ fileName: 'unknown.qux' })).toBe('raw-text');
  });
});
