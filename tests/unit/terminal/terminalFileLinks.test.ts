/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the terminal `file:line:col` link parser. The regex is the
 * tricky part (must catch real paths but not prose with colons), so it is tested
 * in isolation. `parseFileLinks` is pure; it only imports xterm *types*.
 */

import { describe, expect, it } from 'vitest';
import { parseFileLinks } from '@/renderer/pages/terminal/components/terminalFileLinks';

describe('parseFileLinks', () => {
  it('parses a posix path with line and column', () => {
    const [link] = parseFileLinks('  at src/app.ts:12:5 (anonymous)');
    expect(link.path).toBe('src/app.ts');
    expect(link.line).toBe(12);
    expect(link.column).toBe(5);
  });

  it('parses a path with line only', () => {
    const [link] = parseFileLinks('./components/Button.tsx:40');
    expect(link.path).toBe('./components/Button.tsx');
    expect(link.line).toBe(40);
    expect(link.column).toBeUndefined();
  });

  it('parses a Windows-style (line,col) suffix', () => {
    const [link] = parseFileLinks('C:\\repo\\file.cs(120,8): error CS0001');
    expect(link.path).toBe('C:\\repo\\file.cs');
    expect(link.line).toBe(120);
    expect(link.column).toBe(8);
  });

  it('parses a bare path with an extension and no position', () => {
    const [link] = parseFileLinks('see README.md for details');
    expect(link.path).toBe('README.md');
    expect(link.line).toBeUndefined();
  });

  it('does not treat prose with a colon as a link', () => {
    // "Error" has no path separator and no file extension → not a link.
    expect(parseFileLinks('Error: something went wrong')).toHaveLength(0);
  });

  it('reports column ranges within the source line', () => {
    const text = 'x src/a.ts:1';
    const [link] = parseFileLinks(text);
    expect(text.slice(link.startCol, link.endCol)).toBe('src/a.ts:1');
  });

  it('finds multiple links on one line', () => {
    const links = parseFileLinks('a.ts:1 and b.tsx:2:3');
    expect(links.map((l) => l.path)).toEqual(['a.ts', 'b.tsx']);
  });
});
