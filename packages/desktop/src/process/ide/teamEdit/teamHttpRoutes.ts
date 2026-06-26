/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `teamHttpRoutes` — the HTTP surface (`/team/*`) of a team collaboration
 * session, served by the shared integration host (`onlyOfficeServer`). Peers on
 * the LAN (or across the Internet via a Cloudflare tunnel) hit these routes to
 * browse the host repo, read/write files (file-leased through MTUI), pull the
 * host's Understand graph + Wiki (read-only), and run database queries by proxy.
 *
 * Contract (see `docs/design/team-collab-session.md`):
 *   GET  /team/info                          → { ok, hasSession, repoName? }
 *   POST /team/join      {password,name}     → { ok, peerToken, participant, repoName } | 401
 *   GET  /team/snapshot?token=…              → { ok, snapshot }
 *   GET  /team/tree?token=…&dir=<rel>        → { ok, entries }
 *   GET  /team/file?token=…&relPath=<rel>    → { ok, content, contentHash? }
 *   POST /team/claim     {token,relPath,intent?} → { ok, claim }
 *   POST /team/release   {token,relPath}     → { ok }
 *   POST /team/write     {token,relPath,data}→ { ok, result }
 *   POST /team/edit      {token,relPath,oldText,newText} → { ok, result }
 *   GET  /team/understand?token=…            → { ok, graph|null }
 *   GET  /team/wiki?token=…                  → { ok, wiki|null }
 *   GET  /team/db?token=…                    → { ok, connections }
 *   POST /team/db-query  {token,id,sql}      → { ok, result }
 *   POST /team/leave     {token}             → { ok }
 *
 * The `peerToken` doubles as the team-edit coordinator `agentId`, so presence +
 * leases are unified between the host UI and every remote peer. The password
 * gate reuses {@link passwordMatches} (constant-time SHA-256) exactly like the
 * single-doc `/collab/*` surface.
 *
 * SECURITY TODO (tracked): `/team/db` exposes connection metadata and
 * `/team/write|edit` allow remote disk writes on the host, gated only by the
 * session password. A production pass needs per-peer scoped tokens, RO/RW
 * permissions, rate limiting, and an audit trail.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  admitTeamPeer,
  getPrimaryTeamSession,
  passwordMatches,
  removeTeamPeer,
  touchTeamPeer,
  type TeamSession,
} from '@process/studio/collabServer';
import type { TeamSessionHost } from './teamSessionHost';

/** Read a request body fully as a Buffer. */
const readBody = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/** Parse a JSON body, tolerant of empty/garbage (returns {}). */
const readJson = async <T extends Record<string, unknown>>(req: IncomingMessage): Promise<T> => {
  try {
    return JSON.parse((await readBody(req)).toString('utf-8') || '{}') as T;
  } catch {
    return {} as T;
  }
};

/** Send a JSON response with a status code. */
const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
};

/** Resolve the active team session + authenticate the peer token. */
const authPeer = (token: string | undefined): { session: TeamSession; root: string } | null => {
  if (!token) return null;
  const session = getPrimaryTeamSession();
  if (!session) return null;
  const peer = touchTeamPeer(session, token);
  if (!peer) return null;
  return { session, root: session.repoRoot };
};

/**
 * Handle a `/team/*` request. Returns `true` when it produced a response (the
 * integration host should then stop), `false` when the path was not a team
 * route. CORS is applied by the host before this is called.
 */
