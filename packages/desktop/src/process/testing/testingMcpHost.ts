/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process host for the Testing MCP server (Yêu cầu 2b — Agent plane, Task
 * 15.1).
 *
 * Unlike the standalone stdio servers (`imageGenServer`, `resourceServer`,
 * `companyServer`), the Testing MCP server drives a **live Main-process
 * singleton** ({@link ITestOrchestrator}, which owns `WebContentsView` test
 * tabs). It therefore cannot run in a separate `node` process. Instead we host
 * it **in the Main process** on a loopback HTTP server using the MCP SDK's
 * dependency-free {@link SSEServerTransport}, and register it in the MCP catalog
 * as an `sse` server pointing at the loopback URL — so aioncore's agent reaches
 * it like any other MCP server (the design's "Agent plane").
 *
 * Both planes (this MCP host + the `testingBridge` UI plane) share the SAME
 * orchestrator instance, so an agent-run session shows up in the Testing page
 * and vice-versa (single source of truth).
 *
 * Security: the server binds to `127.0.0.1` only (loopback), so it is not
 * reachable off-host. It carries no auth because it never leaves the local
 * machine and exposes only the local testing capability.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTestingServer } from '../resources/builtinMcp/testingServer';
import { BUILTIN_TESTING_NAME } from '../resources/builtinMcp/testingServer';
import type { ITestOrchestrator } from './testOrchestrator';

/** Path the SSE stream is established on (GET). */
const SSE_PATH = '/sse';

/** Path clients POST JSON-RPC messages to (POST), with `?sessionId=`. */
const MESSAGE_PATH = '/message';

/** A running in-process MCP host. */
export type TestingMcpHost = {
  /** The loopback base URL of the SSE endpoint (e.g. `http://127.0.0.1:51234/sse`). */
  url: string;
  /** The port the loopback server listens on. */
  port: number;
  /** Stop the host and close all connections. */
  close: () => Promise<void>;
};

/** Module-level singleton so repeated bootstraps reuse one host. */
let host: TestingMcpHost | undefined;

/**
 * Start (once) the in-process Testing MCP host bound to the shared orchestrator.
 *
 * The HTTP server binds to an ephemeral loopback port. Each SSE connection gets
 * its own {@link SSEServerTransport} + a fresh {@link McpServer} bound to the
 * same orchestrator, so concurrent agent connections are isolated at the
 * transport level while sharing test state.
 *
 * @param orchestrator The shared test orchestrator both planes drive.
 * @returns The running host (url + port + close), reused on subsequent calls.
 */
export const startTestingMcpHost = async (orchestrator: ITestOrchestrator): Promise<TestingMcpHost> => {
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
      const mcp: McpServer = createTestingServer({ orchestrator });
      try {
        await mcp.connect(transport);
      } catch (error) {
        transports.delete(transport.sessionId);
        console.error('[TestingMCP] Failed to connect SSE transport:', error);
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
      else reject(new Error('[TestingMCP] Could not resolve the loopback port.'));
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
  console.log(`[TestingMCP] In-process MCP host listening on ${host.url} (server: ${BUILTIN_TESTING_NAME}).`);
  return host;
};

/** Return the running host, if started. */
export const getTestingMcpHost = (): TestingMcpHost | undefined => host;

/** Stop the host (deterministic teardown). */
export const stopTestingMcpHost = async (): Promise<void> => {
  if (!host) return;
  await host.close();
  host = undefined;
};
