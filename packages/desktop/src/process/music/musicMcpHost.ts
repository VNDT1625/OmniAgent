/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-process MCP host for the Music server — lets an agent make music as MCP
 * tools (set tempo, add tracks, program beats, listen to audio, comp chords).
 *
 * Mirrors `process/automation/automationMcpHost.ts` 1:1: an SSE-over-loopback
 * host so the server can reach live Main-process state (the shared music repo +
 * active project) that a stdio child process could not.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMusicServer, BUILTIN_MUSIC_NAME, type MusicServerDeps } from './musicMcpServer';

const SSE_PATH = '/sse';
const MESSAGE_PATH = '/message';

export type MusicMcpHost = {
  url: string;
  port: number;
  close: () => Promise<void>;
};

let host: MusicMcpHost | undefined;

export const startMusicMcpHost = async (deps: MusicServerDeps): Promise<MusicMcpHost> => {
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
      const mcp: McpServer = createMusicServer(deps);
      try {
        await mcp.connect(transport);
      } catch (error) {
        transports.delete(transport.sessionId);
        console.error('[MusicMCP] Failed to connect SSE transport:', error);
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
      else reject(new Error('[MusicMCP] Could not resolve the loopback port.'));
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
  console.log(`[MusicMCP] In-process MCP host listening on ${host.url} (server: ${BUILTIN_MUSIC_NAME}).`);
  return host;
};

export const getMusicMcpHost = (): MusicMcpHost | undefined => host;

export const stopMusicMcpHost = async (): Promise<void> => {
  if (!host) return;
  await host.close();
  host = undefined;
};
