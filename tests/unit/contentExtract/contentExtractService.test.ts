/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the content-extraction facade: routing + the tiered YouTube
 * pipeline (yt-dlp primary → anonymous fallback) + auto source sniffing.
 */

import { describe, expect, it, vi } from 'vitest';
import { createContentExtractService } from '@/process/services/contentExtract/contentExtractService';
import type { ExtractOutcome } from '@/process/services/contentExtract/contentExtractTypes';

const okTranscript = (text: string, via: 'ytdlp' | 'yt-anonymous'): ExtractOutcome => ({ ok: true, text, via });
const fail = (reason: string): ExtractOutcome => ({ ok: false, reason });

describe('createContentExtractService — youtube tiering', () => {
  it('returns the yt-dlp result when the primary succeeds (no fallback call)', async () => {
    const ytFallback = { fetchTranscript: vi.fn(async () => okTranscript('fallback', 'yt-anonymous')) };
    const svc = createContentExtractService({
      ytDlp: { fetchTranscript: async () => okTranscript('primary transcript', 'ytdlp') },
      ytFallback,
    });
    const out = await svc.extract({ kind: 'youtube', urlOrId: 'vid' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.via).toBe('ytdlp');
    expect(ytFallback.fetchTranscript).not.toHaveBeenCalled();
  });

  it('falls back to the anonymous fetcher when yt-dlp misses', async () => {
    const svc = createContentExtractService({
      ytDlp: { fetchTranscript: async () => fail('yt-dlp not installed') },
      ytFallback: { fetchTranscript: async () => okTranscript('anon transcript', 'yt-anonymous') },
    });
    const out = await svc.extract({ kind: 'youtube', urlOrId: 'vid' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.via).toBe('yt-anonymous');
  });

  it('joins both reasons when every tier fails', async () => {
    const svc = createContentExtractService({
      ytDlp: { fetchTranscript: async () => fail('ytdlp miss') },
      ytFallback: { fetchTranscript: async () => fail('anon miss') },
    });
    const out = await svc.extract({ kind: 'youtube', urlOrId: 'vid' });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain('ytdlp miss');
      expect(out.reason).toContain('anon miss');
    }
  });
});

describe('createContentExtractService — file + html + auto', () => {
  it('routes file sources to the file converter', async () => {
    const toMarkdown = vi.fn(async () => ({
      ok: true as const,
      text: '# md',
      via: 'markitdown' as const,
      title: 'a.pdf',
    }));
    const svc = createContentExtractService({ fileToMarkdown: { toMarkdown } });
    const out = await svc.extract({ kind: 'file', path: '/x/a.pdf' });
    expect(out.ok).toBe(true);
    expect(toMarkdown).toHaveBeenCalledWith('/x/a.pdf');
  });

  it('converts an HTML string to Markdown', async () => {
    const svc = createContentExtractService();
    const out = await svc.extract({ kind: 'html', html: '<h1>Hi</h1><p>Body</p>' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.via).toBe('node-turndown');
      expect(out.text).toContain('# Hi');
    }
  });

  it('auto-detects a YouTube URL', async () => {
    const ytDlp = { fetchTranscript: vi.fn(async () => okTranscript('t', 'ytdlp')) };
    const svc = createContentExtractService({ ytDlp });
    const out = await svc.extract({ kind: 'auto', input: 'https://youtu.be/abcdefghijk' });
    expect(out.ok).toBe(true);
    expect(ytDlp.fetchTranscript).toHaveBeenCalled();
  });

  it('auto-detects a file path', async () => {
    const toMarkdown = vi.fn(async () => ({ ok: true as const, text: 'x', via: 'node-text' as const }));
    const svc = createContentExtractService({ fileToMarkdown: { toMarkdown } });
    const out = await svc.extract({ kind: 'auto', input: '/home/user/notes.md' });
    expect(out.ok).toBe(true);
    expect(toMarkdown).toHaveBeenCalledWith('/home/user/notes.md');
  });

  it('auto-detects raw HTML', async () => {
    const svc = createContentExtractService();
    const out = await svc.extract({ kind: 'auto', input: '<article><h2>T</h2></article>' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text).toContain('## T');
  });

  it('returns ok:false for unclassifiable auto input', async () => {
    const svc = createContentExtractService();
    const out = await svc.extract({ kind: 'auto', input: 'just some words' });
    expect(out.ok).toBe(false);
  });
});
