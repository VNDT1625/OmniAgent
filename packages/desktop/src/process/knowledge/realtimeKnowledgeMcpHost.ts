/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process MCP host for the Realtime Knowledge server.
 *
 * Mirrors `process/editor/officeEditorMcpHost.ts`: an SSE-over-loopback host so
 * the server can reach the live Main-process RTK service singleton (store +
 * vector index) that a stdio child could not. Each SSE connection gets its own
 * transport + a fresh server bound to the same deps.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BUILTIN_REALTIME_KNOWLEDGE_NAME,
  createRealtimeKnowledgeServer,
  type RealtimeKnowledgeServerDeps,
} from '../resources/builtinMcp/realtimeKnowledgeServer';

const SSE_PATH = '/sse';
const MESSAGE_PATH = '/message';

/** A running in-process Realtime Knowledge MCP host. */
export type RealtimeKnowledgeMcpHost = {
  /** The loopback base URL of the SSE endpoint. */
  url: string;
  /** The port the loopback server listens on. */
  port: number;
  /** Stop the host and close all connections. */
  close: () => Promise<void>;
};

let host: RealtimeKnowledgeMcpHost | undefined;

/**
 * Start (once) the in-process Realtime Knowledge MCP host bound to the injected
 * deps. Binds to an ephemeral loopback port.
 */
export const startRealtimeKnowledgeMcpHost = async (
  deps: RealtimeKnowledgeServerDeps
): Promise<RealtimeKnowledgeMcpHost> => {
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
      const mcp: McpServer = createRealtimeKnowledgeServer(deps);
      try {
        await mcp.connect(transport);
      } catch (error) {
        transports.delete(transport.sessionId);
        console.error('[RealtimeKnowledgeMCP] Failed to connect SSE transport:', error);
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
      else reject(new Error('[RealtimeKnowledgeMCP] Could not resolve the loopback port.'));
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
    `[RealtimeKnowledgeMCP] In-process MCP host listening on ${host.url} (server: ${BUILTIN_REALTIME_KNOWLEDGE_NAME}).`
  );
  return host;
};

/** Return the running host, if started. */
export const getRealtimeKnowledgeMcpHost = (): RealtimeKnowledgeMcpHost | undefined => host;

/** Stop the host (deterministic teardown). */
export const stopRealtimeKnowledgeMcpHost = async (): Promise<void> => {
  if (!host) return;
  await host.close();
  host = undefined;
};
