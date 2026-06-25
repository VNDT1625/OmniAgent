/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildEmbeddingText, embeddingTextFromDraft } from '@/process/knowledge/realtime/embeddingText';

describe('buildEmbeddingText', () => {
  it('includes topic, question and value', () => {
    const text = buildEmbeddingText({ topic: 'nodejs.lts.version', question: 'latest Node LTS?', value: '22.x' });
    expect(text).toContain('Topic: nodejs.lts.version');
    expect(text).toContain('Question: latest Node LTS?');
    expect(text).toContain('Value: 22.x');
  });

  it('adds aliases and tags when present', () => {
    const text = buildEmbeddingText({
      topic: 't',
      question: 'q',
      value: 'v',
      aliases: ['newest nodejs', 'node version'],
      tags: ['node', 'runtime'],
      volatilityClass: 'version',
    });
    expect(text).toContain('Also asked as: newest nodejs | node version');
    expect(text).toContain('Tags: node, runtime');
    expect(text).toContain('Kind: version');
  });

  it('omits empty alias/tag lines and collapses whitespace', () => {
    const text = buildEmbeddingText({ topic: '  a  b ', question: 'q', value: 'v', aliases: ['', '  '] });
    expect(text).toContain('Topic: a b');
    expect(text).not.toContain('Also asked as');
    expect(text).not.toContain('Tags:');
  });

  it('embeddingTextFromDraft mirrors buildEmbeddingText', () => {
    const draft = { topic: 't', question: 'q', value: 'v', volatilityClass: 'price' as const, aliases: ['x'] };
    expect(embeddingTextFromDraft(draft)).toBe(
      buildEmbeddingText({ topic: 't', question: 'q', value: 'v', volatilityClass: 'price', aliases: ['x'] })
    );
  });
});
