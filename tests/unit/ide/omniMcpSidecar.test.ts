/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildOmniIdeServer } from '@/process/omni-gateway/omniGatewayProfile';
import { createOmniGatewayState } from '@/process/omni-gateway/omniGatewayState';
import type { IdeMcpService, IdeServerDeps, TeamEditAgentService } from '@/process/ide/mcp/ideServer';

const root = process.cwd();
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf-8');

const makeIdeService = (): IdeMcpService => ({
  listDir: async () => [],
  readFile: async () => ({
    text: 'contents',
    lineStart: 1,
    lineEnd: 1,
    totalLines: 1,
    returnedLines: 1,
    truncated: false,
    binary: false,
    sizeBytes: 8,
  }),
  scanRepo: async () => ({ fileCount: 0, edgeCount: 0, topGroups: [], truncated: false }),
  search: async () => [],
  findDefinition: async () => [],
  findReferences: async () => [],
  understand: async () => ({ summary: 'summary' }),
  compassRead: async () => ({ summary: 'compass' }),
  context: async () => ({ summary: 'context' }),
  map: async () => ({ summary: 'map' }),
  analyze: async () => ({ summary: 'analyze' }),
  compact: async () => ({ summary: 'compact' }),
  runCommand: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
});

const makeTeamEdit = (): TeamEditAgentService => ({
  claim: (_rootPath, agentId, relPath, intent) => ({
    ok: true,
    lease: { relPath, agentId, intent, expiresAt: 10_000 },
    renewed: false,
  }),
  release: () => true,
  write: async (_rootPath, _agentId, _relPath, data) => ({ ok: true, bytes: data.length }),
  editReplace: async () => ({ ok: true, matches: 1 }),
  snapshot: () => ({ participants: [], leases: [] }),
});

