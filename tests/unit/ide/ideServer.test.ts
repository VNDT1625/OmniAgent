/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
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
import {
  createIdeServer,
  type IdeMcpService,
  type IdeServerDeps,
  type QuickTestScenarioAgentService,
} from '@/process/ide/mcp/ideServer';
import { startIdeMcpHost } from '@/process/ide/mcp/ideMcpHost';
import { buildIdeServer } from '@/process/ide/mcp/ideMcpWiring';
import { createSessionMemoryStore } from '@/process/ide/memory/sessionMemoryStore';

const makeService = (overrides: Partial<IdeMcpService> = {}): IdeMcpService => ({
  listDir: vi.fn(async () => [
    { name: 'src', fullPath: '/repo/src', isDir: true },
    { name: 'readme.md', fullPath: '/repo/readme.md', isDir: false },
  ]),
  readFile: vi.fn(async () => ({
    text: 'file contents',
    lineStart: 1,
    lineEnd: 1,
    totalLines: 1,
    returnedLines: 1,
    truncated: false,
    binary: false,
    sizeBytes: 13,
  })),
  scanRepo: vi.fn(async () => ({
    fileCount: 3,
    edgeCount: 2,
    topGroups: [{ group: 'src', files: 3 }],
    truncated: false,
  })),
  search: vi.fn(async () => [{ file: 'src/a.ts', line: 10, text: 'const x = 1' }]),
  findDefinition: vi.fn(async () => [{ file: 'src/a.ts', line: 1, column: 7, text: 'export const x = 1' }]),
  findReferences: vi.fn(async () => [{ file: 'src/b.ts', line: 5, column: 3, text: 'use x here' }]),
  understand: vi.fn(async () => ({ summary: 'understand summary' })),
  compassRead: vi.fn(async () => ({ summary: 'compass slice' })),
  context: vi.fn(async () => ({ summary: 'context candidates' })),
  map: vi.fn(async () => ({ summary: 'map summary' })),
  analyze: vi.fn(async () => ({ summary: 'analyze summary' })),
  analyzeImage: vi.fn(async () => ({
    json: { schemaVersion: 1, image: { width: 10, height: 20 } },
    semanticText: 'Image: 10x20',
    mockUi: '[image]\n[/image]',
  })),
  compact: vi.fn(async () => ({ summary: 'compacted log' })),
  runCommand: vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 5 })),
  ...overrides,
});

describe('IDE MCP SSE host failures', () => {
  it('returns an HTTP error instead of leaving the handshake open when server construction fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = await startIdeMcpHost({
      buildServer: () => {
        throw new Error('server build failed');
      },
    });

    try {
      const response = await fetch(host.url);
      expect(response.status).toBe(500);
    } finally {
      await host.close();
      consoleSpy.mockRestore();
    }
  });
  it('does not return HTTP 500 when the production IDE server completes an SSE handshake', async () => {
    const host = await startIdeMcpHost({ buildServer: buildIdeServer });
    const abort = new AbortController();

    try {
      const response = await fetch(host.url, { signal: abort.signal });
      expect(response.status).toBe(200);
    } finally {
      abort.abort();
      await host.close();
    }
  });
});

const makeDeps = (overrides: Partial<IdeMcpService> = {}): IdeServerDeps => ({ ide: makeService(overrides) });

