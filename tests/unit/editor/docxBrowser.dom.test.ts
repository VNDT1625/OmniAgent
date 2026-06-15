/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Repro test: decode a base64 .docx with the EXACT renderer path
 * (atob + mammoth.browser) to reproduce the "Can't find end of central
 * directory" JSZip error and verify the fix.
 */

import { describe, expect, it } from 'vitest';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { docxToText } from '@/renderer/pages/editor/adapters/docxCodec';

describe('docx browser decode (repro)', () => {
  it('decodes a real .docx built by docx lib via the renderer path', async () => {
    const doc = new Document({
      sections: [{ children: [new Paragraph({ children: [new TextRun('Hello browser docx')] })] }],
    });
    const base64 = await Packer.toBase64String(doc);
    const text = await docxToText(base64);
    expect(text).toContain('Hello browser docx');
  });
});
