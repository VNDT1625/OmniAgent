/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildSearchRegExp, escapeRegExp, grepText, replaceInText } from '@/process/ide/search/grepCore';

describe('escapeRegExp', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b(c)')).toBe('a\\.b\\(c\\)');
  });
});

describe('buildSearchRegExp', () => {
  it('is case-insensitive by default, sensitive on request', () => {
    expect(buildSearchRegExp('Foo').flags).toContain('i');
    expect(buildSearchRegExp('Foo', { caseSensitive: true }).flags).not.toContain('i');
  });
  it('wraps whole-word matches in boundaries', () => {
    const re = buildSearchRegExp('cat', { wholeWord: true });
    expect(re.test('a cat sat')).toBe(true);
    expect(buildSearchRegExp('cat', { wholeWord: true }).test('category')).toBe(false);
  });
  it('treats the query as literal unless regex is set', () => {
    expect(buildSearchRegExp('a.b').test('axb')).toBe(false);
    expect(buildSearchRegExp('a.b', { regex: true }).test('axb')).toBe(true);
  });
});

describe('grepText', () => {
  const text = 'import a\nconst foo = 1\nconst Foo = 2\n';
  it('returns 1-based line numbers of matching lines', () => {
    const m = grepText(text, 'foo');
    expect(m.map((x) => x.line)).toEqual([2, 3]); // case-insensitive
  });
  it('respects case sensitivity', () => {
    const m = grepText(text, 'Foo', { caseSensitive: true });
    expect(m.map((x) => x.line)).toEqual([3]);
  });
  it('empty query returns nothing', () => {
    expect(grepText(text, '')).toEqual([]);
  });
});

describe('replaceInText', () => {
  it('replaces all literal occurrences and counts them', () => {
    const r = replaceInText('foo foo bar', 'foo', 'baz');
    expect(r.content).toBe('baz baz bar');
    expect(r.count).toBe(2);
  });
  it('does not treat $ in a literal replacement as a group ref', () => {
    const r = replaceInText('price here', 'price', '$5');
    expect(r.content).toBe('$5 here');
  });
  it('expands capture groups for a regex replacement', () => {
    const r = replaceInText('2026-06-03', '(\\d+)-(\\d+)-(\\d+)', '$3/$2/$1', { regex: true });
    expect(r.content).toBe('03/06/2026');
    expect(r.count).toBe(1);
  });
  it('returns count 0 and unchanged content on no match', () => {
    const r = replaceInText('abc', 'zzz', 'x');
    expect(r).toEqual({ content: 'abc', count: 0 });
  });
});