const makeQuickTestScenarios = (): QuickTestScenarioAgentService => ({
  list: vi.fn(async () => ({
    scenarios: [{ id: 'scenario-1', name: 'Login', platform: 'web', stepCount: 2, createdAt: 100 }],
    total: 1,
  })),
  describe: vi.fn(async () => ({
    id: 'scenario-1',
    name: 'Login',
    platform: 'web',
    stepCount: 2,
    createdAt: 100,
    rootPath: '/repo',
    steps: [{ id: 'step-1', kind: 'navigate', url: 'http://localhost:3000' }],
  })),
  run: vi.fn(async () => ({
    runId: 'run-1',
    scenarioId: 'scenario-1',
    status: 'queued',
    queuedAt: 200,
  })),
  status: vi.fn(async () => ({
    runId: 'run-1',
    scenarioId: 'scenario-1',
    status: 'passed',
    queuedAt: 200,
    finishedAt: 300,
  })),
  cancel: vi.fn(async () => ({
    runId: 'run-1',
    scenarioId: 'scenario-1',
    status: 'cancelled',
    queuedAt: 200,
    finishedAt: 250,
  })),
  compare: vi.fn(async () => ({ baselineRunId: 'run-bad', currentRunId: 'run-fixed', newErrors: [] })),
});

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
    expect(
      tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('ide_'))
        .toSorted()
    ).toEqual([
      'ide_analyze',
      'ide_analyze_image',
      'ide_command',
      'ide_compact',
      'ide_compass',
      'ide_context',
      'ide_find_definition',
      'ide_find_references',
      'ide_glob',
      'ide_grep',
      'ide_info',
      'ide_list_dir',
      'ide_map',
      'ide_read_file',
      'ide_scan_repo',
      'ide_search',
      'ide_summary',
    ]);
  });

  it('exposes the neutral tomny_* tool layer and routes aliases to IDE services', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const names = (await client.listTools()).tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith('tomny_'))
      .toSorted();

    expect(names).toEqual([
      'tomny_analyze',
      'tomny_analyze_image',
      'tomny_command',
      'tomny_compact',
      'tomny_context',
      'tomny_glob',
      'tomny_map',
      'tomny_read',
      'tomny_search',
      'tomny_visual_analyze',
    ]);

    const read = await client.callTool({
      name: 'tomny_read',
      arguments: { filePath: '/repo/src/a.ts', all: null, maxLines: 20 },
    });
    expect(deps.ide.readFile).toHaveBeenCalledWith('/repo/src/a.ts', {
      all: undefined,
      from: undefined,
      to: undefined,
      maxLines: 20,
      maxBytes: undefined,
      lineNumbers: undefined,
    });
    expect(textOf(read)).toContain('file contents');
  });

  it('returns a clear tool error when a required Tomny argument is null', async () => {
    const client = await connect(makeDeps());
    const result = await client.callTool({ name: 'tomny_read', arguments: { filePath: null } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('filePath is required');
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
    expect(runSession).toHaveBeenCalledWith({
      platform: 'web',
      rootPath: '/repo',
      target: undefined,
      durationMs: 1000,
    });
    expect(textOf(result)).toContain('src/a.ts');
    expect(textOf(result)).toContain('"eventCount": 0');
  });

  it('exposes all saved Quick Test scenario tools only when their service is injected', async () => {
    const client = await connect({ ide: makeService(), quickTestScenarios: makeQuickTestScenarios() });
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'ide_quick_test_list',
        'ide_quick_test_describe',
        'ide_quick_test_run',
        'ide_quick_test_status',
        'ide_quick_test_cancel',
        'ide_quick_test_compare',
      ])
    );
  });

  it('starts a saved scenario with bounded defaults and ephemeral input overrides', async () => {
    const quickTestScenarios = makeQuickTestScenarios();
    const client = await connect({ ide: makeService(), quickTestScenarios });
    const result = await client.callTool({
      name: 'ide_quick_test_run',
      arguments: {
        rootPath: '/repo',
        scenarioId: 'scenario-1',
        inputOverrides: { 'step-password': 'secret-from-memory' },
      },
    });

    expect(quickTestScenarios.run).toHaveBeenCalledWith({
      rootPath: '/repo',
      scenarioId: 'scenario-1',
      tabId: undefined,
      mode: { kind: 'full' },
      timeoutMs: 120_000,
      inputOverrides: { 'step-password': 'secret-from-memory' },
    });
    expect(JSON.parse(textOf(result))).toMatchObject({ ok: true, data: { status: 'queued' } });
    expect(textOf(result)).not.toContain('secret-from-memory');
  });

  it('routes saved-scenario status, cancellation and comparison by run id', async () => {
    const quickTestScenarios = makeQuickTestScenarios();
    const client = await connect({ ide: makeService(), quickTestScenarios });

    await client.callTool({ name: 'ide_quick_test_status', arguments: { rootPath: '/repo', runId: 'run-1' } });
    await client.callTool({ name: 'ide_quick_test_cancel', arguments: { rootPath: '/repo', runId: 'run-1' } });
    await client.callTool({
      name: 'ide_quick_test_compare',
      arguments: { rootPath: '/repo', baselineRunId: 'run-bad', currentRunId: 'run-fixed' },
    });

    expect(quickTestScenarios.status).toHaveBeenCalledWith({ rootPath: '/repo', runId: 'run-1' });
    expect(quickTestScenarios.cancel).toHaveBeenCalledWith({ rootPath: '/repo', runId: 'run-1' });
    expect(quickTestScenarios.compare).toHaveBeenCalledWith({
      rootPath: '/repo',
      baselineRunId: 'run-bad',
      currentRunId: 'run-fixed',
    });
  });

  it('returns a structured MCP error when saved-scenario execution fails', async () => {
    const quickTestScenarios = makeQuickTestScenarios();
    quickTestScenarios.describe = vi.fn(async () => {
      throw new Error('Scenario was not found.');
    });
    const client = await connect({ ide: makeService(), quickTestScenarios });
    const result = await client.callTool({
      name: 'ide_quick_test_describe',
      arguments: { rootPath: '/repo', scenarioId: 'missing' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      ok: false,
      error: { code: 'quick_test_error', message: 'Scenario was not found.' },
    });
  });

  it('does not execute a saved scenario when the external tool guard denies it', async () => {
    const quickTestScenarios = makeQuickTestScenarios();
    const toolGuard = vi.fn(() => ({ allow: false as const, reason: 'Quick Test execution is not allowed.' }));
    const client = await connect({ ide: makeService(), quickTestScenarios, toolGuard });
    const result = await client.callTool({
      name: 'ide_quick_test_run',
      arguments: { rootPath: '/repo', scenarioId: 'scenario-1', sessionId: 'session-1' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(toolGuard).toHaveBeenCalledWith('ide_quick_test_run', expect.objectContaining({ sessionId: 'session-1' }));
    expect(quickTestScenarios.run).not.toHaveBeenCalled();
  });

  it('rejects oversized saved-scenario input overrides before invoking the runner', async () => {
    const quickTestScenarios = makeQuickTestScenarios();
    const client = await connect({ ide: makeService(), quickTestScenarios });
    const inputOverrides = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`step-${index}`, 'value']));
    const result = await client.callTool({
      name: 'ide_quick_test_run',
      arguments: { rootPath: '/repo', scenarioId: 'scenario-1', inputOverrides },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(quickTestScenarios.run).not.toHaveBeenCalled();
  });

  it('ide_list_dir renders dirs and files', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: 'ide_list_dir', arguments: { dir: '/repo' } });
    expect(deps.ide.listDir).toHaveBeenCalledWith('/repo', {
      glob: undefined,
      maxResults: undefined,
      recursive: undefined,
    });
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
    expect(deps.ide.readFile).toHaveBeenCalledWith('/repo/a.ts', expect.objectContaining({ maxBytes: 100 }));
    expect(textOf(result)).toContain('file contents');
  });

  it('ide_analyze_image runs only when the agent explicitly calls the VisualArtifact tool', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'ide_analyze_image',
      arguments: { filePath: '/repo/screen.png', mimeType: 'image/png' },
    });
    expect(deps.ide.analyzeImage).toHaveBeenCalledWith('/repo/screen.png', 'image/png');
    const text = textOf(result);
    expect(text).toContain('semanticText');
    expect(text).toContain('Image: 10x20');
    expect(text).toContain('mockUi');
  });

  it('ide_command runs a command and renders status + output', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/repo', command: 'echo hi', cwd: '/repo/sub' },
    });
    expect(deps.ide.runCommand).toHaveBeenCalledWith('/repo', 'echo hi', { cwd: '/repo/sub', timeoutMs: undefined });
    const text = textOf(result);
    expect(text).toContain('exit 0');
    expect(text).toContain('ok');
  });

  it('ide_command surfaces a timeout as a clear status', async () => {
    const deps = makeDeps({
      runCommand: vi.fn(async () => ({ code: -1, stdout: '', stderr: '', timedOut: true, durationMs: 60000 })),
    });
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/repo', command: 'sleep 999' },
    });
    expect(textOf(result)).toContain('TIMED OUT');
  });

  it('injects a Secret Context alias only into the child environment and redacts its output', async () => {
    const deps = makeDeps({
      runCommand: vi.fn(async () => ({
        code: 0,
        stdout: 'token=top-secret-value',
        stderr: '',
        timedOut: false,
        durationMs: 1,
      })),
    });
    const repoSecrets = {
      list: vi.fn(async () => []),
      declare: vi.fn(async () => ({
        alias: 'PAYMENTS_API_KEY',
        description: 'Payments',
        status: 'needs_value' as const,
        updatedAt: 1,
      })),
      resolveEnvironment: vi.fn(async () => ({ PAYMENTS_API_KEY: 'top-secret-value' })),
      redact: vi.fn((text: string, values: Record<string, string>) =>
        text.replace(values.PAYMENTS_API_KEY, '[REDACTED]')
      ),
    };
    deps.repoSecrets = repoSecrets;
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/repo', command: 'node smoke.js', secretAliases: ['PAYMENTS_API_KEY'] },
    });
    expect(repoSecrets.resolveEnvironment).toHaveBeenCalledWith('/repo', ['PAYMENTS_API_KEY']);
    expect(deps.ide.runCommand).toHaveBeenCalledWith('/repo', 'node smoke.js', {
      cwd: undefined,
      timeoutMs: undefined,
      env: { PAYMENTS_API_KEY: 'top-secret-value' },
    });
    expect(textOf(result)).toContain('[REDACTED]');
    expect(textOf(result)).not.toContain('top-secret-value');
  });

  it('guides the agent to return a local-render marker without exposing a Secret Context value', async () => {
    const repoSecrets = {
      list: vi.fn(async () => [
        { alias: 'TEST', description: 'Test fixture', status: 'set' as const, updatedAt: 1 },
      ]),
      declare: vi.fn(async () => ({
        alias: 'TEST',
        description: 'Test fixture',
        status: 'needs_value' as const,
        updatedAt: 1,
      })),
      resolveEnvironment: vi.fn(async () => ({ TEST: 'actual-secret-value' })),
      redact: vi.fn((text: string) => text),
    };
    const client = await connect({ ide: makeService(), repoSecrets });

    const result = await client.callTool({
      name: 'ide_secret_context_list',
      arguments: { repository: '/repo' },
    });

    const output = textOf(result);
    expect(output).toContain('TEST');
    expect(output).toContain('{{secret:TEST}}');
    expect(output).not.toContain('actual-secret-value');
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
      profileTable: vi.fn(async () => ({
        schema: 'public',
        table: 'users',
        rowCount: 100,
        sampled: false,
        columns: [
          {
            column: 'id',
            type: 'integer',
            total: 100,
            nulls: 0,
            distinct: 100,
            min: 1,
            max: 100,
            avg: 50.5,
            sampled: false,
            topValues: [],
          },
          {
            column: 'status',
            type: 'text',
            total: 100,
            nulls: 4,
            distinct: 3,
            sampled: false,
            topValues: [{ value: 'active', count: 80 }],
          },
        ],
      })),
    };
    const client = await connect({ ide: makeService(), db });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'db_list_connections',
        'db_list_tables',
        'db_describe_table',
        'db_query',
        'db_profile_table',
      ])
    );

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

    const profiled = await client.callTool({ name: 'db_profile_table', arguments: { id: 'c1', table: 'users' } });
    expect(db.profileTable).toHaveBeenCalledWith('c1', 'users', undefined);
    const profileText = textOf(profiled);
    expect(profileText).toContain('"rowCount": 100');
    expect(profileText).toContain('"fillRate": 1'); // id is fully populated
    expect(profileText).toContain('"topValues"'); // status is low-cardinality
  });

  it('exposes team_* tools when a Team Edit coordinator is injected and guards writes', async () => {
    const claim = vi.fn(() => ({
      ok: true as const,
      lease: { relPath: 'src/a.ts', agentId: 'agent-a', expiresAt: 9_999, intent: 'refactor' },
      renewed: false,
    }));
    const write = vi.fn(async () => ({ ok: true as const, bytes: 12 }));
    const release = vi.fn(() => true);
    const snapshot = vi.fn(() => ({
      participants: [{ agentId: 'agent-a', label: 'Agent A', isUser: false }],
      leases: [{ relPath: 'src/a.ts', agentId: 'agent-a', expiresAt: 9_999 }],
    }));
    const editReplace = vi.fn(async () => ({ ok: true as const, matches: 1 }));
    const teamEdit = { claim, write, release, snapshot, editReplace };
    const client = await connect({ ide: makeService(), teamEdit });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'team_claim_file',
        'team_write_file',
        'team_edit_file',
        'team_release_file',
        'team_status',
        'tomny_team_claim',
        'tomny_team_write',
        'tomny_team_edit',
        'tomny_team_release',
        'tomny_team_status',
      ])
    );

    const tomnyStatus = await client.callTool({ name: 'tomny_team_status', arguments: { rootPath: '/repo' } });
    expect(textOf(tomnyStatus)).toContain('Agent A');

    const tomnyEdit = await client.callTool({
      name: 'tomny_team_edit',
      arguments: { rootPath: '/repo', agentId: 'agent-a', relPath: 'src/a.ts', oldText: 'before', newText: null },
    });
    expect(editReplace).toHaveBeenCalledWith('/repo', 'agent-a', 'src/a.ts', 'before', '');
    expect(textOf(tomnyEdit)).toContain('Edited src/a.ts');

    const claimed = await client.callTool({
      name: 'team_claim_file',
      arguments: { rootPath: '/repo', agentId: 'agent-a', relPath: 'src/a.ts', intent: 'refactor' },
    });
    expect(claim).toHaveBeenCalledWith('/repo', 'agent-a', 'src/a.ts', 'refactor');
    expect(textOf(claimed)).toContain('Claimed src/a.ts');

    const wrote = await client.callTool({
      name: 'team_write_file',
      arguments: { rootPath: '/repo', agentId: 'agent-a', relPath: 'src/a.ts', content: 'hello world!' },
    });
    expect(write).toHaveBeenCalledWith('/repo', 'agent-a', 'src/a.ts', 'hello world!');
    expect(textOf(wrote)).toContain('12 bytes');

    const status = await client.callTool({ name: 'team_status', arguments: { rootPath: '/repo' } });
    expect(textOf(status)).toContain('Agent A');
    expect(textOf(status)).toContain('src/a.ts — held by agent-a');

    const edited = await client.callTool({
      name: 'team_edit_file',
      arguments: { rootPath: '/repo', agentId: 'agent-a', relPath: 'src/a.ts', oldText: 'foo', newText: 'bar' },
    });
    expect(editReplace).toHaveBeenCalledWith('/repo', 'agent-a', 'src/a.ts', 'foo', 'bar');
    expect(textOf(edited)).toContain('Edited src/a.ts');
  });

  it('team_write_file reports a conflict instead of overwriting', async () => {
    const teamEdit = {
      claim: vi.fn(() => ({ ok: true as const, lease: { relPath: 'x', agentId: 'a', expiresAt: 1 }, renewed: false })),
      write: vi.fn(async () => ({
        ok: false as const,
        reason: 'held' as const,
        lease: { relPath: 'src/a.ts', agentId: 'agent-b', expiresAt: 9_999 },
      })),
      editReplace: vi.fn(async () => ({ ok: true as const, matches: 1 })),
      release: vi.fn(() => true),
      snapshot: vi.fn(() => ({ participants: [], leases: [] })),
    };
    const client = await connect({ ide: makeService(), teamEdit });
    const result = await client.callTool({
      name: 'team_write_file',
      arguments: { rootPath: '/repo', agentId: 'agent-a', relPath: 'src/a.ts', content: 'x' },
    });
    expect(textOf(result)).toContain('CONFLICT');
    expect(textOf(result)).toContain('agent-b');
  });

  it('team_edit_file reports a stale anchor so the agent re-reads instead of clobbering', async () => {
    const teamEdit = {
      claim: vi.fn(() => ({ ok: true as const, lease: { relPath: 'x', agentId: 'a', expiresAt: 1 }, renewed: false })),
      write: vi.fn(async () => ({ ok: true as const, bytes: 1 })),
      editReplace: vi.fn(async () => ({
        ok: false as const,
        reason: 'stale' as const,
        detail: 'Text not found in src/a.ts',
      })),
      release: vi.fn(() => true),
      snapshot: vi.fn(() => ({ participants: [], leases: [] })),
    };
    const client = await connect({ ide: makeService(), teamEdit });
    const result = await client.callTool({
      name: 'team_edit_file',
      arguments: { rootPath: '/repo', agentId: 'agent-a', relPath: 'src/a.ts', oldText: 'gone', newText: 'x' },
    });
    expect(textOf(result)).toContain('STALE');
    expect(textOf(result)).toContain('Re-read');
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

  it('ide_grep aliases the search engine and renders file:line hits', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'ide_grep',
      arguments: { rootPath: '/repo', pattern: 'x', regex: true, glob: '*.ts', maxResults: 50 },
    });
    expect(deps.ide.search).toHaveBeenCalledWith('/repo', 'x', {
      glob: '*.ts',
      regex: true,
      wholeWord: undefined,
      caseSensitive: undefined,
      maxResults: 50,
    });
    expect(textOf(result)).toContain('src/a.ts:10: const x = 1');
  });

  it('ide_glob lists only files matching the pattern (recursive by default)', async () => {
    const deps = makeDeps({
      listDir: vi.fn(async () => [
        { name: 'src', fullPath: '/repo/src', isDir: true, relativePath: 'src' },
        { name: 'a.ts', fullPath: '/repo/src/a.ts', isDir: false, relativePath: 'src/a.ts' },
        { name: 'b.ts', fullPath: '/repo/src/b.ts', isDir: false, relativePath: 'src/b.ts' },
      ]),
    });
    const client = await connect(deps);
    const result = await client.callTool({
      name: 'ide_glob',
      arguments: { dir: '/repo', pattern: '**/*.ts' },
    });
    expect(deps.ide.listDir).toHaveBeenCalledWith('/repo', { glob: '**/*.ts', recursive: true, maxResults: undefined });
    const text = textOf(result);
    expect(text).toContain('src/a.ts');
    expect(text).toContain('src/b.ts');
    expect(text).not.toContain('[dir]');
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

describe('ideServer — exp_* (ExpBase agent plane)', () => {
  const makeExperience = () => ({
    search: vi.fn(async () => [
      {
        entryId: 'exp-1',
        score: 0.91,
        kind: 'successful_fix' as const,
        symptom: 'TypeScript build fails',
        lesson: 'Regenerate the generated types before typecheck.',
        whyRelevant: ['same command'],
        caution: [],
        suggestedChecks: ['bunx tsc --noEmit'],
      },
    ]),
    record: vi.fn(async () => ({ action: 'created' as const, entry: { id: 'exp-2' } })),
    recordFeedback: vi.fn(async () => true),
    verifyOutcome: vi.fn(async () => ({
      decision: { shouldRetrieve: false, failureCount: 1, reason: 'below-threshold-2' },
      suggestions: [],
    })),
  });

  it('exposes ExpBase tools only when the existing service is injected', async () => {
    const without = await connect(makeDeps());
    expect((await without.listTools()).tools.map((tool) => tool.name)).not.toContain('exp_search');

    const experience = makeExperience();
    const withExp = await connect({ ide: makeService(), experience });
    expect((await withExp.listTools()).tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['exp_search', 'exp_record', 'exp_feedback', 'exp_verify'])
    );
  });

  it('searches the existing project ExpBase and returns compact lessons', async () => {
    const experience = makeExperience();
    const client = await connect({ ide: makeService(), experience });
    const result = await client.callTool({
      name: 'exp_search',
      arguments: { projectRoot: '/repo', symptom: 'tsc fails', files: ['src/auth.ts'], limit: 3 },
    });

    expect(experience.search).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ symptom: 'tsc fails', files: ['src/auth.ts'] }),
      { topK: 3 }
    );
    expect(textOf(result)).toContain('Regenerate the generated types');
  });

  it('reports verification outcomes through the conditional ExpBase trigger', async () => {
    const experience = makeExperience();
    const client = await connect({ ide: makeService(), experience });
    const result = await client.callTool({
      name: 'exp_verify',
      arguments: { projectRoot: '/repo', outcome: 'failed', command: 'bunx tsc --noEmit', errorText: 'TS2322' },
    });

    expect(experience.verifyOutcome).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ command: 'bunx tsc --noEmit', errorText: 'TS2322' }),
      'failed'
    );
    expect(textOf(result)).toContain('below-threshold-2');
  });
});

