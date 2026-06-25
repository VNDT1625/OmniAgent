/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the built-in IDE MCP server — drives the `ide_*` tools through an
 * in-memory MCP client over the SDK's linked in-process transport, against a
 * fake {@link IdeMcpService} (no real filesystem walk needed).
 */

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createIdeServer, type IdeMcpService, type IdeServerDeps } from '@/process/ide/mcp/ideServer';
import { createSessionMemoryStore } from '@/process/ide/memory/sessionMemoryStore';

const makeService = (overrides: Partial<IdeMcpService> = {}): IdeMcpService => ({
  listDir: vi.fn(async () => [
    { name: 'src', fullPath: '/repo/src', isDir: true },
    { name: 'readme.md', fullPath: '/repo/readme.md', isDir: false },
  ]),
  readFile: vi.fn(async () => 'file contents'),
  scanRepo: vi.fn(async () => ({
    fileCount: 3,
    edgeCount: 2,
    topGroups: [{ group: 'src', files: 3 }],
    truncated: false,
  })),
  search: vi.fn(async () => [{ file: 'src/a.ts', line: 10, text: 'const x = 1' }]),
  findDefinition: vi.fn(async () => [{ file: 'src/a.ts', line: 1, column: 7, text: 'export const x = 1' }]),
  findReferences: vi.fn(async () => [{ file: 'src/b.ts', line: 5, column: 3, text: 'use x here' }]),
  ...overrides,
});

const makeDeps = (overrides: Partial<IdeMcpService> = {}): IdeServerDeps => ({ ide: makeService(overrides) });

/** Connect a client to the server over a linked in-memory transport pair. */
const connect = async (deps: IdeServerDeps) => {
  const server = createIdeServer(deps);
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

describe('ideServer', () => {
  it('exposes the expected ide_* tool set', async () => {
    const client = await connect(makeDeps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      'ide_find_definition',
      'ide_find_references',
      'ide_list_dir',
      'ide_read_file',
      'ide_scan_repo',
      'ide_search',
    ]);
  });

  it('exposes ide_quick_test when a Quick Test runner is injected', async () => {
    const runSession = vi.fn(async () => ({
      trace: { platform: 'web', events: [], firstError: null, startedAt: 0, stoppedAt: 1000 },
      contextPack: { slices: [{ path: 'src/a.ts', layer: 'ui' }], renderedContext: '## trace' },
    }));
    const client = await connect({ ide: makeService(), quickTest: { runSession } });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('ide_quick_test');

    const result = await client.callTool({
      name: 'ide_quick_test',
      arguments: { platform: 'web', rootPath: '/repo', durationMs: 1000 },
    });
    expect(runSession).toHaveBeenCalledWith({ platform: 'web', rootPath: '/repo', target: undefined, durationMs: 1000 });
    expect(textOf(result)).toContain('src/a.ts');
    expect(textOf(result)).toContain('"eventCount": 0');
  });

  it('ide_list_dir renders dirs and files', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: 'ide_list_dir', arguments: { dir: '/repo' } });
    expect(deps.ide.listDir).toHaveBeenCalledWith('/repo');
    expect(textOf(result)).toContain('[dir] src');
    expect(textOf(result)).toContain('readme.md');
  });

  it('ide_read_file forwards the path + optional maxBytes', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'ide_read_file',
      arguments: { filePath: '/repo/a.ts', maxBytes: 100 },
    });
    expect(deps.ide.readFile).toHaveBeenCalledWith('/repo/a.ts', 100);
    expect(textOf(result)).toBe('file contents');
  });

  it('exposes db_* tools when a Database accessor is injected and describes a table fully', async () => {
    const db = {
      listConnections: vi.fn(async () => [{ config: { id: 'c1', name: 'Dev', kind: 'postgres', readOnly: true } }]),
      connect: vi.fn(async () => undefined),
      listTables: vi.fn(async () => [{ schema: 'public', name: 'users', type: 'table' }]),
      getColumns: vi.fn(async () => []),
      getTableDetail: vi.fn(async () => ({
        columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
        indexes: [{ name: 'users_pkey', columns: ['id'], unique: true, primary: true }],
        foreignKeys: [{ name: 'fk_org', columns: ['org_id'], referencedTable: 'orgs', referencedColumns: ['id'] }],
      })),
      query: vi.fn(async () => ({ columns: ['id'], rows: [[1]], durationMs: 2, truncated: false })),
    };
    const client = await connect({ ide: makeService(), db });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['db_list_connections', 'db_list_tables', 'db_describe_table', 'db_query']));

    const described = await client.callTool({ name: 'db_describe_table', arguments: { id: 'c1', table: 'users' } });
    expect(db.connect).toHaveBeenCalledWith('c1');
    const text = textOf(described);
    expect(text).toContain('## Columns');
    expect(text).toContain('id integer NOT NULL PK');
    expect(text).toContain('## Indexes');
    expect(text).toContain('users_pkey (id) UNIQUE PRIMARY');
    expect(text).toContain('## Foreign keys');
    expect(text).toContain('org_id -> orgs(id)');

    const queried = await client.callTool({ name: 'db_query', arguments: { id: 'c1', sql: 'SELECT 1' } });
    expect(textOf(queried)).toContain('"rowCount": 1');
  });

  it('ide_search forwards options and renders file:line hits', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'ide_search',
      arguments: { rootPath: '/repo', query: 'x', regex: true, maxResults: 50 },
    });
    expect(deps.ide.search).toHaveBeenCalledWith('/repo', 'x', {
      regex: true,
      wholeWord: undefined,
      caseSensitive: undefined,
      maxResults: 50,
    });
    expect(textOf(result)).toContain('src/a.ts:10: const x = 1');
  });

  it('ide_find_definition / ide_find_references render symbol hits', async () => {
    const client = await connect(makeDeps());
    const def = await client.callTool({ name: 'ide_find_definition', arguments: { rootPath: '/repo', name: 'x' } });
    expect(textOf(def)).toContain('src/a.ts:1:7');
    const refs = await client.callTool({ name: 'ide_find_references', arguments: { rootPath: '/repo', name: 'x' } });
    expect(textOf(refs)).toContain('src/b.ts:5:3');
  });

  it('ide_scan_repo renders a compact summary', async () => {
    const client = await connect(makeDeps());
    const result = await client.callTool({ name: 'ide_scan_repo', arguments: { rootPath: '/repo' } });
    expect(textOf(result)).toContain('Files: 3');
    expect(textOf(result)).toContain('Import edges: 2');
    expect(textOf(result)).toContain('src: 3 file(s)');
  });

  it('surfaces a service error as an MCP error result', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => {
        throw new Error('ENOENT: no such file');
      }),
    });
    const client = await connect(deps);
    const result = await client.callTool({ name: 'ide_read_file', arguments: { filePath: '/nope' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('ENOENT');
  });
});

