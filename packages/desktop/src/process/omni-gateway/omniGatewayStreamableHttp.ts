/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streamable HTTP transport adapter for the Omni External MCP Gateway.
 *
 * MCP 2025-03 introduced a new transport ("Streamable HTTP") that uses HTTP
 * POST for client→server messages and SERVER-CHOSEN streaming for server→
 * client (the server may upgrade to SSE on a GET, or just return JSON on POST).
 * Unlike pure SSE — which Cloudflare Quick Tunnels DO NOT proxy reliably — the
 * Streamable HTTP path-pair {POST /mcp, GET /mcp, DELETE /mcp} survives a
 * standard HTTP proxy. So this is what an EXTERNAL host (ChatGPT/Grok with an
 * MCP connector) should connect to.
 *
 * This module manages one in-RAM map of `sessionId → StreamableHTTPServerTransport`
 * so the host can route POST/GET/DELETE back to the right per-connection
 * MCP server. The Mcp server itself is built ONCE per session (when the
 * client's `initialize` POST arrives) and shared across the subsequent GET
 * (notifications) + DELETE (close).
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** HTTP header carrying the MCP session id (per MCP Streamable HTTP spec). */
const MCP_SESSION_HEADER = 'mcp-session-id';

/** A registered live Streamable HTTP session. */
type ActiveSession = {
  transport: StreamableHTTPServerTransport;
  mcp: McpServer;
};

/** Inputs to {@link createStreamableHttpRouter}. */
export type StreamableHttpRouterInput<TContext> = {
  /** Build a fresh per-session McpServer (the gateway profile factory). */
  buildMcpServer: (context: TContext) => McpServer;
};

/** A small router that handles {POST,GET,DELETE} for a single MCP endpoint. */
export type StreamableHttpRouter<TContext> = {
  /** Dispatch an HTTP request to the right session. Returns void on success. */
  handleRequest: (req: IncomingMessage, res: ServerResponse, context: TContext, parsedBody?: unknown) => Promise<void>;
  /** Close every live session (graceful shutdown). */
  closeAll: () => Promise<void>;
  /** Snapshot of live session ids (introspection only). */
  liveSessionIds: () => string[];
};

/**
 * Read the request body once into a JSON-RPC payload. The SDK's
 * `handleRequest` accepts a pre-parsed body for POST so we don't double-read
 * the stream.
 */
const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text.length > 0 ? JSON.parse(text) : undefined);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on('error', reject);
  });

/** Quick check of a parsed JSON-RPC payload: is this an `initialize` request? */
const isInitializeRequest = (body: unknown): boolean => {
  if (!body || typeof body !== 'object') return false;
  const msg = body as { method?: unknown };
  return msg.method === 'initialize';
};

/** Build a router that owns one map of live sessions for a single MCP endpoint. */
export const createStreamableHttpRouter = <TContext>(
  input: StreamableHttpRouterInput<TContext>
): StreamableHttpRouter<TContext> => {
  const sessions = new Map<string, ActiveSession>();

  const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    context: TContext,
    parsedBody?: unknown
  ): Promise<void> => {
    const method = req.method?.toUpperCase() ?? 'GET';
    const headerSessionId = req.headers[MCP_SESSION_HEADER];
    const sessionId = typeof headerSessionId === 'string' ? headerSessionId : undefined;

    // GET (server→client stream) and DELETE (session close) require an existing session.
    if (method === 'GET' || method === 'DELETE') {
      if (!sessionId) {
        sendJson(res, 400, { error: 'Missing mcp-session-id header.' });
        return;
      }
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, { error: 'Unknown sessionId.' });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    if (method !== 'POST') {
      sendJson(res, 405, { error: `Method ${method} not allowed.` });
      return;
    }

    // Pre-read the JSON body when the caller didn't already parse one (the
    // gateway host parses bodies upstream only for the debug bridge; for
    // /ide/mcp we read here).
    const body = parsedBody ?? (await readJsonBody(req).catch((): undefined => undefined));

    if (sessionId) {
      // Subsequent message on an existing session.
      const session = sessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, { error: 'Unknown sessionId — call initialize again.' });
        return;
      }
      await session.transport.handleRequest(req, res, body);
      return;
    }

    // No sessionId yet → must be the initialize request.
    if (!isInitializeRequest(body)) {
      sendJson(res, 400, { error: 'No sessionId — first POST must be an MCP "initialize" request.' });
      return;
    }

    // Build a brand new transport + Mcp server. The SDK generates a sessionId
    // for us; we record it as soon as the transport reports it.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    const mcp = input.buildMcpServer(context);
    try {
      await mcp.connect(transport);
    } catch (error) {
      console.error('[OmniGateway/StreamableHttp] mcp.connect failed:', error);
      sendJson(res, 500, { error: 'Failed to start MCP session.' });
      return;
    }
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    await transport.handleRequest(req, res, body);

    const newSessionId = transport.sessionId;
    if (newSessionId) sessions.set(newSessionId, { transport, mcp });
  };

  const closeAll = async (): Promise<void> => {
    const all = Array.from(sessions.values());
    sessions.clear();
    await Promise.all(
      all.map(async (s) => {
        try {
          await s.transport.close();
        } catch (error) {
          console.warn('[OmniGateway/StreamableHttp] Error closing session:', error);
        }
      })
    );
  };

  return {
    handleRequest,
    closeAll,
    liveSessionIds: () => Array.from(sessions.keys()),
  };
};
