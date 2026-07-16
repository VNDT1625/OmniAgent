/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process MCP host for the Automation server — lets an agent create, run,
 * and manage n8n-style workflows as MCP tools.
 *
 * Mirrors `process/cron/cronMcpHost.ts` 1:1: an SSE-over-loopback host so the
 * server can reach live Main-process state (the shared automation store +
 * engine) that a stdio child process could not. Each SSE connection gets its
 * own transport + a fresh {@link McpServer} bound to the same Automation deps.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAutomationServer, type AutomationServerDeps } from './automationMcpServer';
import { BUILTIN_AUTOMATION_NAME } from './automationMcpServer';

const SSE_PATH = '/sse';
const MESSAGE_PATH = '/message';

/** A running in-process Automation MCP host. */
export type AutomationMcpHost = {
  /** The loopback base URL of the SSE endpoint. */
  url: string;
  /** The port the loopback server listens on. */
  port: number;
  /** Stop the host and close all connections. */
  close: () => Promise<void>;
};

let host: AutomationMcpHost | undefined;

/**
 * Start (once) the in-process Automation MCP host bound to the shared services.
 * Binds to an ephemeral loopback port.
 */
export const startAutomationMcpHost = async (deps: AutomationServerDeps): Promise<AutomationMcpHost> => {
  if (host) return host;

  const transports = new Map<string, SSEServerTransport>();

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname === SSE_PATH) {
      const transport = new SSEServerTransport(MESSAGE_PATH, res);
      transports.set(transport.sessionId, transport);
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };
      const mcp: McpServer = createAutomationServer(deps);
      try {
        await mcp.connect(transport);
      } catch (error) {
        transports.delete(transport.sessionId);
        console.error('[AutomationMCP] Failed to connect SSE transport:', error);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }

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
      else reject(new Error('[AutomationMCP] Could not resolve the loopback port.'));
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
  console.log(`[AutomationMCP] In-process MCP host listening on ${host.url} (server: ${BUILTIN_AUTOMATION_NAME}).`);
  return host;
};

/** Return the running host, if started. */
export const getAutomationMcpHost = (): AutomationMcpHost | undefined => host;

/** Stop the host (deterministic teardown). */
export const stopAutomationMcpHost = async (): Promise<void> => {
  if (!host) return;
  await host.close();
  host = undefined;
};
