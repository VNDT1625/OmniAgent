/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read-only HTTP "Debug Bridge" for browser AIs (ChatGPT, Grok) that cannot
 * configure an MCP connector or send a custom `Authorization` header from a
 * web-based tool. They can, however, open a URL — so this bridge accepts a
 * one-time URL-token (`?token=…`) and exposes a TIGHTLY-RESTRICTED set of
 * read-only routes that delegate into the same internal IDE service (no
 * separate logic):
 *
 *  GET /debug/omni/health?token=…
 *  GET /debug/omni/bootstrap?token=…&planningEnabled=…
 *  GET /debug/omni/search?token=…&q=…&glob=…&max=…
 *  GET /debug/omni/read?token=…&path=…&from=…&to=…
 *  GET /debug/omni/list_dir?token=…&dir=…&glob=…
 *  GET /debug/omni/find_definition?token=…&name=…
 *
 * Hard guarantees enforced HERE (not at allowlist alone):
 *  - GET only — no POST/PUT/PATCH/DELETE on this prefix.
 *  - Token must come from {@link OmniGatewayTokenStore.checkDebugToken}.
 *  - The token's per-token call/bootstrap caps are enforced atomically.
 *  - No terminal, no writes, no DB, no memory mutation, no secrets — even if
 *    the External Test Mode user accidentally widened the gateway allowlist.
 *  - Only mounted when External Test Mode is enabled; the host 404s the prefix
 *    otherwise.
 *
 * Process boundary: Main-process (Node.js / Electron). No DOM APIs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as path from 'node:path';
import type { IdeMcpService } from '@process/ide/mcp/ideServer';
import { buildOmniBootstrapResult } from './omniBootstrap';
import { OMNI_IDE_BASE_ALLOWLIST, OMNI_IDE_DANGEROUS_TOOLS } from './omniIdeAllowlist';
import { OMNI_IDE_SERVER_INSTRUCTIONS } from './omniGatewayProfile';
import type { OmniGatewayTokenStore } from './omniGatewayExternalToken';
import type { OmniGatewayState } from './omniGatewayState';
import { loadProjectRules } from '@process/ide/rulesLoader';

/** Inputs to {@link createOmniDebugBridge}. */
export type OmniDebugBridgeDeps = {
  /** The token store (we only check; we never mint here). */
  tokenStore: OmniGatewayTokenStore;
  /** Session state shared with the MCP plane (debug bootstrap also issues a session). */
  state: OmniGatewayState;
  /** IDE service singleton used to satisfy read-only operations. */
  ide: IdeMcpService;
  /** Workspace root the gateway serves. */
  rootPath: string;
  /** Idle TTL surfaced in bootstrap policy (mirrors the MCP plane). */
  sessionTtlMs: number;
  /**
   * Resolved public MCP URL embedded in the bootstrap response so the browser
   * AI can fall back to the proper MCP transport when an MCP connector is
   * available. May be undefined when tunnel is not yet up.
   */
  getMcpEndpoint: () => string | undefined;
};

/** Public surface used by the gateway host. */
export type OmniDebugBridge = {
  /** Express-style handler — does the routing internally. */
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

/** Names of the debug-bridge tools advertised back to the caller. */
export const OMNI_DEBUG_TOOLS = ['health', 'bootstrap', 'search', 'read', 'list_dir', 'find_definition'] as const;

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
};

const send403 = (res: ServerResponse, reason: string): void => sendJson(res, 403, { ok: false, error: reason });

const send400 = (res: ServerResponse, reason: string): void => sendJson(res, 400, { ok: false, error: reason });

const send404 = (res: ServerResponse): void => sendJson(res, 404, { ok: false, error: 'Unknown debug endpoint.' });

/**
 * Build the debug bridge. The host mounts the returned `handle` on any URL
 * that starts with `/debug/omni`.
 */
