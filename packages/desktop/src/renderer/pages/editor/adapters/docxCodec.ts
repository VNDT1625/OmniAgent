/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `docxCodec` — read/write helpers for the editable Word adapter (Yêu cầu 2a,
 * criterion 2.2 "sửa nội dung … rồi lưu").
 *
 * - {@link docxToText} decodes a base64 `.docx` ZIP and extracts its plain text
 *   with `mammoth` (browser build), splitting into paragraphs.
 * - {@link textToDocxBase64} rebuilds a clean `.docx` from edited paragraphs with
 *   the `docx` library and returns base64 bytes ready for the binary writer.
 *
 * This edits the document's TEXT content; rich formatting (styles, tables,
 * images) from the source is not round-tripped — matching the spec's "basic
 * content editing" scope. Renderer-only (both libs ship browser builds).
 */

import { Document, Packer, Paragraph, TextRun } from 'docx';
import mammoth from 'mammoth/mammoth.browser';

/** Decode a base64 string (optionally a data URL) into an ArrayBuffer. */
const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const clean = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

/**
 * Extract the editable plain text of a `.docx` (base64) document.
 *
 * Resilient: a real `.docx` is parsed with `mammoth`. If the bytes are not a
 * valid ZIP (e.g. the file was corrupted by an earlier bad save, or is actually
 * plain text mis-named `.docx`), it falls back to decoding the bytes as UTF-8
 * text so the file still opens — and a subsequent save rebuilds a proper `.docx`,
 * repairing it. Never throws for content reasons.
 *
 * @param base64 - The base64-encoded file bytes.
 * @returns The document text (paragraphs separated by `\n`).
 */
export const docxToText = async (base64: string): Promise<string> => {
  if (!base64) return '';
  const arrayBuffer = base64ToArrayBuffer(base64);
  // A valid .docx (ZIP) starts with the local-file-header magic "PK\x03\x04".
  const head = new Uint8Array(arrayBuffer.slice(0, 4));
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (isZip) {
    try {
      const result = await mammoth.extractRawText({ arrayBuffer });
      return result.value.replace(/\r\n/g, '\n');
    } catch {
      // Fall through to the text fallback below.
    }
  }
  // Not a ZIP (or mammoth failed): decode the raw bytes as UTF-8 text so the
  // file is still openable and can be re-saved as a clean .docx.
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(arrayBuffer).replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
};

/**
 * Build a clean `.docx` from edited text and return it as base64 bytes.
 *
 * Each line becomes one paragraph. Empty lines are preserved as blank
 * paragraphs so spacing survives a round-trip.
 *
 * @param text - The edited document text.
 * @returns Base64-encoded `.docx` bytes (no data-URL prefix).
 */
export const textToDocxBase64 = async (text: string): Promise<string> => {
  const lines = text.split('\n');
  const paragraphs = lines.map((line) => new Paragraph({ children: [new TextRun(line)] }));
  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs.length > 0 ? paragraphs : [new Paragraph({})] }],
  });
  return Packer.toBase64String(doc);
};
