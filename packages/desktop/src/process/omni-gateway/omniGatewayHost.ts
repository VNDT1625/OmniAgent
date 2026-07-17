/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Omni External MCP Gateway host — a fixed-port loopback HTTP+SSE server
 * that fronts the internal `aionui-ide` MCP server for EXTERNAL AI hosts
 * (Claude Desktop, Cursor, ChatGPT). Mirrors the in-process pattern used by
 * `ideMcpHost.ts` / `cronMcpHost.ts` but adds two MVP guardrails:
 *
 * 1. **Bearer-token auth** — every request must carry an `Authorization:
 *    Bearer <token>` header that matches the user-rotatable token kept in the
 *    encrypted credential store. Bad/missing tokens fail with HTTP 401 BEFORE
 *    a transport is opened.
 * 2. **Path-based profile routing** — `/ide/sse` opens an SSE stream for the
 *    IDE profile, `/ide/message?sessionId=…` delivers JSON-RPC messages. The
 *    path namespace is reserved so future profiles (`/music/sse`,
 *    `/browser/sse`) can plug in without breaking existing clients.
 *
 * Process boundary: Main-process (Node.js / Electron). No DOM APIs.
 */

import { timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createStreamableHttpRouter, type StreamableHttpRouter } from './omniGatewayStreamableHttp';
import type { OmniAuthMode } from './auth/authTypes';

/**
 * The two request planes a single gateway host serves, distinguished by which
 * token authorised the request. The MCP server factory uses this to pick the
 * right allowlist (tighter on `external`).
 */
export type OmniRequestMode = 'local' | 'external';

/** Optional debug-bridge handler (read-only GET endpoints under /debug/omni). */
export type DebugBridgeHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

/** A running Omni Gateway host instance. */
export type OmniGatewayHost = {
  /** Loopback URL of the IDE SSE endpoint (local only — SSE is not tunnel-safe). */
  ideSseUrl: string;
  /** Loopback URL of the IDE Streamable HTTP endpoint (tunnel-safe). */
  ideMcpUrl: string;
  /** The bound port. */
  port: number;
  /** Gracefully stop the host and close every open transport. */
  close: () => Promise<void>;
};

/** Inputs for {@link startOmniGatewayHost}. */
export type StartOmniGatewayHostInput = {
  /** Loopback port to bind (validated 1024–65535 upstream). */
  port: number;
  /** Bearer token accepted on `/ide/*` for LOCAL clients (Cursor / Claude Desktop). */
  localBearerToken: string;
  /**
   * Dynamic validator for the EXTERNAL bearer (short-TTL token issued by the
   * External Test Mode token store). Returning false rejects the request as
   * 401. When the user revokes/rotates the external token, the validator
   * starts returning false immediately — no host restart needed.
   */
  isExternalBearerValid?: (presented: string) => boolean;
  /** Factory called for each new MCP session — receives the auth mode it should serve. */
  buildIdeServer: (mode: OmniRequestMode) => McpServer;
  /**
   * Optional handler for the read-only `/debug/omni/*` URL-token bridge.
   * Mounted when External Test Mode is on; left undefined otherwise.
   */
  debugBridge?: DebugBridgeHandler;
  /**
   * The CONFIGURED Web Access auth mode. Governs how `/ide/*` requests that do
   * NOT carry the local bearer are authorised:
   *  - `bearer` (default) — only the external Bearer token is accepted.
   *  - `oauth`            — only a valid OAuth access token is accepted.
   *  - `mixed`            — either an OAuth access token OR the Bearer token.
   *  - `none`             — legacy value, hardened to the short-TTL external bearer.
   *
   * The LOCAL bearer (`localBearerToken`) is ALWAYS accepted regardless of mode
   * so first-party clients (Claude Desktop / Cursor) never break.
   */
  getAuthMode?: () => OmniAuthMode;
  /**
   * Validate a presented OAuth access token. Used in `oauth`/`mixed` modes.
   * Returns true when the token is live. Async because validation reads the
   * encrypted token store.
   */
  isOAuthTokenValid?: (presented: string) => Promise<boolean>;
  /**
   * Optional OAuth/discovery request handler mounted ahead of the `/ide/*`
   * auth gate. Returns true when it consumed the request (discovery, /authorize,
   * /token, /register, /revoke). Always mounted when Web Access is on so a
   * client can complete the OAuth dance even before it holds a token.
   */
  oauthHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  /** Browser origins allowed to call the gateway. Requests without Origin (native MCP clients) remain supported. */
  isOriginAllowed?: (origin: string) => boolean;
};