export const createOmniDebugBridge = (deps: OmniDebugBridgeDeps): OmniDebugBridge => {
  /** Resolve a path that an external caller passed — must stay inside rootPath. */
  const resolveSafePath = (raw: string): string | null => {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(deps.rootPath, raw);
    const normalisedRoot = path.resolve(deps.rootPath);
    // Reject any traversal outside the configured rootPath.
    if (!abs.startsWith(normalisedRoot + path.sep) && abs !== normalisedRoot) return null;
    return abs;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { ok: false, error: 'Debug bridge is read-only — GET only.' });
      return;
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // Normalise: drop the /debug/omni prefix, keep the rest as the route.
    const subPath = url.pathname.replace(/^\/debug\/omni\/?/, '');
    const route = subPath.split('/').filter(Boolean)[0] ?? '';

    const token = url.searchParams.get('token') ?? '';
    if (!token) {
      send400(res, 'Missing token in query string.');
      return;
    }

    const isBootstrap = route === 'bootstrap';
    const verdict = deps.tokenStore.checkDebugToken(token, isBootstrap);
    if (!verdict.allow) {
      const reason = 'reason' in verdict ? verdict.reason : 'unknown';
      switch (reason) {
        case 'unknown':
          send403(res, 'Unknown or revoked debug token.');
          return;
        case 'expired':
          send403(res, 'Debug token has expired.');
          return;
        case 'rate-limit':
          send403(res, 'Debug token has reached its call limit.');
          return;
        case 'bootstrap-limit':
          send403(res, 'Debug token has reached its bootstrap call limit.');
          return;
      }
    }

    try {
      switch (route) {
        case 'health':
          sendJson(res, 200, {
            ok: true,
            workspace: deps.rootPath,
            availableDebugTools: OMNI_DEBUG_TOOLS,
            mcpEndpoint: deps.getMcpEndpoint(),
            note: 'External Test Mode — read-only, dev/test only. Not for production.',
          });
          return;
        case 'bootstrap': {
          const planningEnabled = url.searchParams.get('planningEnabled') === 'true';
          const rules = await loadProjectRules(deps.rootPath).catch(() => [] as string[]);
          const result = buildOmniBootstrapResult({
            rootPath: deps.rootPath,
            rules,
            planningEnabled,
            allowDangerous: false, // debug plane never advertises dangerous tools
            baseAllowlist: OMNI_IDE_BASE_ALLOWLIST,
            dangerousTools: OMNI_IDE_DANGEROUS_TOOLS,
            serverInstructions: OMNI_IDE_SERVER_INSTRUCTIONS,
            sessionTtlMs: deps.sessionTtlMs,
            state: deps.state,
          });
          // The Debug Bridge exposes the same allowlist the MCP plane does —
          // see `availableDebugTools` for the URL-callable subset (browsers
          // can't invoke MCP tools directly); the full list is informational
          // so the caller can fall back to the MCP endpoint when it has one.
          sendJson(res, 200, {
            ok: true,
            sessionId: result.sessionId,
            workspace: result.workspace,
            activeGuide: result.activeGuide,
            availableDebugTools: OMNI_DEBUG_TOOLS,
            mcpEndpoint: deps.getMcpEndpoint(),
            tools: result.tools,
            policy: result.policy,
            serverInstructions: result.serverInstructions,
            note: 'Web Access bootstrap — token stays valid until you disable Web Access.',
          });
          return;
        }
        case 'search': {
          const q = url.searchParams.get('q');
          if (!q) {
            send400(res, 'Missing q parameter.');
            return;
          }
          const glob = url.searchParams.get('glob') ?? undefined;
          const max = Number(url.searchParams.get('max') ?? '50');
          const hits = await deps.ide.search(deps.rootPath, q, {
            glob,
            maxResults: Number.isFinite(max) && max > 0 ? Math.min(max, 200) : 50,
          });
          sendJson(res, 200, { ok: true, hits });
          return;
        }
        case 'read': {
          const rawPath = url.searchParams.get('path');
          if (!rawPath) {
            send400(res, 'Missing path parameter.');
            return;
          }
          const abs = resolveSafePath(rawPath);
          if (!abs) {
            send403(res, 'Path is outside the configured workspace root.');
            return;
          }
          const from = Number(url.searchParams.get('from') ?? '');
          const to = Number(url.searchParams.get('to') ?? '');
          const result = await deps.ide.readFile(abs, {
            from: Number.isFinite(from) && from > 0 ? from : undefined,
            to: Number.isFinite(to) && to > 0 ? to : undefined,
            maxLines: 500,
          });
          sendJson(res, 200, { ok: true, ...result });
          return;
        }
        case 'list_dir': {
          const rawDir = url.searchParams.get('dir');
          if (!rawDir) {
            send400(res, 'Missing dir parameter.');
            return;
          }
          const abs = resolveSafePath(rawDir);
          if (!abs) {
            send403(res, 'Dir is outside the configured workspace root.');
            return;
          }
          const glob = url.searchParams.get('glob') ?? undefined;
          const entries = await deps.ide.listDir(abs, {
            glob,
            recursive: glob !== undefined,
            maxResults: 200,
          });
          sendJson(res, 200, { ok: true, entries });
          return;
        }
        case 'find_definition': {
          const name = url.searchParams.get('name');
          if (!name) {
            send400(res, 'Missing name parameter.');
            return;
          }
          const hits = await deps.ide.findDefinition(deps.rootPath, name, 50);
          sendJson(res, 200, { ok: true, hits });
          return;
        }
        default:
          send404(res);
          return;
      }
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return { handle };
};
