/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

// The bridge imports the provider chat layer (which pulls heavy Node deps); the
// pure helpers under test don't need it, so stub it out.
vi.mock('@/process/ide/ideProvider', () => ({
  runIdeChat: vi.fn(),
  resolveDefaultModel: vi.fn(),
}));

import { buildCompletionMessages, stripCodeFence } from '@/process/ide/lang/ideCompletionBridge';

describe('stripCodeFence', () => {
  it('strips a fenced block with a language tag', () => {
    expect(stripCodeFence('```ts\nconst x = 1;\n```')).toBe('const x = 1;');
  });

  it('strips a fenced block without a language tag', () => {
    expect(stripCodeFence('```\nfoo()\n```')).toBe('foo()');
  });

  it('preserves multi-line inner content', () => {
    expect(stripCodeFence('```js\na\nb\n```')).toBe('a\nb');
  });

  it('leaves un-fenced text untouched (just trims)', () => {
    expect(stripCodeFence('  const y = 2;  ')).toBe('const y = 2;');
  });
});

describe('buildCompletionMessages', () => {
  it('returns a system + user message carrying language, prefix, suffix and the cursor marker', () => {
    const messages = buildCompletionMessages({
      prefix: 'const a = ',
      suffix: ';\nconst b = 2;',
      language: 'typescript',
      filePath: '/repo/a.ts',
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('Language: typescript');
    expect(messages[1].content).toContain('const a = ');
    expect(messages[1].content).toContain('<|cursor|>');
    expect(messages[1].content).toContain('const b = 2;');
  });

  it('caps the prefix to the last 4000 chars and suffix to the first 1000', () => {
    const messages = buildCompletionMessages({
      prefix: 'P'.repeat(5000),
      suffix: 'S'.repeat(2000),
      language: 'javascript',
    });
    const content = messages[1].content;
    const prefixRun = content.match(/P+/)?.[0].length ?? 0;
    const suffixRun = content.match(/S+/)?.[0].length ?? 0;
    expect(prefixRun).toBe(4000);
    expect(suffixRun).toBe(1000);
  });
});