const connectGatewayProfile = async (ideDeps: Omit<IdeServerDeps, 'toolGuard'>, rootPath = root) => {
  const server = buildOmniIdeServer({
    state: createOmniGatewayState({ now: () => 1_000, newId: () => 'session-1', sessionTtlMs: 60_000 }),
    rootPath,
    allowDangerous: true,
    sessionTtlMs: 60_000,
    ideDeps,
    mode: 'external',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

const jsonText = <T>(result: unknown): T => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return JSON.parse(content.map((part) => part.text ?? '').join('\n')) as T;
};

type ListedTool = {
  name: string;
  inputSchema?: {
    properties?: Record<string, { type?: string }>;
  };
  _meta?: Record<string, unknown>;
};

describe('Omni MCP sidecar smoke checks', () => {
  it('declares standalone package scripts', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['omni:mcp']).toBe('node scripts/omni-mcp-sidecar.cjs start');
    expect(pkg.scripts['omni:rescue']).toBe('node scripts/omni-mcp-sidecar.cjs rescue --external --tunnel');
    expect(pkg.scripts['omni:rescue:local']).toBe('node scripts/omni-mcp-sidecar.cjs rescue --local');
    expect(pkg.scripts['omni:rescue:external']).toBe('node scripts/omni-mcp-sidecar.cjs rescue --external --tunnel');
    expect(pkg.scripts['omni:doctor']).toBe('node scripts/omni-mcp-sidecar.cjs doctor');
    expect(pkg.scripts['omni:mcp:health']).toBe('node scripts/omni-mcp-sidecar.cjs health');
  });

  it('keeps the standalone sidecar free of renderer and Electron imports', () => {
    const sidecar = read('packages/desktop/src/process/ide/mcp/omniMcpSidecar.ts');
    const nodeWiring = read('packages/desktop/src/process/ide/mcp/omniNodeWiring.ts');
    const combined = `${sidecar}\n${nodeWiring}`;
    expect(combined).not.toMatch(/from ['"]electron['"]|require\(['"]electron['"]\)/);
    expect(combined).not.toContain('/renderer/');
    expect(combined).not.toContain('@renderer');
    expect(combined).not.toContain('@arco-design/web-react');
    expect(combined).not.toContain('react');
  });

  it('uses the app-compatible gateway runtime for rescue external mode', () => {
    const sidecar = read('packages/desktop/src/process/ide/mcp/omniMcpSidecar.ts');
    const registrar = read('packages/desktop/src/process/omni-gateway/registerOmniGateway.ts');

    expect(sidecar).toContain('createOmniGatewayRuntime');
    expect(registrar).toContain('createOmniGatewayRuntime');
    expect(sidecar).not.toContain('startOmniGatewayHost({');
    expect(sidecar).not.toContain('buildOmniIdeServer({');
    expect(sidecar).toContain('fetchGatewayEndpoint');
    expect(sidecar).toContain('app-compatible external gateway already running');
    expect(sidecar).toContain('attachToExistingRescue');
    expect(sidecar).toContain('Keep this terminal open');
    expect(sidecar).toContain('Required path:       /ide/mcp');
    expect(sidecar).toContain('Bootstrap tool:      omni_bootstrap_session');
  });

  it('reuses the app gateway credential instead of minting a rescue-only token file', () => {
    const sidecar = read('packages/desktop/src/process/ide/mcp/omniMcpSidecar.ts');

    expect(sidecar).toContain("OMNI_GATEWAY_CREDENTIAL_ID = 'omni-gateway-token'");
    expect(sidecar).toContain('createCredentialStore');
    expect(sidecar).not.toContain('omni-rescue-gateway-token');
    expect(sidecar).not.toContain('presented === bearerToken');
  });

  it('does not advertise optional tools that are missing from the actual MCP registry', async () => {
    const client = await connectGatewayProfile({ ide: makeIdeService() });
    const registryNames = new Set((await client.listTools()).tools.map((tool) => tool.name));
    const bootstrap = jsonText<{ tools: Array<{ name: string }> }>(
      await client.callTool({ name: 'omni_bootstrap_session', arguments: {} })
    );
    const advertisedNames = bootstrap.tools.map((tool) => tool.name);

    expect(advertisedNames).not.toContain('team_edit_file');
    expect(advertisedNames).not.toContain('team_write_file');
    expect(advertisedNames.every((name) => registryNames.has(name))).toBe(true);
  });

  it('keeps rescue team tools in bootstrap and the callable MCP registry', async () => {
    const teamEdit = makeTeamEdit();
    const client = await connectGatewayProfile({ ide: makeIdeService(), teamEdit });
    const listedTools = (await client.listTools()).tools as ListedTool[];
    const registryNames = new Set(listedTools.map((tool) => tool.name));
    const bootstrap = jsonText<{ sessionId: string; tools: Array<{ name: string }> }>(
      await client.callTool({ name: 'omni_bootstrap_session', arguments: {} })
    );
    const omniList = jsonText<{
      baseAllowlist: Array<{ name: string }>;
      dangerousTools: Array<{ name: string }>;
    }>(await client.callTool({ name: 'omni_list_tools', arguments: {} }));
    const advertisedNames = bootstrap.tools.map((tool) => tool.name);
    const listedNames = [...omniList.baseAllowlist, ...omniList.dangerousTools].map((tool) => tool.name);

    for (const name of [
      'team_claim_file',
      'team_edit_file',
      'team_write_file',
      'team_release_file',
      'team_status',
      'ide_command',
      'ide_read_file',
      'ide_grep',
      'ide_glob',
      'ide_list_dir',
      'import_artifact_text',
      'apply_artifact_edit',
      'import_media_asset',
      'list_artifacts',
      'delete_artifact',
    ]) {
      expect(advertisedNames).toContain(name);
      expect(listedNames).toContain(name);
      expect(registryNames.has(name)).toBe(true);
    }

    for (const name of ['import_artifact_text', 'import_media_asset']) {
      const tool = listedTools.find((item) => item.name === name);
      expect(tool?.inputSchema?.properties?.file).toBeTruthy();
      expect(tool?.inputSchema?.properties?.file?.type).toBe('string');
      expect(tool?._meta?.['openai/fileParams']).toEqual(['file']);
    }

    const edited = await client.callTool({
      name: 'team_edit_file',
      arguments: {
        sessionId: bootstrap.sessionId,
        rootPath: root,
        agentId: 'agent-a',
        relPath: 'package.json',
        oldText: '"name"',
        newText: '"name"',
      },
    });
    expect(JSON.stringify(edited)).toContain('Edited package.json');
  });

  it('calls artifact tools through the real MCP registry', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'omni-mcp-artifact-workspace-'));
    const uploads = await mkdtemp(path.join(os.tmpdir(), 'omni-mcp-artifact-upload-'));
    try {
      await writeFile(path.join(workspace, 'target.ts'), 'const value = "old";\n', 'utf-8');
      const artifactPath = path.join(uploads, 'replacement.txt');
      await writeFile(artifactPath, '"new"', 'utf-8');
      const client = await connectGatewayProfile({ ide: makeIdeService(), teamEdit: makeTeamEdit() }, workspace);
      const bootstrap = jsonText<{ sessionId: string }>(
        await client.callTool({ name: 'omni_bootstrap_session', arguments: {} })
      );

      const imported = jsonText<{ artifactId: string; preview: string }>(
        await client.callTool({
          name: 'import_artifact_text',
          arguments: {
            sessionId: bootstrap.sessionId,
            file: artifactPath,
            purpose: 'snippet',
          },
        })
      );
      expect(imported.artifactId).toBeTruthy();
      expect(imported.preview).toBe('"new"');

      const listed = jsonText<{ artifacts: Array<{ artifactId: string }> }>(
        await client.callTool({ name: 'list_artifacts', arguments: { sessionId: bootstrap.sessionId } })
      );
      expect(listed.artifacts.map((artifact) => artifact.artifactId)).toContain(imported.artifactId);

      const dryRun = jsonText<{ ok: boolean; changed: boolean; diffPreview: string }>(
        await client.callTool({
          name: 'apply_artifact_edit',
          arguments: {
            sessionId: bootstrap.sessionId,
            artifactId: imported.artifactId,
            targetPath: 'target.ts',
            mode: 'replace_anchor',
            anchor: '"old"',
            dryRun: true,
          },
        })
      );
      expect(dryRun.ok).toBe(true);
      expect(dryRun.changed).toBe(true);
      expect(dryRun.diffPreview).toContain('"new"');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(uploads, { recursive: true, force: true });
    }
  });

  it('documents the rescue workflow and stop command', () => {
    const doc = read('docs/RESCUE_MCP.md');
    expect(doc).toContain('bun run omni:rescue');
    expect(doc).toContain('bun run omni:rescue:local');
    expect(doc).toContain('bun run omni:mcp:health');
    expect(doc).toContain('node scripts/omni-mcp-sidecar.cjs stop');
    expect(doc).toContain('/ide/mcp');
    expect(doc).toContain('omni_bootstrap_session');
    expect(doc).toContain('public MCP URL');
    expect(doc).toContain('does not rename `.aionui`');
  });
});
