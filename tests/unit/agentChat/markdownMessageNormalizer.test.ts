/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { normalizeChatMessagesForMarkdown } from '@process/services/agentChat';
import type { ExtractOutcome } from '@process/services/contentExtract';

describe('normalizeChatMessagesForMarkdown', () => {
  it('appends Markdown extracted from referenced local files', async () => {
    const extract = vi.fn(
      async (): Promise<ExtractOutcome> => ({
        ok: true,
        text: '# Report\n\nImportant table',
        via: 'markitdown',
        title: 'report.docx',
      })
    );

    const messages = await normalizeChatMessagesForMarkdown(
      [{ role: 'user', content: 'Summarize C:\\Users\\Me\\Documents\\report.docx for me.' }],
      {
        extract: { extract },
        stat: async () => ({ isFile: () => true }),
      }
    );

    expect(extract).toHaveBeenCalledWith({ kind: 'file', path: 'C:\\Users\\Me\\Documents\\report.docx' });
    expect(messages[0].content).toContain('## AionUi extracted file context');
    expect(messages[0].content).toContain('# Report');
    expect(messages[0].content).toContain('via: markitdown');
  });

  it('converts long HTML text parts to Markdown before model delivery', async () => {
    const html = `<html><body><article><h1>Title</h1><p>${'body '.repeat(3000)}</p></article></body></html>`;
    const extract = vi.fn(
      async (): Promise<ExtractOutcome> => ({
        ok: true,
        text: '# Title\n\nbody body body',
        via: 'node-turndown',
        title: 'Long HTML content',
      })
    );

    const messages = await normalizeChatMessagesForMarkdown(
      [
        {
          role: 'user',
          content: [{ type: 'text', text: html }],
        },
      ],
      {
        extract: { extract },
        stat: async () => ({ isFile: () => false }),
        longTextThreshold: 1000,
      }
    );

    const content = messages[0].content;
    expect(extract).toHaveBeenCalledWith({ kind: 'html', html, title: 'Long HTML content' });
    expect(Array.isArray(content)).toBe(true);
    expect(Array.isArray(content) ? content[0].text : '').toContain('## AionUi Markdown-normalized content');
    expect(Array.isArray(content) ? content[0].text : '').toContain('# Title');
  });
});
