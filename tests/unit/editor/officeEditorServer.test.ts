/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Office-editor MCP server — drives the tools through an in-memory
 * MCP client over the SDK's linked in-process transport, against a fake
 * editor-tools invoker (no live ONLYOFFICE editor needed).
 */

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createOfficeEditorServer,
  type OfficeEditorServerDeps,
} from '@/process/resources/builtinMcp/officeEditorServer';
import type { EditorToolAction, EditorToolRunResult } from '@/process/editor/editorToolsBridge';

const makeDeps = (overrides: Partial<OfficeEditorServerDeps> = {}): OfficeEditorServerDeps => ({
  runTool: vi.fn(
    async (_filePath: string, _action: EditorToolAction): Promise<EditorToolRunResult> => ({
      ok: true,
      observation: 'done',
      kind: 'word',
    })
  ),
  ...overrides,
});

/** Connect a client to the server over a linked in-memory transport pair. */
const connect = async (deps: OfficeEditorServerDeps) => {
  const server = createOfficeEditorServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

/** Pull the text out of an MCP tool result. */
const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
};

describe('officeEditorServer', () => {
  it('exposes the expected office_* tool set', async () => {
    const client = await connect(makeDeps());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).toSorted();
    expect(names).toEqual([
      'office_append_text',
      'office_apply_headings',
      'office_format_passage',
      'office_format_text',
      'office_insert_table',
      'office_insert_text',
      'office_insert_toc',
      'office_read_document',
      'office_replace_all',
      'office_replace_passage',
      'office_run_api',
      'office_search_replace',
      'office_set_cells',
    ]);
  });

  it('read_document forwards a read_document action with the file path', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: 'office_read_document', arguments: { filePath: '/tmp/a.docx' } });
    expect(deps.runTool).toHaveBeenCalledWith('/tmp/a.docx', { tool: 'read_document' });
    expect(textOf(result)).toBe('done');
  });

  it('search_replace forwards search + replace', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    await client.callTool({
      name: 'office_search_replace',
      arguments: { filePath: '/tmp/a.docx', search: 'foo', replace: 'bar' },
    });
    expect(deps.runTool).toHaveBeenCalledWith('/tmp/a.docx', { tool: 'search_replace', search: 'foo', replace: 'bar' });
  });

  it('apply_headings coerces the headings to { text, level }', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    await client.callTool({
      name: 'office_apply_headings',
      arguments: { filePath: '/tmp/a.docx', headings: [{ text: 'Intro', level: 1 }] },
    });
    expect(deps.runTool).toHaveBeenCalledWith('/tmp/a.docx', {
      tool: 'apply_headings',
      headings: [{ text: 'Intro', level: 1 }],
    });
  });

  it('set_cells forwards the start ref + 2D values', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    await client.callTool({
      name: 'office_set_cells',
      arguments: { filePath: '/tmp/a.xlsx', start: 'A1', values: [['x', 1]] },
    });
    expect(deps.runTool).toHaveBeenCalledWith('/tmp/a.xlsx', { tool: 'set_cells', start: 'A1', values: [['x', 1]] });
  });

  it('surfaces a failure envelope as an MCP error result', async () => {
    const deps = makeDeps({
      runTool: vi.fn(
        async (): Promise<EditorToolRunResult> => ({ ok: false, reason: 'not-ready', error: 'editor not open' })
      ),
    });
    const client = await connect(deps);
    const result = await client.callTool({ name: 'office_read_document', arguments: { filePath: '/tmp/a.docx' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('editor not open');
  });
});
