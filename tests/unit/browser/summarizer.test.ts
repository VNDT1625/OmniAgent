/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/browser/research/summarizer — the map-reduce summariser
 * that prevents long pages/transcripts from being truncated. The chat is a
 * scripted stub, so these tests assert routing (single-chunk vs map-reduce),
 * chunk boundaries, the empty-input short-circuit, and that focus/language make
 * it into the prompt.
 */

import { describe, expect, it, vi } from 'vitest';
import { chunkText, createSummarizer, type SummarizerChat } from '@/process/browser/research/summarizer';

/** A chat stub recording every call, returning a fixed reply (or per-call replies). */
const stubChat = (
  reply: string | string[]
): { chat: SummarizerChat; calls: Array<{ system: string; user: string }> } => {
  const calls: Array<{ system: string; user: string }> = [];
  let i = 0;
  const chat: SummarizerChat = async ({ messages }) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const user = messages.find((m) => m.role === 'user')?.content ?? '';
    calls.push({ system, user });
    const out = Array.isArray(reply) ? (reply[Math.min(i, reply.length - 1)] ?? '') : reply;
    i += 1;
    return out;
  };
  return { chat, calls };
};

describe('chunkText', () => {
  it('returns [] for empty input', () => {
    expect(chunkText('', 100)).toEqual([]);
  });

  it('returns a single chunk when the text fits', () => {
    expect(chunkText('short', 100)).toEqual(['short']);
  });

  it('splits long text at paragraph boundaries and stays within size', () => {
    const text = ['a'.repeat(50), 'b'.repeat(50), 'c'.repeat(50)].join('\n\n');
    const chunks = chunkText(text, 60);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60);
    // Reassembling preserves the content.
    expect(chunks.join('')).toBe(text);
  });

  it('hard-cuts when no boundary exists within the window', () => {
    const text = 'x'.repeat(250);
    const chunks = chunkText(text, 100);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(100);
  });
});

describe('createSummarizer', () => {
  it('short-circuits empty input without calling chat', async () => {
    const { chat, calls } = stubChat('unused');
    const summarizer = createSummarizer({ chat });
    const result = await summarizer.summarize('   ', { model: 'm' });
    expect(result).toEqual({ summary: '', chunks: 0 });
    expect(calls).toHaveLength(0);
  });

  it('summarizes short text in a single map call', async () => {
    const { chat, calls } = stubChat('TL;DR: short.\n- point');
    const summarizer = createSummarizer({ chat });
    const result = await summarizer.summarize('a short paragraph', { model: 'm' });
    expect(result.chunks).toBe(1);
    expect(result.summary).toContain('TL;DR');
    expect(calls).toHaveLength(1);
  });

  it('runs map-reduce for long text: one call per chunk plus a reduce', async () => {
    const { chat, calls } = stubChat('digest');
    const summarizer = createSummarizer({ chat, chunkChars: 50 });
    const text = Array.from({ length: 4 }, (_, i) => `${String(i)}`.repeat(50)).join('\n\n');
    const result = await summarizer.summarize(text, { model: 'm' });
    expect(result.chunks).toBeGreaterThan(1);
    // calls = one per chunk (map) + one final (reduce).
    expect(calls.length).toBe(result.chunks + 1);
  });

  it('passes focus and language into the prompt', async () => {
    const { chat, calls } = stubChat('TL;DR: x');
    const summarizer = createSummarizer({ chat });
    await summarizer.summarize('some content', { model: 'm', focus: 'pricing', language: 'vi' });
    const system = calls[0].system;
    expect(system).toContain('pricing');
    expect(system).toContain('vi');
  });
});
