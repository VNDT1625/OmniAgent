/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the renderer-side terminal display helpers (stripAnsi /
 * normalizeOutput). These are pure functions but the module lives under the
 * renderer alias, so the test runs in the dom project for consistent resolution.
 */

import { describe, expect, it } from 'vitest';
import { findMtuiStaleConfirmation, normalizeOutput, stripAnsi } from '@renderer/pages/terminal/constants';

describe('stripAnsi', () => {
  it('removes CSI color sequences but keeps the text', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m text')).toBe('red text');
  });

  it('removes OSC window-title sequences', () => {
    expect(stripAnsi('\u001b]0;my title\u0007hello')).toBe('hello');
  });

  it('keeps newlines, tabs and carriage returns', () => {
    expect(stripAnsi('a\tb\nc\r')).toBe('a\tb\nc\r');
  });

  it('strips bare control characters', () => {
    expect(stripAnsi('a\u0001b\u0008c')).toBe('abc');
  });
});

describe('normalizeOutput', () => {
  it('collapses carriage-return overwrites to the last segment per line', () => {
    expect(normalizeOutput('10%\r50%\r100%')).toBe('100%');
  });

  it('preserves multiple lines', () => {
    expect(normalizeOutput('line1\nline2')).toBe('line1\nline2');
  });

  it('applies CR collapsing independently on each line', () => {
    expect(normalizeOutput('a\rb\nc\rd')).toBe('b\nd');
  });
});

describe('findMtuiStaleConfirmation', () => {
  it('extracts needs_confirmation details from pretty MTUI JSON output', () => {
    const output = [
      'mtui --json edit sample.ts line 6 replace x',
      JSON.stringify(
        {
          ok: false,
          details: {
            current_hash: 'after-a',
            resolution: {
              status: 'needs_confirmation',
              confirmation_token: 'token-1',
            },
            checked_operations: [{ diff_excerpt: '+ return bar() + 1;' }],
          },
        },
        null,
        2
      ),
    ].join('\n');

    expect(findMtuiStaleConfirmation(output)).toMatchObject({
      token: 'token-1',
      status: 'needs_confirmation',
      diffExcerpt: '+ return bar() + 1;',
      acceptCommand: 'mtui --json conflict accept token-1',
    });
  });

  it('returns null when output has no MTUI stale confirmation', () => {
    expect(findMtuiStaleConfirmation('plain output\n')).toBeNull();
  });
});
