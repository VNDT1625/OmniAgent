/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  importSpecifierOnLine,
  isRelativeSpecifier,
  relationsFor,
  resolveImport,
} from '@/renderer/pages/studio/ide/codeRelations';

describe('isRelativeSpecifier', () => {
  it('accepts relative, rejects bare/package specifiers', () => {
    expect(isRelativeSpecifier('./a')).toBe(true);
    expect(isRelativeSpecifier('../a/b')).toBe(true);
    expect(isRelativeSpecifier('.')).toBe(true);
    expect(isRelativeSpecifier('..')).toBe(true);
    expect(isRelativeSpecifier('react')).toBe(false);
    expect(isRelativeSpecifier('@scope/pkg')).toBe(false);
    expect(isRelativeSpecifier('node:fs')).toBe(false);
  });
});

describe('importSpecifierOnLine', () => {
  it('extracts from each supported import form', () => {
    expect(importSpecifierOnLine("import { x } from './a'")).toBe('./a');
    expect(importSpecifierOnLine('import type { X } from "../b"')).toBe('../b');
    expect(importSpecifierOnLine("export { y } from './c'")).toBe('./c');
    expect(importSpecifierOnLine("import './side-effect'")).toBe('./side-effect');
    expect(importSpecifierOnLine("const m = require('./d')")).toBe('./d');
    expect(importSpecifierOnLine("const m = await import('./e')")).toBe('./e');
  });

  it('returns null on a non-import line', () => {
    expect(importSpecifierOnLine('const x = 1;')).toBeNull();
    expect(importSpecifierOnLine('return foo(bar);')).toBeNull();
  });

  it('ignores commented-out import lines', () => {
    expect(importSpecifierOnLine("// import { x } from './a'")).toBeNull();
    expect(importSpecifierOnLine("  * import './b' (in a block comment)")).toBeNull();
  });

  it('returns null for empty / whitespace lines', () => {
    expect(importSpecifierOnLine('')).toBeNull();
    expect(importSpecifierOnLine('   ')).toBeNull();
  });
});

describe('resolveImport', () => {
  const known = new Set(['src/a.ts', 'src/b/index.ts', 'src/c.tsx', 'src/sub/d.ts']);

  it('resolves a literal target', () => {
    expect(resolveImport('src/x.ts', './a.ts', known)).toBe('src/a.ts');
  });

  it('resolves by trying code extensions', () => {
    expect(resolveImport('src/x.ts', './a', known)).toBe('src/a.ts');
    expect(resolveImport('src/x.ts', './c', known)).toBe('src/c.tsx');
  });

  it('resolves a directory to its index file', () => {
    expect(resolveImport('src/x.ts', './b', known)).toBe('src/b/index.ts');
  });

  it('resolves ../ against the importer directory', () => {
    expect(resolveImport('src/sub/x.ts', '../a', known)).toBe('src/a.ts');
    expect(resolveImport('src/sub/x.ts', './d', known)).toBe('src/sub/d.ts');
  });

  it('returns null for bare specifiers and unresolved paths', () => {
    expect(resolveImport('src/x.ts', 'react', known)).toBeNull();
    expect(resolveImport('src/x.ts', './missing', known)).toBeNull();
  });
});

describe('relationsFor', () => {
  const edges = [
    { from: 'a.ts', to: 'b.ts' },
    { from: 'a.ts', to: 'c.ts' },
    { from: 'd.ts', to: 'a.ts' },
    { from: 'e.ts', to: 'a.ts' },
    { from: 'a.ts', to: 'b.ts' }, // duplicate dependency
  ];

  it('computes depends-on (dedup + sorted)', () => {
    expect(relationsFor('a.ts', edges).dependsOn).toEqual(['b.ts', 'c.ts']);
  });

  it('computes used-by (dedup + sorted)', () => {
    expect(relationsFor('a.ts', edges).usedBy).toEqual(['d.ts', 'e.ts']);
  });

  it('returns empty sets for an unrelated file', () => {
    expect(relationsFor('z.ts', edges)).toEqual({ dependsOn: [], usedBy: [] });
  });
});
