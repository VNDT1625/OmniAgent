/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the read-only Debug Bridge handler.
 *
 * Drives the handler through fake Node HTTP IncomingMessage/ServerResponse
 * objects so we don't need a real loopback socket. Uses real token-store +
 * state instances (small, in-RAM, deterministic via injected clocks) and a
 * fake IdeMcpService for the underlying repo operations.
 */

import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createOmniDebugBridge } from '@/process/omni-gateway/omniGatewayDebugBridge';
import { createOmniGatewayState } from '@/process/omni-gateway/omniGatewayState';
import { createOmniGatewayTokenStore } from '@/process/omni-gateway/omniGatewayExternalToken';
import type { IdeMcpService } from '@/process/ide/mcp/ideServer';

const fakeIde = (overrides?: Partial<IdeMcpService>): IdeMcpService => ({
  listDir: vi.fn(async () => []),
  readFile: vi.fn(async () => ({
    text: 'hello',
    lineStart: 1,
    lineEnd: 1,
    totalLines: 1,
    returnedLines: 1,
    truncated: false,
    binary: false,
    sizeBytes: 5,
  })),
  scanRepo: vi.fn(async () => ({ fileCount: 0, edgeCount: 0, topGroups: [], truncated: false })),
  search: vi.fn(async () => [{ file: 'x.ts', line: 1, text: 'match', column: 1 }]),
  findDefinition: vi.fn(async () => [{ file: 'x.ts', line: 1, column: 1, text: 'def' }]),
  findReferences: vi.fn(async () => []),
  understand: vi.fn(async () => ({ summary: '' })),
  compassRead: vi.fn(async () => ({ summary: '' })),
  context: vi.fn(async () => ({ summary: '' })),
  map: vi.fn(async () => ({ summary: '' })),
  analyze: vi.fn(async () => ({ summary: '' })),
  compact: vi.fn(async () => ({ summary: '' })),
  runCommand: vi.fn(async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 })),
  ...overrides,
});

/** Minimal fake of ServerResponse — captures status + body for assertions. */
const makeRes = () => {
  let status = 200;
  let body = '';
  let ended = false;
  const headers: Record<string, string> = {};
  const res = {
    headersSent: false,
    writeHead: vi.fn((s: number, h?: Record<string, string>) => {
      status = s;
      if (h) Object.assign(headers, h);
      return res;
    }),
    end: vi.fn((data?: string) => {
      if (data) body = data;
      ended = true;
    }),
  } as unknown as ServerResponse;
  return {
    res,
    getStatus: () => status,
    getBody: () => body,
    getJson: () => JSON.parse(body) as unknown,
    isEnded: () => ended,
    headers,
  };
};

const makeReq = (method: 'GET' | 'POST', urlPath: string): IncomingMessage =>
  ({ method, url: urlPath, headers: {} }) as unknown as IncomingMessage;

const setup = () => {
  const state = createOmniGatewayState({ now: () => 1000, newId: () => 'omni-s', sessionTtlMs: 60_000 });
  const tokenStore = createOmniGatewayTokenStore({ now: () => 1000, newToken: () => 'tok-1' });
  const ide = fakeIde();
  const bridge = createOmniDebugBridge({
    tokenStore,
    state,
    ide,
    rootPath: '/repo',
    sessionTtlMs: 60_000,
    getMcpEndpoint: () => 'https://tunnel.test/ide/mcp',
  });
  return { bridge, tokenStore, ide, state };
};

