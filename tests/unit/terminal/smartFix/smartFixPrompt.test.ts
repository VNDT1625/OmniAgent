/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildAckLine, buildConfirmPrompt, interpretConfirmKey } from '@/process/terminal/smartFix/smartFixPrompt';

describe('interpretConfirmKey', () => {
  it('accepts y / Y', () => {
    expect(interpretConfirmKey('y')).toBe('accept');
    expect(interpretConfirmKey('Y')).toBe('accept');
  });
  it('rejects n / N / Esc', () => {
    expect(interpretConfirmKey('n')).toBe('reject');
    expect(interpretConfirmKey('N')).toBe('reject');
    expect(interpretConfirmKey('\x1b')).toBe('reject');
  });
  it('does NOT treat Enter as a default-yes', () => {
    expect(interpretConfirmKey('\r')).toBe('ignore');
    expect(interpretConfirmKey('\n')).toBe('ignore');
  });
  it('ignores other keys', () => {
    expect(interpretConfirmKey('a')).toBe('ignore');
    expect(interpretConfirmKey(' ')).toBe('ignore');
  });
});

describe('buildConfirmPrompt', () => {
  it('includes both programs and the question', () => {
    const line = buildConfirmPrompt('gemini', 'agi', { tag: 'Smart Fix', question: 'run `agi`? (y/N)' });
    expect(line).toContain('gemini → agi');
    expect(line).toContain('Smart Fix');
    expect(line).toContain('run `agi`? (y/N)');
    expect(line.startsWith('\r\n')).toBe(true);
    expect(line.endsWith(' ')).toBe(true);
  });
});

describe('buildAckLine', () => {
  it('wraps text with CRLF framing', () => {
    const line = buildAckLine('skipped');
    expect(line).toContain('skipped');
    expect(line.startsWith('\r\n')).toBe(true);
    expect(line.endsWith('\r\n')).toBe(true);
  });
});
