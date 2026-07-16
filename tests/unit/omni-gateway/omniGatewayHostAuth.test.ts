/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * HTTP-level tests for the gateway host's multi-mode auth gate. We start a real
 * loopback host with a fake MCP server factory and assert which requests are
 * rejected with 401 vs. accepted (any non-401 status) under each auth mode:
 *   - the LOCAL bearer is ALWAYS accepted (never broken by Web mode),
 *   - `bearer` accepts the external token only,
 *   - `none` accepts everything,
 *   - `oauth` accepts a valid OAuth token only,
 *   - `mixed` accepts either,
 *   - the OAuth/discovery handler is mounted ahead of the auth gate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startOmniGatewayHost, type OmniGatewayHost } from '@/process/omni-gateway/omniGatewayHost';
import type { OmniAuthMode } from '@/process/omni-gateway/auth/authTypes';

const LOCAL = 'local-bearer-token';
const EXTERNAL = 'external-bearer-token';
const OAUTH = 'oauth-access-token';

type GatewayResponse = { code: number; headers: http.IncomingHttpHeaders };

/** Minimal MCP server so the host can build a session if auth passes. */
const buildServer = (): McpServer => new McpServer({ name: 'test', version: '1.0.0' });

type Hosted = { host: OmniGatewayHost; port: number };

let current: Hosted | undefined;

const start = async (opts: {
  mode: OmniAuthMode;
  withOAuth?: boolean;
  oauthHandlerConsumes?: boolean;
}): Promise<Hosted> => {
  const host = await startOmniGatewayHost({
    port: 0,
    localBearerToken: LOCAL,
    isExternalBearerValid: (p) => p === EXTERNAL,
    getAuthMode: () => opts.mode,
    isOAuthTokenValid: async (p) => p === OAUTH,
    oauthHandler: opts.withOAuth
      ? async (req, res) => {
          if (req.url?.startsWith('/.well-known/') || req.url?.startsWith('/oauth/')) {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
            return true;
          }
          return false;
        }
      : undefined,
    buildIdeServer: () => buildServer(),
  });
  current = { host, port: host.port };
  return current;
};

/** POST /ide/mcp with an optional bearer; returns the HTTP status code. */
const postMcp = (port: number, bearer?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/ide/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      }
    );
    req.on('error', reject);
    req.end(body);
  });

const postMcpWithHeaders = (port: number, bearer?: string): Promise<GatewayResponse> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/ide/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ code: res.statusCode ?? 0, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });

const optionsMcp = (port: number): Promise<GatewayResponse> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/ide/mcp',
        method: 'OPTIONS',
        headers: {
          origin: 'https://chat.openai.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type,mcp-session-id,mcp-protocol-version',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ code: res.statusCode ?? 0, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });

const getPath = (port: number, path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });

afterEach(async () => {
  await current?.host.close();
  current = undefined;
  vi.restoreAllMocks();
});

describe('omniGatewayHost — multi-mode auth gate', () => {
  it('LOCAL bearer is accepted in every mode', async () => {
    for (const mode of ['bearer', 'oauth', 'mixed', 'none'] as OmniAuthMode[]) {
      const { port, host } = await start({ mode });
      expect(await postMcp(port, LOCAL)).not.toBe(401);
      await host.close();
      current = undefined;
    }
  });

  it('bearer mode: external token passes, unknown is 401', async () => {
    const { port } = await start({ mode: 'bearer' });
    expect(await postMcp(port, EXTERNAL)).not.toBe(401);
    expect(await postMcp(port, 'garbage')).toBe(401);
    expect(await postMcp(port, undefined)).toBe(401);
  });

  it('none mode: every request is accepted even without a bearer', async () => {
    const { port } = await start({ mode: 'none' });
    expect(await postMcp(port, undefined)).not.toBe(401);
    expect(await postMcp(port, 'whatever')).not.toBe(401);
  });

  it('oauth mode: only a valid OAuth token passes; the external bearer does NOT', async () => {
    const { port } = await start({ mode: 'oauth' });
    expect(await postMcp(port, OAUTH)).not.toBe(401);
    expect(await postMcp(port, EXTERNAL)).toBe(401);
    expect(await postMcp(port, undefined)).toBe(401);
  });

  it('mixed mode: both an OAuth token and the external bearer pass', async () => {
    const { port } = await start({ mode: 'mixed' });
    expect(await postMcp(port, OAUTH)).not.toBe(401);
    expect(await postMcp(port, EXTERNAL)).not.toBe(401);
    expect(await postMcp(port, 'nope')).toBe(401);
  });

  it('401 in oauth mode carries a WWW-Authenticate resource_metadata hint', async () => {
    const { port } = await start({ mode: 'oauth' });
    const status = await new Promise<{ code: number; header?: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/ide/mcp', method: 'POST', headers: { host: '127.0.0.1' } },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({ code: res.statusCode ?? 0, header: res.headers['www-authenticate'] as string | undefined })
          );
        }
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status.code).toBe(401);
    expect(status.header).toContain('resource_metadata');
  });

  it('allows browser preflight on /ide/mcp before the auth gate', async () => {
    const { port } = await start({ mode: 'oauth' });
    const response = await optionsMcp(port);
    expect(response.code).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(String(response.headers['access-control-allow-headers'])).toContain('authorization');
    expect(String(response.headers['access-control-allow-headers'])).toContain('mcp-session-id');
    expect(String(response.headers['access-control-expose-headers'])).toContain('mcp-session-id');
  });

  it('keeps CORS headers on /ide/mcp auth failures', async () => {
    const { port } = await start({ mode: 'bearer' });
    const response = await postMcpWithHeaders(port);
    expect(response.code).toBe(401);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(String(response.headers['access-control-expose-headers'])).toContain('mcp-session-id');
  });

  it('mounts the OAuth/discovery handler ahead of the auth gate', async () => {
    const { port } = await start({ mode: 'oauth', withOAuth: true });
    // Discovery is reachable WITHOUT any bearer.
    expect(await getPath(port, '/.well-known/oauth-authorization-server')).toBe(200);
    expect(await getPath(port, '/oauth/anything')).toBe(200);
  });
});
