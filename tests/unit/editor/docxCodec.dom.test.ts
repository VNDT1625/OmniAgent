/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Round-trip test for the editable Word adapter codec (Requirement 2a,
 * criterion 2.2). Builds a .docx from text with `textToDocxBase64`, then reads
 * it back with `docxToText` and asserts the text content survives. This guards
 * the edit→save→reopen loop that the DocxAdapter relies on.
 *
 * Runs in the jsdom project (mammoth's browser build needs DOM globals).
 */

import { describe, expect, it } from 'vitest';
import { docxToText, textToDocxBase64 } from '@/renderer/pages/editor/adapters/docxCodec';

describe('docxCodec round-trip (Requirement 2a, criterion 2.2)', () => {
  it('preserves multi-paragraph text through build → read', async () => {
    const text = ['Báo Cáo Tổng Kết', '', 'Nội dung đoạn một.', 'Đoạn hai với nội dung khác.'].join('\n');
    const base64 = await textToDocxBase64(text);
    expect(typeof base64).toBe('string');
    expect(base64.length).toBeGreaterThan(0);

    const roundTripped = await docxToText(base64);
    // Non-empty lines must all survive (blank-line fidelity varies by writer).
    for (const line of text.split('\n').filter((l) => l.trim() !== '')) {
      expect(roundTripped).toContain(line);
    }
  });

  it('produces a real .docx ZIP (PK header) so binary save is correct', async () => {
    const base64 = await textToDocxBase64('hello world');
    // Decode the first bytes and check the ZIP local-file-header magic "PK\x03\x04".
    const binary = atob(base64);
    expect(binary.charCodeAt(0)).toBe(0x50); // P
    expect(binary.charCodeAt(1)).toBe(0x4b); // K
    expect(binary.charCodeAt(2)).toBe(0x03);
    expect(binary.charCodeAt(3)).toBe(0x04);
  });

  it('returns empty string for empty input (never throws)', async () => {
    await expect(docxToText('')).resolves.toBe('');
  });

  it('falls back to plain text when the bytes are not a valid ZIP (corrupted .docx)', async () => {
    // Simulate a .docx that was corrupted by an earlier bad save: it holds
    // plain text instead of ZIP bytes. Must open (not throw the JSZip error).
    const notAZip = btoa('this is not a zip, just text that was wrongly saved');
    const text = await docxToText(notAZip);
    expect(text).toContain('not a zip');
  });
});