describe('ideServer — automatic ExpBase command observation', () => {
  it('surfaces an existing lesson when a repeated command failure triggers retrieval', async () => {
    const verifyOutcome = vi
      .fn()
      .mockResolvedValueOnce({
        decision: { shouldRetrieve: false, failureCount: 1, reason: 'below-threshold-2' },
        suggestions: [],
      })
      .mockResolvedValueOnce({
        decision: { shouldRetrieve: true, failureCount: 2, reason: 'reached-threshold-2' },
        suggestions: [
          {
            entryId: 'exp-1',
            score: 0.91,
            kind: 'successful_fix',
            symptom: 'TypeScript build fails',
            lesson: 'Regenerate generated types before retrying.',
            whyRelevant: [],
            caution: [],
            suggestedChecks: ['bun run i18n:types'],
          },
        ],
      });
    const experience = {
      search: vi.fn(async () => []),
      record: vi.fn(async () => ({ action: 'created' as const, entryId: 'exp-2' })),
      recordFeedback: vi.fn(async () => true),
      verifyOutcome,
    };
    const runCommand = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'TS2322',
      timedOut: false,
      durationMs: 5,
    }));
    const client = await connect({ ide: makeService({ runCommand }), experience });

    await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/repo', command: 'bunx tsc --noEmit' },
    });
    const repeated = await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/repo', command: 'bunx tsc --noEmit' },
    });

    expect(verifyOutcome).toHaveBeenCalledTimes(2);
    expect(textOf(repeated)).toContain('Regenerate generated types before retrying.');
  });
});

describe('ideServer — ExpBase observation resilience', () => {
  it('keeps command output when ExpBase observation fails', async () => {
    const experience = {
      search: vi.fn(async () => []),
      record: vi.fn(async () => ({ action: 'created' as const, entryId: 'exp-2' })),
      recordFeedback: vi.fn(async () => true),
      verifyOutcome: vi.fn(async () => {
        throw new Error('ExpBase unavailable');
      }),
    };
    const runCommand = vi.fn(async () => ({
      code: 1,
      stdout: '',
      stderr: 'TS2322',
      timedOut: false,
      durationMs: 5,
    }));
    const client = await connect({ ide: makeService({ runCommand }), experience });
    const result = await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/repo', command: 'bunx tsc --noEmit' },
    });

    expect(textOf(result)).toContain('TS2322');
    expect((result as { isError?: boolean }).isError).not.toBe(true);
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
