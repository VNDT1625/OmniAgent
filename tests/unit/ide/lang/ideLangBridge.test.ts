/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseAnalyzeType } from '../../../../packages/desktop/src/process/ide/lang/ideLangBridge';

describe('parseAnalyzeType', () => {
  it('parses a well-formed analyze-type payload', () => {
    const raw = {
      totalFiles: 100,
      dominant: ['typescript', 'json'],
      languages: [
        {
          language: 'typescript',
          fileCount: 75,
          sharePercent: 75,
          engine: { kind: 'monaco-builtin', server: null, cost: 'free', defaultOn: true, reason: 'x' },
        },
        {
          language: 'rust',
          fileCount: 25,
          sharePercent: 25,
          engine: { kind: 'lsp', server: 'rust-analyzer', cost: 'heavy', defaultOn: false, reason: 'y' },
        },
      ],
    };
    const result = parseAnalyzeType(raw);
    expect(result.totalFiles).toBe(100);
    expect(result.dominant).toEqual(['typescript', 'json']);
    expect(result.languages).toHaveLength(2);
    expect(result.languages[1].engine.kind).toBe('lsp');
    expect(result.languages[1].engine.server).toBe('rust-analyzer');
  });

  it('defaults unknown engine kind to syntax and cost to free', () => {
    const result = parseAnalyzeType({
      languages: [{ language: 'foo', engine: { kind: 'weird', cost: 'nonsense' } }],
    });
    expect(result.languages[0].engine.kind).toBe('syntax');
    expect(result.languages[0].engine.cost).toBe('free');
  });

  it('treats missing defaultOn as true (only explicit false disables)', () => {
    const onByDefault = parseAnalyzeType({ languages: [{ language: 'a', engine: {} }] });
    expect(onByDefault.languages[0].engine.defaultOn).toBe(true);
    const off = parseAnalyzeType({ languages: [{ language: 'b', engine: { defaultOn: false } }] });
    expect(off.languages[0].engine.defaultOn).toBe(false);
  });

  it('tolerates a completely empty / odd payload', () => {
    expect(parseAnalyzeType(null)).toEqual({ totalFiles: 0, languages: [], dominant: [] });
    expect(parseAnalyzeType({})).toEqual({ totalFiles: 0, languages: [], dominant: [] });
    expect(parseAnalyzeType({ languages: 'not-array' })).toEqual({ totalFiles: 0, languages: [], dominant: [] });
  });

  it('filters non-string dominant entries', () => {
    const result = parseAnalyzeType({ dominant: ['ts', 5, null, 'js'], languages: [] });
    expect(result.dominant).toEqual(['ts', 'js']);
  });
});
