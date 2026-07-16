/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for file → Markdown extraction (markitdown via uvx → Node
 * fallbacks). All collaborators are injected so no uvx/Python is required.
 */

import { describe, expect, it, vi } from 'vitest';
import { createFileToMarkdown } from '@/process/services/contentExtract/fileToMarkdown';

describe('createFileToMarkdown', () => {
  it('uses markitdown (uvx) when available and returns its Markdown', async () => {
    const spawn = vi.fn(async () => ({ code: 0, stdout: '# Title\n\nBody text', stderr: '' }));
    const conv = createFileToMarkdown({ resolveUvx: () => Promise.resolve('/usr/bin/uvx'), spawn });
    const out = await conv.toMarkdown('/docs/report.pdf');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.via).toBe('markitdown');
      expect(out.text).toContain('# Title');
      expect(out.title).toBe('report.pdf');
    }
    expect(spawn).toHaveBeenCalledWith('/usr/bin/uvx', ['markitdown', '/docs/report.pdf'], expect.any(Object));
  });

  it('falls back to mammoth for .docx when uvx is absent', async () => {
    const readDocxMarkdown = vi.fn(async () => '# Heading\n\nFrom mammoth');
    const conv = createFileToMarkdown({
      resolveUvx: () => Promise.resolve(null),
      readDocxMarkdown,
    });
    const out = await conv.toMarkdown('/docs/file.docx');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.via).toBe('node-mammoth');
      expect(out.text).toContain('From mammoth');
    }
    expect(readDocxMarkdown).toHaveBeenCalledWith('/docs/file.docx');
  });

  it('falls back to officeparser for a PDF when uvx is absent', async () => {
    const readOfficeText = vi.fn(async () => 'plain pdf text');
    const conv = createFileToMarkdown({
      resolveUvx: () => Promise.resolve(null),
      readOfficeText,
    });
    const out = await conv.toMarkdown('/docs/scan.pdf');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.via).toBe('node-officeparser');
      expect(out.text).toBe('plain pdf text');
    }
  });

  it('reads text-like files directly', async () => {
    const readTextFile = vi.fn(async () => 'key: value');
    const conv = createFileToMarkdown({ resolveUvx: () => Promise.resolve(null), readTextFile });
    const out = await conv.toMarkdown('/docs/config.yaml');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.via).toBe('node-text');
  });

  it('returns ok:false when every strategy yields nothing', async () => {
    const conv = createFileToMarkdown({
      resolveUvx: () => Promise.resolve(null),
      readOfficeText: vi.fn(async () => ''),
    });
    const out = await conv.toMarkdown('/docs/empty.pdf');
    expect(out.ok).toBe(false);
  });

  it('falls back to Node when markitdown exits non-zero', async () => {
    const spawn = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'boom' }));
    const readOfficeText = vi.fn(async () => 'recovered text');
    const conv = createFileToMarkdown({ resolveUvx: () => Promise.resolve('uvx'), spawn, readOfficeText });
    const out = await conv.toMarkdown('/docs/x.pptx');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.via).toBe('node-officeparser');
  });
});
