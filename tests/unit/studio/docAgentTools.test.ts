/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Studio document-agent tool layer: action parsing, JSON
 * extraction from model replies, and the tool dispatcher's guardrails.
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the renderer-bound connector so runTool can be exercised in node.
vi.mock('@renderer/pages/editor/adapters/onlyOfficeConnector', () => ({
  readText: vi.fn(async () => 'hello world'),
  replaceAllText: vi.fn(async () => undefined),
  searchReplace: vi.fn(async () => undefined),
  insertText: vi.fn(async () => undefined),
  appendText: vi.fn(async () => undefined),
}));

import { extractActionJson, parseAction, runTool } from '@/renderer/pages/studio/docAgentTools';

describe('parseAction', () => {
  it('accepts each valid tool shape', () => {
    expect(parseAction({ tool: 'read_document' })).toEqual({ tool: 'read_document' });
    expect(parseAction({ tool: 'replace_all', text: 'x' })).toEqual({ tool: 'replace_all', text: 'x' });
    expect(parseAction({ tool: 'search_replace', search: 'a', replace: 'b' })).toEqual({
      tool: 'search_replace',
      search: 'a',
      replace: 'b',
    });
    expect(parseAction({ tool: 'insert_text', text: 't' })).toEqual({ tool: 'insert_text', text: 't' });
    expect(parseAction({ tool: 'append_text', text: 't' })).toEqual({ tool: 'append_text', text: 't' });
    expect(parseAction({ tool: 'finish', summary: 's' })).toEqual({ tool: 'finish', summary: 's' });
  });

  it('rejects malformed or unknown actions', () => {
    expect(parseAction(null)).toBeNull();
    expect(parseAction({})).toBeNull();
    expect(parseAction({ tool: 'replace_all' })).toBeNull(); // missing text
    expect(parseAction({ tool: 'search_replace', search: 'a' })).toBeNull(); // missing replace
    expect(parseAction({ tool: 'nope' })).toBeNull();
  });

  it('defaults finish summary to empty string when absent', () => {
    expect(parseAction({ tool: 'finish' })).toEqual({ tool: 'finish', summary: '' });
  });
});

describe('extractActionJson', () => {
  it('extracts a bare JSON object', () => {
    expect(extractActionJson('{"tool":"read_document"}')).toEqual({ tool: 'read_document' });
  });

  it('extracts from a fenced ```json block', () => {
    const reply = 'Sure!\n```json\n{"tool":"insert_text","text":"hi"}\n```\n';
    expect(extractActionJson(reply)).toEqual({ tool: 'insert_text', text: 'hi' });
  });

  it('tolerates trailing prose after the object', () => {
    expect(extractActionJson('{"tool":"finish","summary":"ok"} done')).toEqual({ tool: 'finish', summary: 'ok' });
  });

  it('returns null when no JSON is present', () => {
    expect(extractActionJson('no json here')).toBeNull();
  });
});

describe('runTool', () => {
  it('finishes the loop on finish', async () => {
    const r = await runTool('/f.docx', 'word', { tool: 'finish', summary: 'all done' });
    expect(r.done).toBe(true);
    expect(r.observation).toBe('all done');
  });

  it('reads document text', async () => {
    const r = await runTool('/f.docx', 'word', { tool: 'read_document' });
    expect(r.done).toBe(false);
    expect(r.observation).toContain('hello world');
  });

  it('blocks tools not allowed for the document kind', async () => {
    // replace_all is Word-only; reject for a spreadsheet.
    const r = await runTool('/f.xlsx', 'cell', { tool: 'replace_all', text: 'x' });
    expect(r.done).toBe(false);
    expect(r.observation).toMatch(/not available/i);
  });

  it('runs an allowed write tool', async () => {
    const r = await runTool('/f.docx', 'word', { tool: 'append_text', text: 'p' });
    expect(r.done).toBe(false);
    expect(r.observation).toMatch(/appended/i);
  });
});
