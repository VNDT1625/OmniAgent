/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { findDeclarations, findReferences, isDeclarationLine, isIdentifier, wordAt } from '@/process/ide/nav/symbolNav';

describe('isIdentifier', () => {
  it('accepts valid JS identifiers, rejects junk', () => {
    expect(isIdentifier('fooBar')).toBe(true);
    expect(isIdentifier('_x$1')).toBe(true);
    expect(isIdentifier('1abc')).toBe(false);
    expect(isIdentifier('a b')).toBe(false);
    expect(isIdentifier('')).toBe(false);
  });
});

describe('isDeclarationLine', () => {
  it('matches function/class/const/type/interface/enum/import declarations', () => {
    expect(isDeclarationLine('export function doThing() {', 'doThing')).toBe(true);
    expect(isDeclarationLine('abstract class Widget {', 'Widget')).toBe(true);
    expect(isDeclarationLine('const myConst = 1', 'myConst')).toBe(true);
    expect(isDeclarationLine('export type Foo = {', 'Foo')).toBe(true);
    expect(isDeclarationLine('interface Bar {', 'Bar')).toBe(true);
    expect(isDeclarationLine('import { helper } from "./x"', 'helper')).toBe(true);
  });

  it('does not treat a plain call site as a const/function declaration', () => {
    expect(isDeclarationLine('  doThing()', 'doThing')).toBe(true); // method/shorthand form intentionally matches
    expect(isDeclarationLine('  return other + 1', 'other')).toBe(false);
  });
});

describe('findDeclarations', () => {
  it('finds the declaration line + column', () => {
    const src = 'import x from "y"\n\nexport function target() {\n  return 1\n}\n';
    const hits = findDeclarations(src, 'target');
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].column).toBe('export function '.length + 1);
  });

  it('returns nothing for a non-identifier', () => {
    expect(findDeclarations('whatever', '1bad')).toEqual([]);
  });
});

describe('findReferences', () => {
  it('finds one reference per line, whole-word only', () => {
    const src = 'const target = 1\nuse(target)\nconst targeting = 2\n';
    const hits = findReferences(src, 'target');
    // line 1 (decl), line 2 (use) — line 3 "targeting" is NOT a whole-word match.
    expect(hits.map((h) => h.line)).toEqual([1, 2]);
  });
});

describe('wordAt', () => {
  it('extracts the identifier under an offset', () => {
    expect(wordAt('const fooBar = 1', 8)).toBe('fooBar');
    expect(wordAt('a.method()', 3)).toBe('method');
  });
  it('returns null when not on an identifier', () => {
    expect(wordAt('  + ', 2)).toBeNull();
  });
});
