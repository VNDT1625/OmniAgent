/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseUnixLint } from '@/process/ide/lint/lintParse';

describe('parseUnixLint', () => {
  it('parses a basic unix diagnostic line', () => {
    const out = parseUnixLint('src/app.ts:12:5: Unexpected console statement [no-console]');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ line: 12, column: 5, rule: 'no-console' });
    expect(out[0].message).toBe('Unexpected console statement');
  });

  it('handles Windows paths with a drive letter', () => {
    const out = parseUnixLint('C:\\repo\\src\\app.ts:3:1: Something is wrong (some-rule)');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ line: 3, column: 1, rule: 'some-rule', message: 'Something is wrong' });
  });

  it('detects error vs warning wording', () => {
    const out = parseUnixLint('a.ts:1:1: error: parsing failed\nb.ts:2:2: just a warning here');
    expect(out[0].severity).toBe('error');
    expect(out[1].severity).toBe('warning');
  });

  it('uses the severity hint when wording is neutral', () => {
    const out = parseUnixLint('a.ts:1:1: neutral message [r]', 'error');
    expect(out[0].severity).toBe('error');
  });

  it('ignores summary / non-matching lines', () => {
    const out = parseUnixLint('Found 2 warnings.\n\nrandom text\nsrc/x.ts:5:5: real one [r]');
    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(5);
  });

  it('clamps line/column to at least 1', () => {
    const out = parseUnixLint('a.ts:0:0: edge [r]');
    expect(out[0].line).toBe(1);
    expect(out[0].column).toBe(1);
  });

  it('returns empty for empty input', () => {
    expect(parseUnixLint('')).toEqual([]);
  });
});
