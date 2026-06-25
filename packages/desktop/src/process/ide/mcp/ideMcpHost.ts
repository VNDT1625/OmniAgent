/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process MCP host for the IDE server — the bridge that lets an agent (a
 * company role, Claude Code over ACP, aionrs, …) use the IDE / repo-intelligence
 * tools (list/read/search/find-definition/find-references/scan-repo).
 *
 * ## Why an in-process HTTP/SSE host (not a stdio child)
 *
 * The IDE service walks arbitrary folders with Node `fs` and reuses live
 * Main-process helpers. Like the Cron / Testing / Browser-Control hosts, it runs
 * the `McpServer` in the Main process on a loopback HTTP server using the MCP
 * SDK's {@link SSEServerTransport} and registers it in the catalog as an `sse`
 * server. This module mirrors `process/cron/cronMcpHost.ts` 1:1.
 *
 * Each SSE connection gets its own transport + a fresh {@link McpServer} bound to
 * the same fs-backed IDE service, so concurrent agent connections are isolated
 * at the transport level.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildIdeServer } from './ideMcpWiring';
import { BUILTIN_IDE_NAME } from './ideServer';

/** Path the SSE stream is established on (GET). */
const SSE_PATH = '/sse';

/** Path clients POST JSON-RPC messages to (POST), with `?sessionId=`. */
const MESSAGE_PATH = '/message';

/** A running in-process IDE MCP host. */
export type IdeMcpHost = {
  /** The loopback base URL of the SSE endpoint. */
  url: string;
  /** The port the loopback server listens on. */
  port: number;
  /** Stop the host and close all connections. */
  close: () => Promise<void>;
};

/** Module-level singleton so repeated bootstraps reuse one host. */
let host: IdeMcpHost | undefined;

/**
 * Start (once) the in-process IDE MCP host. Binds to an ephemeral loopback port.
 *
 * @returns The running host (url + port + close), reused on subsequent calls.
 */
export const startIdeMcpHost = async (): Promise<IdeMcpHost> => {
  if (host) return host;

  /** Active transports keyed by their session id, for routing POSTed messages. */
  const transports = new Map<string, SSEServerTransport>();

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // GET /sse → open a new SSE stream + MCP server for this client.
    if (req.method === 'GET' && url.pathname === SSE_PATH) {
      const transport = new SSEServerTransport(MESSAGE_PATH, res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };
      const mcp: McpServer = buildIdeServer();
      try {
        await mcp.connect(transport);
      } catch (error) {
        transports.delete(transport.sessionId);
        console.error('[IdeMCP] Failed to connect SSE transport:', error);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }

    // POST /message?sessionId=... → deliver a JSON-RPC message to that session.
    if (req.method === 'POST' && url.pathname === MESSAGE_PATH) {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404).end('No active session for the given sessionId.');
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404).end();
  };

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('[IdeMCP] Could not resolve the loopback port.'));
    });
  });

  host = {
    url: `http://127.0.0.1:${port}${SSE_PATH}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const transport of transports.values()) void transport.close();
        transports.clear();
        server.close(() => resolve());
      }),
  };
  console.log(`[IdeMCP] In-process MCP host listening on ${host.url} (server: ${BUILTIN_IDE_NAME}).`);
  return host;
};

/** Return the running host, if started. */
export const getIdeMcpHost = (): IdeMcpHost | undefined => host;

/** Stop the host (deterministic teardown). */
export const stopIdeMcpHost = async (): Promise<void> => {
  if (!host) return;
  await host.close();
  host = undefined;
};
