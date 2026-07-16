/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process MCP host for the Browser-Control server — the "cây cầu" that lets
 * an agent (e.g. Claude Code over ACP) drive the **live** embedded browser.
 *
 * ## Why an in-process HTTP/SSE host (not a stdio child)
 *
 * The Browser-Control tools operate on `WebContentsView` instances that only
 * exist **in the Main process**. So, unlike the stdio built-in servers
 * (image-gen / resource / company), this server cannot run in a separate `node`
 * child process. The Testing MCP already faced — and solved — exactly this:
 * host the `McpServer` in the Main process on a **loopback HTTP server** using
 * the MCP SDK's {@link SSEServerTransport}, then register it in the MCP catalog
 * as an `sse` server pointing at that loopback URL. aioncore (the MCP client)
 * connects over SSE like any remote MCP server. This module mirrors
 * `process/testing/testingMcpHost.ts` 1:1.
 *
 * Each SSE connection gets its own transport + a fresh {@link McpServer} bound
 * to the **same** browser services, so concurrent agent connections are
 * isolated at the transport level while driving the one shared browser.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createBrowserControlServer,
  BUILTIN_BROWSER_CONTROL_NAME,
  type BrowserControlDeps,
} from '../resources/builtinMcp/browserControlServer';

/** Path the SSE stream is established on (GET). */
const SSE_PATH = '/sse';

/** Path clients POST JSON-RPC messages to (POST), with `?sessionId=`. */
const MESSAGE_PATH = '/message';

/** A running in-process Browser-Control MCP host. */
export type BrowserControlMcpHost = {
  /** The loopback base URL of the SSE endpoint (e.g. `http://127.0.0.1:51234/sse`). */
  url: string;
  /** The port the loopback server listens on. */
  port: number;
  /** Stop the host and close all connections. */
  close: () => Promise<void>;
};

/** Module-level singleton so repeated bootstraps reuse one host. */
let host: BrowserControlMcpHost | undefined;

/**
 * Start (once) the in-process Browser-Control MCP host bound to the shared
 * browser services. Binds to an ephemeral loopback port.
 *
 * @param deps The browser services every connection's MCP server drives.
 * @returns The running host (url + port + close), reused on subsequent calls.
 */
export const startBrowserControlMcpHost = async (deps: BrowserControlDeps): Promise<BrowserControlMcpHost> => {
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
      const mcp: McpServer = createBrowserControlServer(deps);
      try {
        await mcp.connect(transport);
      } catch (error) {
        transports.delete(transport.sessionId);
        console.error('[BrowserControlMCP] Failed to connect SSE transport:', error);
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
      else reject(new Error('[BrowserControlMCP] Could not resolve the loopback port.'));
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
  console.log(
    `[BrowserControlMCP] In-process MCP host listening on ${host.url} (server: ${BUILTIN_BROWSER_CONTROL_NAME}).`
  );
  return host;
};

/** Return the running host, if started. */
export const getBrowserControlMcpHost = (): BrowserControlMcpHost | undefined => host;

/** Stop the host (deterministic teardown). */
export const stopBrowserControlMcpHost = async (): Promise<void> => {
  if (!host) return;
  await host.close();
  host = undefined;
};
