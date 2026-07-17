/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * End-to-end test of the IDE-profile MCP server built by the Omni External MCP
 * Gateway: drives `buildOmniIdeServer` through an in-memory MCP client pair
 * (same approach as `cronServer.test.ts`) with a faked IdeMcpService, and
 * asserts:
 *   1. `omni_bootstrap_session` is the only path to a usable session.
 *   2. Tools called BEFORE bootstrap are refused with the canonical message.
 *   3. After bootstrap, the underlying ide service receives the call.
 *   4. Dangerous tools are refused when the opt-in is off, allowed when on.
 *   5. An unknown sessionId is rejected (the host did not bootstrap here).
 */

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOmniIdeServer } from '@/process/omni-gateway/omniGatewayProfile';
import { createOmniGatewayState } from '@/process/omni-gateway/omniGatewayState';
import type { IdeMcpService, QuickTestScenarioAgentService } from '@/process/ide/mcp/ideServer';

import {
  OMNI_IDE_BASE_ALLOWLIST_NAMES,
  OMNI_IDE_DANGEROUS_NAMES,
  OMNI_IDE_EXTERNAL_ALLOWLIST_NAMES,
} from '@/process/omni-gateway/omniIdeAllowlist';

const TTL_MS = 60_000;

/** Spy-friendly `IdeMcpService` returning structurally-valid empty responses. */
const fakeIdeService = (): IdeMcpService => ({
  listDir: vi.fn(async () => []),
  readFile: vi.fn(async () => ({
    text: '',
    lineStart: 1,
    lineEnd: 1,
    totalLines: 0,
    returnedLines: 0,
    truncated: false,
    binary: false,
    sizeBytes: 0,
  })),
  scanRepo: vi.fn(async () => ({ fileCount: 0, edgeCount: 0, topGroups: [], truncated: false })),
  search: vi.fn(async () => []),
  findDefinition: vi.fn(async () => []),
  findReferences: vi.fn(async () => []),
  understand: vi.fn(async () => ({ summary: '', stale: false })),
  compassRead: vi.fn(async () => ({ summary: '' })),
  context: vi.fn(async () => ({ summary: '' })),
  map: vi.fn(async () => ({ summary: '' })),
  analyze: vi.fn(async () => ({ summary: '' })),
  analyzeImage: vi.fn(async () => ({
    json: { schemaVersion: 1, image: { width: 10, height: 20 } },
    semanticText: 'Image: 10x20',
    mockUi: '[image]\n[/image]',
  })),
  compact: vi.fn(async () => ({ summary: '' })),
  runCommand: vi.fn(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 })),
});

const fakeQuickTestScenarios = (): QuickTestScenarioAgentService => ({
  list: vi.fn(async () => ({ scenarios: [], total: 0 })),
  describe: vi.fn(async () => ({
    id: 'scenario-1',
    name: 'Scenario',
    platform: 'web',
    stepCount: 0,
    createdAt: 1,
    rootPath: '/tmp/repo',
    steps: [],
  })),
  run: vi.fn(async () => ({ runId: 'run-1', scenarioId: 'scenario-1', status: 'queued', queuedAt: 1 })),
  status: vi.fn(async () => ({ runId: 'run-1', scenarioId: 'scenario-1', status: 'running', queuedAt: 1 })),
  cancel: vi.fn(async () => ({ runId: 'run-1', scenarioId: 'scenario-1', status: 'cancelled', queuedAt: 1 })),
  compare: vi.fn(async () => ({ baselineRunId: 'run-0', currentRunId: 'run-1' })),
});