export const handleTeamRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  host: TeamSessionHost
): Promise<boolean> => {
  const sub = parts[1];
  const url = new URL(req.url ?? '/', 'http://team.local');
  const q = url.searchParams;

  // GET /team/info — advertise whether a repo is published (no secrets).
  if (req.method === 'GET' && sub === 'info') {
    const session = getPrimaryTeamSession();
    sendJson(res, 200, { ok: true, hasSession: !!session, repoName: session?.repoName });
    return true;
  }

  // POST /team/join — verify password, admit the peer.
  if (req.method === 'POST' && sub === 'join') {
    const session = getPrimaryTeamSession();
    if (!session) {
      sendJson(res, 404, { ok: false, error: 'no-session' });
      return true;
    }
    const payload = await readJson<{ password?: string; name?: string }>(req);
    if (!passwordMatches(session.passwordHash, payload.password ?? '')) {
      sendJson(res, 401, { ok: false, error: 'bad-password' });
      return true;
    }
    const peer = admitTeamPeer(session, payload.name ?? '');
    host.joinPeer(session.repoRoot, peer.token, peer.name);
    sendJson(res, 200, {
      ok: true,
      peerToken: peer.token,
      participant: { agentId: peer.token, label: peer.name, color: peer.color },
      repoName: session.repoName,
    });
    return true;
  }

  // Everything below needs an authenticated peer token.
  const token = (q.get('token') ?? undefined) || undefined;

  // GET /team/snapshot
  if (req.method === 'GET' && sub === 'snapshot') {
    const auth = authPeer(token);
    if (!auth) return unauthorized(res);
    sendJson(res, 200, { ok: true, snapshot: host.snapshot(auth.root) });
    return true;
  }

  // GET /team/tree?dir=
  if (req.method === 'GET' && sub === 'tree') {
    const auth = authPeer(token);
    if (!auth) return unauthorized(res);
    try {
      const entries = await host.listDir(auth.root, q.get('dir') ?? '');
      sendJson(res, 200, { ok: true, entries });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errMsg(error) });
    }
    return true;
  }

  // GET /team/file?relPath=
  if (req.method === 'GET' && sub === 'file') {
    const auth = authPeer(token);
    if (!auth) return unauthorized(res);
    try {
      const read = await host.readFile(auth.root, q.get('relPath') ?? '');
      sendJson(res, 200, { ok: true, ...read });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errMsg(error) });
    }
    return true;
  }

  // POST /team/claim
  if (req.method === 'POST' && sub === 'claim') {
    const payload = await readJson<{ token?: string; relPath?: string; intent?: string }>(req);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    const claim = host.claim(auth.root, payload.token!, payload.relPath ?? '', payload.intent);
    sendJson(res, 200, { ok: true, claim });
    return true;
  }

  // POST /team/release
  if (req.method === 'POST' && sub === 'release') {
    const payload = await readJson<{ token?: string; relPath?: string }>(req);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    const released = host.release(auth.root, payload.token!, payload.relPath ?? '');
    sendJson(res, 200, { ok: true, released });
    return true;
  }

  // POST /team/write
  if (req.method === 'POST' && sub === 'write') {
    const payload = await readJson<{ token?: string; relPath?: string; data?: string }>(req);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    try {
      const result = await host.write(auth.root, payload.token!, payload.relPath ?? '', payload.data ?? '');
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errMsg(error) });
    }
    return true;
  }

  // POST /team/edit
  if (req.method === 'POST' && sub === 'edit') {
    const payload = await readJson<{ token?: string; relPath?: string; oldText?: string; newText?: string }>(req);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    try {
      const result = await host.edit(
        auth.root,
        payload.token!,
        payload.relPath ?? '',
        payload.oldText ?? '',
        payload.newText ?? ''
      );
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errMsg(error) });
    }
    return true;
  }

  // GET /team/understand
  if (req.method === 'GET' && sub === 'understand') {
    const auth = authPeer(token);
    if (!auth) return unauthorized(res);
    sendJson(res, 200, { ok: true, graph: await host.understand(auth.root) });
    return true;
  }

  // GET /team/wiki
  if (req.method === 'GET' && sub === 'wiki') {
    const auth = authPeer(token);
    if (!auth) return unauthorized(res);
    sendJson(res, 200, { ok: true, wiki: await host.wiki(auth.root) });
    return true;
  }

  // GET /team/db — connection metadata (no secrets).
  if (req.method === 'GET' && sub === 'db') {
    const auth = authPeer(token);
    if (!auth) return unauthorized(res);
    sendJson(res, 200, { ok: true, connections: await host.dbConnections(auth.root) });
    return true;
  }

  // POST /team/db-query — proxy a SQL query on the host (credentials stay home).
  if (req.method === 'POST' && sub === 'db-query') {
    const payload = await readJson<{ token?: string; id?: string; sql?: string }>(req);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    try {
      const result = await host.dbQuery(payload.id ?? '', payload.sql ?? '');
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errMsg(error) });
    }
    return true;
  }

  // POST /team/leave
  if (req.method === 'POST' && sub === 'leave') {
    const payload = await readJson<{ token?: string }>(req);
    const session = getPrimaryTeamSession();
    if (session && payload.token) {
      host.leavePeer(session.repoRoot, payload.token);
      removeTeamPeer(session.shareId, payload.token);
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
};

/** 401 helper. */
const unauthorized = (res: ServerResponse): boolean => {
  sendJson(res, 401, { ok: false, error: 'unauthorized' });
  return true;
};

/** Extract a human message from an unknown error. */
const errMsg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
