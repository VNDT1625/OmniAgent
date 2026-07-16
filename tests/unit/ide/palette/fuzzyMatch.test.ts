/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { basename, fuzzyFilter, fuzzyScore } from '@/renderer/pages/studio/ide/palette/fuzzyMatch';

describe('fuzzyScore', () => {
  it('returns null when query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'abc')).toBeNull();
  });

  it('matches a subsequence in order and reports indices', () => {
    const r = fuzzyScore('abc', 'a_b_c');
    expect(r).not.toBeNull();
    expect(r?.indices).toEqual([0, 2, 4]);
  });

  it('empty query matches everything with score 0', () => {
    expect(fuzzyScore('', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('scores consecutive + boundary matches higher than scattered ones', () => {
    const consecutive = fuzzyScore('but', 'button')!.score;
    const scattered = fuzzyScore('but', 'b_u_t_x')!.score;
    expect(consecutive).toBeGreaterThan(scattered);
  });
});

describe('basename', () => {
  it('returns the last path segment', () => {
    expect(basename('a/b/c.ts')).toBe('c.ts');
    expect(basename('a\\b\\c.ts')).toBe('c.ts');
    expect(basename('c.ts')).toBe('c.ts');
  });
});

describe('fuzzyFilter', () => {
  const files = ['src/ui/Button.tsx', 'src/x/button-helpers/y.ts', 'src/app.ts', 'README.md'];

  it('ranks a basename match above a path-only match', () => {
    const out = fuzzyFilter('button', files, (f) => f);
    expect(out[0].item).toBe('src/ui/Button.tsx');
  });

  it('excludes non-matches', () => {
    const out = fuzzyFilter('zzz', files, (f) => f);
    expect(out).toHaveLength(0);
  });

  it('empty query returns the first N items unscored', () => {
    const out = fuzzyFilter('', files, (f) => f, 2);
    expect(out.map((m) => m.item)).toEqual(['src/ui/Button.tsx', 'src/x/button-helpers/y.ts']);
  });

  it('respects the limit', () => {
    const out = fuzzyFilter('s', files, (f) => f, 1);
    expect(out.length).toBeLessThanOrEqual(1);
  });
});