/** SSE stream path for the IDE profile (local clients only). */
const IDE_SSE_PATH = '/ide/sse';

/** JSON-RPC message path for the IDE SSE profile (sessionId on querystring). */
const IDE_SSE_MESSAGE_PATH = '/ide/message';

/** Streamable HTTP path for the IDE profile (local + tunnel-safe). */
const IDE_MCP_PATH = '/ide/mcp';

/** Prefix reserved for the read-only debug bridge URLs. */
const DEBUG_PREFIX = '/debug/omni';
const MCP_CORS_HEADERS: http.OutgoingHttpHeaders = {
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
  'access-control-allow-headers': 'authorization,content-type,mcp-session-id,mcp-protocol-version',
  'access-control-expose-headers': 'mcp-session-id',
  vary: 'Origin',
};

const applyMcpCorsHeaders = (res: http.ServerResponse, origin?: string): void => {
  for (const [key, value] of Object.entries(MCP_CORS_HEADERS)) {
    res.setHeader(key, value);
  }
  if (origin) res.setHeader('access-control-allow-origin', origin);
};

const bearerMatches = (presented: string, expected: string): boolean => {
  if (!presented || !expected) return false;
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};

/** A typed error the registrar surfaces to the Settings UI on port conflict. */
export class OmniGatewayAddressInUseError extends Error {
  constructor(public readonly port: number) {
    super(`Port ${port} is already in use.`);
    this.name = 'OmniGatewayAddressInUseError';
  }
}

/**
 * Start the gateway host on `127.0.0.1:<port>` and return a handle. Throws
 * {@link OmniGatewayAddressInUseError} when the port is occupied (callers can
 * surface a banner in Settings).
 */
