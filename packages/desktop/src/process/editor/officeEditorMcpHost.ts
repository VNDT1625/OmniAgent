/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process MCP host for the Office-editor server — lets a CLI agent edit the
 * LIVE Studio document as MCP tools.
 *
 * Mirrors `process/automation/automationMcpHost.ts` 1:1: an SSE-over-loopback
 * host so the server can reach live Main-process state (here: the editor-tools
 * bridge that drives the renderer's ONLYOFFICE editor) that a stdio child could
 * not. Each SSE connection gets its own transport + a fresh server bound to the
 * same deps.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  BUILTIN_OFFICE_EDITOR_NAME,
  createOfficeEditorServer,
  type OfficeEditorServerDeps,
} from '../resources/builtinMcp/officeEditorServer';

const SSE_PATH = '/sse';
const MESSAGE_PATH = '/message';

/** A running in-process Office-editor MCP host. */
export type OfficeEditorMcpHost = {
  /** The loopback base URL of the SSE endpoint. */
  url: string;
  /** The port the loopback server listens on. */
  port: number;
  /** Stop the host and close all connections. */
  close: () => Promise<void>;
};

let host: OfficeEditorMcpHost | undefined;

/**
 * Start (once) the in-process Office-editor MCP host bound to the injected deps.
 * Binds to an ephemeral loopback port.
 */
export const startOfficeEditorMcpHost = async (deps: OfficeEditorServerDeps): Promise<OfficeEditorMcpHost> => {
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
      const mcp: McpServer = createOfficeEditorServer(deps);
      try {
        await mcp.connect(transport);
      } catch (error) {
        transports.delete(transport.sessionId);
        console.error('[OfficeEditorMCP] Failed to connect SSE transport:', error);
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
      else reject(new Error('[OfficeEditorMCP] Could not resolve the loopback port.'));
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
    `[OfficeEditorMCP] In-process MCP host listening on ${host.url} (server: ${BUILTIN_OFFICE_EDITOR_NAME}).`
  );
  return host;
};

/** Return the running host, if started. */
export const getOfficeEditorMcpHost = (): OfficeEditorMcpHost | undefined => host;

/** Stop the host (deterministic teardown). */
export const stopOfficeEditorMcpHost = async (): Promise<void> => {
  if (!host) return;
  await host.close();
  host = undefined;
};