describe('ideServer — ide_memory_* (session super-memory)', () => {
  it('exposes the memory tools only when a memory store is injected', async () => {
    const without = await connect(makeDeps());
    expect((await without.listTools()).tools.map((t) => t.name)).not.toContain('ide_memory_remember');

    const memory = createSessionMemoryStore({ summarizer: async () => 'summary' });
    const withMem = await connect({ ide: makeService(), memory });
    const names = (await withMem.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'ide_memory_remember',
        'ide_memory_recall',
        'ide_memory_forget',
        'ide_memory_set_secret',
        'ide_memory_status',
      ])
    );
  });

  it('remembers then recalls a note for the same sessionId', async () => {
    const memory = createSessionMemoryStore({ summarizer: async () => 'summary' });
    const client = await connect({ ide: makeService(), memory });

    const saved = await client.callTool({
      name: 'ide_memory_remember',
      arguments: { sessionId: 's1', text: 'Auth lives in src/auth.ts', kind: 'fact' },
    });
    expect(textOf(saved)).toContain('Saved note');

    const recall = await client.callTool({ name: 'ide_memory_recall', arguments: { sessionId: 's1' } });
    expect(textOf(recall)).toContain('Auth lives in src/auth.ts');
  });

  it('stores a session secret without leaking its value in status', async () => {
    const memory = createSessionMemoryStore({ summarizer: async () => 'summary' });
    const client = await connect({ ide: makeService(), memory });

    await client.callTool({
      name: 'ide_memory_set_secret',
      arguments: { sessionId: 's1', key: 'OPENAI_API_KEY', value: 'sk-secret-123' },
    });
    const status = await client.callTool({ name: 'ide_memory_status', arguments: { sessionId: 's1' } });
    const text = textOf(status);
    expect(text).toContain('OPENAI_API_KEY');
    expect(text).not.toContain('sk-secret-123');
  });

  it('forgets a note by id through the MCP tool', async () => {
    const memory = createSessionMemoryStore({ summarizer: async () => 'summary' });
    const client = await connect({ ide: makeService(), memory });
    const saved = await client.callTool({ name: 'ide_memory_remember', arguments: { sessionId: 's1', text: 'temp' } });
    const id = textOf(saved).match(/Saved note (\w+)/)?.[1];
    expect(id).toBeTruthy();
    const forgotten = await client.callTool({ name: 'ide_memory_forget', arguments: { sessionId: 's1', id } });
    expect(textOf(forgotten)).toContain(`Forgot note ${id}`);
    const recall = await client.callTool({ name: 'ide_memory_recall', arguments: { sessionId: 's1' } });
    expect(textOf(recall)).toContain('Session memory is empty');
  });

  it('reports a merged duplicate write through the MCP tool', async () => {
    const memory = createSessionMemoryStore({ summarizer: async () => 'summary' });
    const client = await connect({ ide: makeService(), memory });
    await client.callTool({ name: 'ide_memory_remember', arguments: { sessionId: 's1', text: 'cache uses redis' } });
    const dup = await client.callTool({
      name: 'ide_memory_remember',
      arguments: { sessionId: 's1', text: 'cache uses redis with a 60s ttl' },
    });
    expect(textOf(dup)).toContain('Merged into an existing');
  });
});