export const startOmniGatewayHost = async (input: StartOmniGatewayHostInput): Promise<OmniGatewayHost> => {
  const sseTransports = new Map<string, SSEServerTransport>();

  /**
   * Identify the auth mode of an incoming `/ide/*` request, or null when the
   * bearer is missing / does not match. Local clients (Cursor / Claude
   * Desktop) present the long-lived local token; external clients (ChatGPT
   * via cloudflared) present the short-TTL external token, when configured.
   */
  /**
   * Identify the auth mode of an incoming `/ide/*` request, or null when the
   * request is not authorised. The LOCAL bearer is always accepted. Beyond
   * that, the CONFIGURED Web Access auth mode decides:
   *  - `none`   → require the short-TTL external bearer (legacy compatibility).
   *  - `bearer` → accept the external Bearer token (legacy behaviour).
   *  - `oauth`  → accept a valid OAuth access token.
   *  - `mixed`  → accept either an OAuth access token or the Bearer token.
   */
  const authMode = async (req: http.IncomingMessage): Promise<OmniRequestMode | null> => {
    const header = req.headers['authorization'];
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

    // Local first-party clients are ALWAYS accepted — never broken by Web mode.
    if (bearerMatches(presented, input.localBearerToken)) return 'local';

    const mode: OmniAuthMode = input.getAuthMode?.() ?? 'bearer';
    const bearerOk = (): boolean => presented.length > 0 && input.isExternalBearerValid?.(presented) === true;

    // Legacy none remains loadable for settings compatibility, but the core
    // never disables authentication. It is hardened to the short-TTL bearer.
    if (mode === 'none') return bearerOk() ? 'external' : null;
    const oauthOk = async (): Promise<boolean> =>
      presented.length > 0 && input.isOAuthTokenValid !== undefined && (await input.isOAuthTokenValid(presented));

    if (mode === 'bearer') return bearerOk() ? 'external' : null;
    if (mode === 'oauth') return (await oauthOk()) ? 'external' : null;
    // mixed
    if (bearerOk()) return 'external';
    return (await oauthOk()) ? 'external' : null;
  };

  // Streamable HTTP router for /ide/mcp. Each new session builds an MCP server
  // tagged with the request mode that authorised the initialize call.
  const mcpRouter: StreamableHttpRouter<OmniRequestMode> = createStreamableHttpRouter({
    buildMcpServer: (mode) => input.buildIdeServer(mode),
  });

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const originHeader = req.headers.origin;
    const origin = typeof originHeader === 'string' ? originHeader : undefined;

    if (origin && input.isOriginAllowed?.(origin) !== true) {
      res.writeHead(403, { 'content-type': 'text/plain', vary: 'Origin' }).end('Origin is not allowed.');
      return;
    }

    if (url.pathname === IDE_MCP_PATH) {
      applyMcpCorsHeaders(res, origin);
      if ((req.method ?? 'GET').toUpperCase() === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
    }

    // /debug/omni/* uses URL-query tokens, not Bearer headers — let the
    // debug bridge handler authenticate. It is only mounted when External
    // Test Mode is on; otherwise we 404 the namespace entirely.
    if (url.pathname.startsWith(DEBUG_PREFIX)) {
      if (!input.debugBridge) {
        res.writeHead(404).end();
        return;
      }
      await input.debugBridge(req, res);
      return;
    }

    // OAuth + discovery endpoints are mounted AHEAD of the /ide auth gate so a
    // client can complete the authorization-code dance before it holds a token.
    // The handler returns true when it consumed the request.
    if (input.oauthHandler) {
      const consumed = await input.oauthHandler(req, res);
      if (consumed) return;
    }

    // /ide/* requires auth per the configured mode.
    const mode = await authMode(req);
    if (!mode) {
      const configured: OmniAuthMode = input.getAuthMode?.() ?? 'bearer';
      const headers: http.OutgoingHttpHeaders = { 'content-type': 'text/plain' };
      // For OAuth-capable modes, point clients at the protected-resource
      // metadata so they can discover the authorization server (RFC 9728).
      if (configured === 'oauth' || configured === 'mixed') {
        const proto = (req.headers['x-forwarded-proto'] ?? 'https').toString().split(',')[0];
        const host = (req.headers['host'] ?? '').toString();
        const resourceMeta = host ? `${proto}://${host}/.well-known/oauth-protected-resource` : undefined;
        headers['www-authenticate'] = resourceMeta ? `Bearer resource_metadata="${resourceMeta}"` : 'Bearer';
      }
      res.writeHead(401, headers).end('Unauthorized.');
      return;
    }

    // SSE — LOCAL ONLY. Cloudflare Quick Tunnel cannot reliably proxy SSE, so
    // external sessions must use /ide/mcp instead.
    if (req.method === 'GET' && url.pathname === IDE_SSE_PATH) {
      if (mode === 'external') {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('SSE is local-only — use /ide/mcp instead.');
        return;
      }
      const transport = new SSEServerTransport(IDE_SSE_MESSAGE_PATH, res);
      sseTransports.set(transport.sessionId, transport);
      transport.onclose = () => {
        sseTransports.delete(transport.sessionId);
      };
      const mcp = input.buildIdeServer('local');
      try {
        await mcp.connect(transport);
      } catch (error) {
        sseTransports.delete(transport.sessionId);
        console.error('[OmniGateway] Failed to connect SSE transport:', error);
        if (!res.headersSent) res.writeHead(500).end();
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === IDE_SSE_MESSAGE_PATH) {
      if (mode === 'external') {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('SSE is local-only — use /ide/mcp instead.');
        return;
      }
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const transport = sseTransports.get(sessionId);
      if (!transport) {
        res.writeHead(404).end('No active SSE session for the given sessionId.');
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    // Streamable HTTP — used by EXTERNAL hosts (also works locally).
    if (url.pathname === IDE_MCP_PATH) {
      await mcpRouter.handleRequest(req, res, mode);
      return;
    }

    res.writeHead(404).end();
  };

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new OmniGatewayAddressInUseError(input.port));
      else reject(err);
    });
    server.listen(input.port, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('[OmniGateway] Could not resolve the loopback port.'));
    });
  });

  console.log(
    `[OmniGateway] Listening on 127.0.0.1:${port} — SSE: ${IDE_SSE_PATH}, Streamable HTTP: ${IDE_MCP_PATH}` +
      (input.debugBridge ? `, debug: ${DEBUG_PREFIX}/*` : '')
  );

  return {
    ideSseUrl: `http://127.0.0.1:${port}${IDE_SSE_PATH}`,
    ideMcpUrl: `http://127.0.0.1:${port}${IDE_MCP_PATH}`,
    port,
    close: async () => {
      for (const transport of sseTransports.values()) void transport.close();
      sseTransports.clear();
      await mcpRouter.closeAll();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