const connect = async (opts: {
  allowDangerous: boolean;
  ide?: IdeMcpService;
  mode?: 'local' | 'external';
  quickTestScenarios?: QuickTestScenarioAgentService;
  toolPermissions?: Record<string, boolean>;
}) => {
  const state = createOmniGatewayState({
    now: () => Date.now(),
    newId: () => `omni-test-${Math.random().toString(36).slice(2)}`,
    sessionTtlMs: TTL_MS,
  });
  const ide = opts.ide ?? fakeIdeService();
  const server = buildOmniIdeServer({
    state,
    rootPath: '/tmp/repo',
    allowDangerous: opts.allowDangerous,
    sessionTtlMs: TTL_MS,
    ideDeps: { ide, quickTestScenarios: opts.quickTestScenarios },
    mode: opts.mode,
    toolPermissions: opts.toolPermissions,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, ide, state };
};

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const textOf = (result: CallResult): string => result.content.find((c) => c.type === 'text')?.text ?? '';

describe('Quick Test Agent Bridge gateway policy', () => {
  it('keeps inspection tools read-only and gates replay controls as dangerous', () => {
    for (const name of [
      'ide_quick_test_list',
      'ide_quick_test_describe',
      'ide_quick_test_status',
      'ide_quick_test_compare',
    ]) {
      expect(OMNI_IDE_BASE_ALLOWLIST_NAMES.has(name)).toBe(true);
      expect(OMNI_IDE_EXTERNAL_ALLOWLIST_NAMES.has(name)).toBe(true);
    }
    expect(OMNI_IDE_DANGEROUS_NAMES.has('ide_quick_test_run')).toBe(true);
    expect(OMNI_IDE_DANGEROUS_NAMES.has('ide_quick_test_cancel')).toBe(true);
    expect(OMNI_IDE_EXTERNAL_ALLOWLIST_NAMES.has('ide_quick_test_run')).toBe(false);
  });

  it('allows saved-scenario inspection after bootstrap', async () => {
    const scenarios = fakeQuickTestScenarios();
    const { client } = await connect({ allowDangerous: false, quickTestScenarios: scenarios });
    const bootstrap = (await client.callTool({ name: 'omni_bootstrap_session', arguments: {} })) as CallResult;
    const { sessionId } = JSON.parse(textOf(bootstrap)) as { sessionId: string };
    const result = (await client.callTool({
      name: 'ide_quick_test_list',
      arguments: { rootPath: '/tmp/repo', sessionId },
    })) as CallResult;
    expect(result.isError).toBeFalsy();
    expect(scenarios.list).toHaveBeenCalledOnce();
  });

  it('blocks saved-scenario replay without the dangerous opt-in', async () => {
    const scenarios = fakeQuickTestScenarios();
    const { client } = await connect({ allowDangerous: false, quickTestScenarios: scenarios });
    const bootstrap = (await client.callTool({ name: 'omni_bootstrap_session', arguments: {} })) as CallResult;
    const { sessionId } = JSON.parse(textOf(bootstrap)) as { sessionId: string };
    const result = (await client.callTool({
      name: 'ide_quick_test_run',
      arguments: { rootPath: '/tmp/repo', scenarioId: 'scenario-1', sessionId },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(scenarios.run).not.toHaveBeenCalled();
  });
});

describe('omniGatewayProfile (IDE profile)', () => {
  it('lists both omni_* housekeeping tools and the underlying ide_* tools', async () => {
    const { client } = await connect({ allowDangerous: false });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('omni_bootstrap_session');
    expect(names).toContain('omni_get_active_guide');
    expect(names).toContain('omni_list_tools');
    expect(names).toContain('ide_search');
    expect(names).toContain('ide_command'); // dangerous, but still listed
  });

  it('refuses ide_* calls before bootstrap with the canonical error message', async () => {
    const { client, ide } = await connect({ allowDangerous: false });
    const result = (await client.callTool({
      name: 'ide_search',
      arguments: { rootPath: '/tmp/repo', query: 'foo' },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('omni_bootstrap_session');
    expect(ide.search).not.toHaveBeenCalled();
  });

  it('after bootstrap, an ide_* call with the returned sessionId reaches the service', async () => {
    const { client, ide } = await connect({ allowDangerous: false });
    const bootstrap = (await client.callTool({
      name: 'omni_bootstrap_session',
      arguments: {},
    })) as CallResult;
    const payload = JSON.parse(textOf(bootstrap)) as { sessionId: string };
    expect(payload.sessionId).toMatch(/^omni-test-/);

    const result = (await client.callTool({
      name: 'ide_search',
      arguments: { rootPath: '/tmp/repo', query: 'foo', sessionId: payload.sessionId },
    })) as CallResult;
    expect(result.isError).toBeFalsy();
    expect(ide.search).toHaveBeenCalledTimes(1);
  });

  it('rejects a tool call carrying an unknown sessionId', async () => {
    const { client } = await connect({ allowDangerous: false });
    const result = (await client.callTool({
      name: 'ide_search',
      arguments: { rootPath: '/tmp/repo', query: 'foo', sessionId: 'bogus' },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('omni_bootstrap_session');
  });

  it('rejects a rootPath outside the workspace bound to the session', async () => {
    const { client, ide } = await connect({ allowDangerous: false });
    const bootstrap = (await client.callTool({
      name: 'omni_bootstrap_session',
      arguments: {},
    })) as CallResult;
    const { sessionId } = JSON.parse(textOf(bootstrap)) as { sessionId: string };
    const result = (await client.callTool({
      name: 'ide_search',
      arguments: { rootPath: '/tmp/another-repo', query: 'foo', sessionId },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('does not match the workspace');
    expect(ide.search).not.toHaveBeenCalled();
  });

  it('refuses dangerous tools when allowDangerous is off', async () => {
    const { client, ide } = await connect({ allowDangerous: false });
    const bootstrap = (await client.callTool({
      name: 'omni_bootstrap_session',
      arguments: {},
    })) as CallResult;
    const { sessionId } = JSON.parse(textOf(bootstrap)) as { sessionId: string };
    const result = (await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/tmp/repo', command: 'echo hi', sessionId },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('dangerous');
    expect(ide.runCommand).not.toHaveBeenCalled();
  });

  it('never exposes replay controls over the public tunnel', async () => {
    const scenarios = fakeQuickTestScenarios();
    const { client } = await connect({
      allowDangerous: true,
      mode: 'external',
      quickTestScenarios: scenarios,
    });
    const bootstrap = (await client.callTool({
      name: 'omni_bootstrap_session',
      arguments: {},
    })) as CallResult;
    const { sessionId } = JSON.parse(textOf(bootstrap)) as { sessionId: string };
    const result = (await client.callTool({
      name: 'ide_quick_test_run',
      arguments: { rootPath: '/tmp/repo', scenarioId: 'scenario-1', sessionId },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('public External MCP tunnel');
    expect(scenarios.run).not.toHaveBeenCalled();
  });

  it('allows dangerous tools when allowDangerous is on', async () => {
    const { client, ide } = await connect({ allowDangerous: true });
    const bootstrap = (await client.callTool({
      name: 'omni_bootstrap_session',
      arguments: {},
    })) as CallResult;
    const { sessionId } = JSON.parse(textOf(bootstrap)) as { sessionId: string };
    const result = (await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/tmp/repo', command: 'echo hi', sessionId },
    })) as CallResult;
    expect(result.isError).toBeFalsy();
    expect(ide.runCommand).toHaveBeenCalledTimes(1);
  });
});

describe('omniGatewayProfile — per-tool permissions', () => {
  const bootstrap = async (client: Awaited<ReturnType<typeof connect>>['client']): Promise<string> => {
    const result = (await client.callTool({ name: 'omni_bootstrap_session', arguments: {} })) as CallResult;
    return (JSON.parse(textOf(result)) as { sessionId: string }).sessionId;
  };

  it('an explicit DENY blocks a base (normally-allowed) tool', async () => {
    const { client, ide } = await connect({ allowDangerous: false, toolPermissions: { ide_search: false } });
    const sessionId = await bootstrap(client);
    const result = (await client.callTool({
      name: 'ide_search',
      arguments: { rootPath: '/tmp/repo', query: 'foo', sessionId },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('disabled');
    expect(ide.search).not.toHaveBeenCalled();
  });

  it('an explicit ALLOW lets a dangerous tool through even when the flag is OFF', async () => {
    const { client, ide } = await connect({ allowDangerous: false, toolPermissions: { ide_command: true } });
    const sessionId = await bootstrap(client);
    const result = (await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/tmp/repo', command: 'echo hi', sessionId },
    })) as CallResult;
    expect(result.isError).toBeFalsy();
    expect(ide.runCommand).toHaveBeenCalledTimes(1);
  });

  it('absent permission falls back to default policy (dangerous still gated)', async () => {
    const { client, ide } = await connect({ allowDangerous: false, toolPermissions: { ide_search: true } });
    const sessionId = await bootstrap(client);
    const result = (await client.callTool({
      name: 'ide_command',
      arguments: { rootPath: '/tmp/repo', command: 'echo hi', sessionId },
    })) as CallResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('dangerous');
    expect(ide.runCommand).not.toHaveBeenCalled();
  });
});