describe('omniGatewayDebugBridge', () => {
  it('refuses non-GET methods (read-only enforcement)', async () => {
    const { bridge } = setup();
    const r = makeRes();
    await bridge.handle(makeReq('POST', '/debug/omni/health?token=anything'), r.res);
    expect(r.getStatus()).toBe(405);
  });

  it('returns 400 when token query param is missing', async () => {
    const { bridge } = setup();
    const r = makeRes();
    await bridge.handle(makeReq('GET', '/debug/omni/health'), r.res);
    expect(r.getStatus()).toBe(400);
  });

  it('returns 403 for an unknown token', async () => {
    const { bridge } = setup();
    const r = makeRes();
    await bridge.handle(makeReq('GET', '/debug/omni/health?token=bogus'), r.res);
    expect(r.getStatus()).toBe(403);
    expect((r.getJson() as { error: string }).error).toMatch(/unknown/i);
  });

  it('GET /debug/omni/health returns the workspace + debug tool list', async () => {
    const { bridge, tokenStore } = setup();
    const t = tokenStore.mintDebugToken(60_000);
    const r = makeRes();
    await bridge.handle(makeReq('GET', `/debug/omni/health?token=${t.token}`), r.res);
    expect(r.getStatus()).toBe(200);
    const body = r.getJson() as { ok: boolean; workspace: string; availableDebugTools: string[]; mcpEndpoint: string };
    expect(body.ok).toBe(true);
    expect(body.workspace).toBe('/repo');
    expect(body.availableDebugTools).toContain('bootstrap');
    expect(body.availableDebugTools).toContain('search');
    expect(body.mcpEndpoint).toBe('https://tunnel.test/ide/mcp');
  });

  it('GET /debug/omni/bootstrap issues a session and lists the same allowlist as the MCP plane', async () => {
    const { bridge, tokenStore } = setup();
    const t = tokenStore.mintDebugToken(60_000);
    const r = makeRes();
    await bridge.handle(makeReq('GET', `/debug/omni/bootstrap?token=${t.token}`), r.res);
    expect(r.getStatus()).toBe(200);
    const body = r.getJson() as {
      ok: boolean;
      sessionId: string;
      tools: Array<{ name: string; dangerous?: boolean }>;
      mcpEndpoint: string;
    };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBeTruthy();
    // Common read tool present.
    const names = body.tools.map((tool) => tool.name);
    expect(names).toContain('ide_search');
    // The full IDE allowlist is advertised (including ide_command); whether
    // it can actually be invoked still depends on the allowDangerous flag
    // enforced inside the MCP profile guard — the debug bootstrap response
    // just mirrors that policy, not a separate gate.
    expect(names).toContain('ide_command');
  });

  it('GET /debug/omni/search delegates to ide.search', async () => {
    const { bridge, tokenStore, ide } = setup();
    const t = tokenStore.mintDebugToken(60_000);
    const r = makeRes();
    await bridge.handle(makeReq('GET', `/debug/omni/search?token=${t.token}&q=createIdeServer`), r.res);
    expect(r.getStatus()).toBe(200);
    expect(ide.search).toHaveBeenCalledWith('/repo', 'createIdeServer', expect.any(Object));
  });

  it('GET /debug/omni/read refuses a path outside the workspace root', async () => {
    const { bridge, tokenStore, ide } = setup();
    const t = tokenStore.mintDebugToken(60_000);
    const r = makeRes();
    await bridge.handle(
      makeReq('GET', `/debug/omni/read?token=${t.token}&path=${encodeURIComponent('/etc/passwd')}`),
      r.res
    );
    expect(r.getStatus()).toBe(403);
    expect(ide.readFile).not.toHaveBeenCalled();
  });

  it('GET /debug/omni/read serves a file inside the workspace root', async () => {
    const { bridge, tokenStore, ide } = setup();
    const t = tokenStore.mintDebugToken(60_000);
    const r = makeRes();
    await bridge.handle(
      makeReq('GET', `/debug/omni/read?token=${t.token}&path=${encodeURIComponent('/repo/src/x.ts')}`),
      r.res
    );
    expect(r.getStatus()).toBe(200);
    expect(ide.readFile).toHaveBeenCalled();
  });

  it('returns 404 on an unknown sub-route', async () => {
    const { bridge, tokenStore } = setup();
    const t = tokenStore.mintDebugToken(60_000);
    const r = makeRes();
    await bridge.handle(makeReq('GET', `/debug/omni/nope?token=${t.token}`), r.res);
    expect(r.getStatus()).toBe(404);
  });

  it('does not expose any mutate/terminal endpoint name', async () => {
    const { bridge, tokenStore, ide } = setup();
    const t = tokenStore.mintDebugToken(60_000);
    for (const route of ['ide_command', 'team_write_file', 'db_query', 'ide_memory_set_secret']) {
      const r = makeRes();
      await bridge.handle(makeReq('GET', `/debug/omni/${route}?token=${t.token}`), r.res);
      expect(r.getStatus()).toBe(404);
    }
    expect(ide.runCommand).not.toHaveBeenCalled();
  });
});
