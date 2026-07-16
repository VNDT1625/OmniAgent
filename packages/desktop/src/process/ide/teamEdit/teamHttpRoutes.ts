/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
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
 *   GET  /team/queue?token=…                 → { ok, status }
 *   POST /team/leave     {token}             → { ok }
 *
 * The `peerToken` doubles as the team-edit coordinator `agentId`, so presence +
 * leases are unified between the host UI and every remote peer. The password
 * gate reuses {@link passwordMatches} (constant-time SHA-256) exactly like the
 * single-doc `/collab/*` surface.
 *
 * Security: peer tokens carry server-side write/database capabilities selected
 * by the host, expire when idle, and are protected by bounded bodies, peer caps,
 * and join rate limiting. File mutations remain lease-guarded and MTUI-backed.
 * A durable audit export remains tracked separately; the live coordinator feed
 * already records claim/write/release/conflict activity for the active session.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  admitTeamPeer,
  getPrimaryTeamSession,
  passwordMatches,
  removeTeamPeer,
  teamPeerCan,
  touchTeamPeer,
  type TeamPeer,
  type TeamSession,
} from '@process/studio/collabServer';
import type { TeamSessionHost } from './teamSessionHost';

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const JOIN_WINDOW_MS = 60_000;
const MAX_FAILED_JOINS_PER_WINDOW = 5;
const MAX_TRACKED_FAILED_JOIN_KEYS = 1024;

type JoinFailureRateLimiterOptions = {
  maxFailures?: number;
  maxTrackedKeys?: number;
  windowMs?: number;
};

type JoinFailureAttempt = {
  startedAt: number;
  failures: number;
};

/**
 * Fixed-window join limiter with bounded cardinality.
 *
 * Once full, unknown clients are rejected until the oldest active window
 * expires. This preserves existing per-client bans without allowing a
 * distributed scan to grow Main-process memory without bound.
 */
export class JoinFailureRateLimiter {
  private readonly attempts = new Map<string, JoinFailureAttempt>();
  private readonly maxFailures: number;
  private readonly maxTrackedKeys: number;
  private readonly windowMs: number;

  constructor(options: JoinFailureRateLimiterOptions = {}) {
    this.maxFailures = Math.max(1, Math.floor(options.maxFailures ?? MAX_FAILED_JOINS_PER_WINDOW));
    this.maxTrackedKeys = Math.max(1, Math.floor(options.maxTrackedKeys ?? MAX_TRACKED_FAILED_JOIN_KEYS));
    this.windowMs = Math.max(1, Math.floor(options.windowMs ?? JOIN_WINDOW_MS));
  }

  get trackedKeys(): number {
    return this.attempts.size;
  }

  retryAfterMs(key: string, now = Date.now()): number {
    const attempt = this.attempts.get(key);
    if (attempt) {
      const elapsed = now - attempt.startedAt;
      if (elapsed >= this.windowMs) {
        this.attempts.delete(key);
        return 0;
      }
      return attempt.failures >= this.maxFailures ? this.windowMs - elapsed : 0;
    }

    this.pruneExpired(now);
    if (this.attempts.size < this.maxTrackedKeys) return 0;

    let retryAfterMs = this.windowMs;
    for (const tracked of this.attempts.values()) {
      retryAfterMs = Math.min(retryAfterMs, this.windowMs - (now - tracked.startedAt));
    }
    return Math.max(1, retryAfterMs);
  }

  recordFailure(key: string, now = Date.now()): void {
    const current = this.attempts.get(key);
    if (current && now - current.startedAt < this.windowMs) {
      current.failures += 1;
      return;
    }
    if (current) this.attempts.delete(key);

    this.pruneExpired(now);
    if (this.attempts.size >= this.maxTrackedKeys) return;
    this.attempts.set(key, { startedAt: now, failures: 1 });
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  private pruneExpired(now: number): void {
    if (this.attempts.size < this.maxTrackedKeys) return;
    for (const [key, attempt] of this.attempts) {
      if (now - attempt.startedAt >= this.windowMs) this.attempts.delete(key);
    }
  }
}

const failedJoins = new JoinFailureRateLimiter();

const joinRateKey = (req: IncomingMessage, session: TeamSession): string =>
  `${session.shareId}:${req.socket.remoteAddress ?? 'unknown'}`;

/** Read a request body without retaining more than the production payload limit. */
const readBody = (req: IncomingMessage): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes <= MAX_REQUEST_BODY_BYTES) chunks.push(c);
    });
    req.on('end', () => resolve(bytes > MAX_REQUEST_BODY_BYTES ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });

/** Parse a JSON object, preserving `null` as the oversized-body signal. */
const readJson = async <T extends Record<string, unknown>>(req: IncomingMessage): Promise<T | null> => {
  try {
    const body = await readBody(req);
    if (body === null) return null;
    const parsed: unknown = JSON.parse(body.toString('utf-8') || '{}');
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as T;
  } catch {
    // Preserve the existing tolerant behavior for empty, malformed, or aborted requests.
  }
  return {} as T;
};

/** Send a JSON response with a status code. */
const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
};

/** Finish a request rejected by either declared or streamed body size checks. */
const payloadTooLarge = (res: ServerResponse): boolean => {
  sendJson(res, 413, { ok: false, error: 'payload-too-large' });
  return true;
};

/** Resolve the active team session + authenticate the peer token. */
const authPeer = (token: string | undefined): { session: TeamSession; root: string; peer: TeamPeer } | null => {
  if (!token) return null;
  const session = getPrimaryTeamSession();
  if (!session) return null;
  const peer = touchTeamPeer(session, token);
  if (!peer) return null;
  return { session, root: session.repoRoot, peer };
};

/** Require a capability already bound to the authenticated peer token. */
const requireCapability = (
  res: ServerResponse,
  auth: { peer: TeamPeer },
  capability: 'write' | 'database'
): boolean => {
  if (teamPeerCan(auth.peer, capability)) return true;
  sendJson(res, 403, { ok: false, error: `permission-denied:${capability}` });
  return false;
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
  const declaredLength = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BODY_BYTES) {
    req.resume();
    return payloadTooLarge(res);
  }

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
    const rateKey = joinRateKey(req, session);
    const retryAfterMs = failedJoins.retryAfterMs(rateKey);
    if (retryAfterMs > 0) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil(retryAfterMs / 1000)));
      sendJson(res, 429, { ok: false, error: 'too-many-join-attempts' });
      return true;
    }
    const payload = await readJson<{ password?: string; name?: string }>(req);
    if (!payload) return payloadTooLarge(res);
    if (!passwordMatches(session.passwordHash, payload.password ?? '')) {
      failedJoins.recordFailure(rateKey);
      sendJson(res, 401, { ok: false, error: 'bad-password' });
      return true;
    }
    failedJoins.clear(rateKey);
    const peer = admitTeamPeer(session, payload.name ?? '');
    host.joinPeer(session.repoRoot, peer.token, peer.name);
    sendJson(res, 200, {
      ok: true,
      peerToken: peer.token,
      participant: { agentId: peer.token, label: peer.name, color: peer.color },
      repoName: session.repoName,
      peerCapabilities: peer.capabilities,
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
    if (!payload) return payloadTooLarge(res);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    if (!requireCapability(res, auth, 'write')) return true;
    const claim = host.claim(auth.root, payload.token!, payload.relPath ?? '', payload.intent);
    sendJson(res, 200, { ok: true, claim });
    return true;
  }

  // POST /team/release
  if (req.method === 'POST' && sub === 'release') {
    const payload = await readJson<{ token?: string; relPath?: string }>(req);
    if (!payload) return payloadTooLarge(res);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    if (!requireCapability(res, auth, 'write')) return true;
    const released = host.release(auth.root, payload.token!, payload.relPath ?? '');
    sendJson(res, 200, { ok: true, released });
    return true;
  }

  // POST /team/write
  if (req.method === 'POST' && sub === 'write') {
    const payload = await readJson<{ token?: string; relPath?: string; data?: string }>(req);
    if (!payload) return payloadTooLarge(res);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    if (!requireCapability(res, auth, 'write')) return true;
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
    if (!payload) return payloadTooLarge(res);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    if (!requireCapability(res, auth, 'write')) return true;
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
    if (!requireCapability(res, auth, 'database')) return true;
    sendJson(res, 200, { ok: true, connections: await host.dbConnections(auth.root) });
    return true;
  }

  // POST /team/db-query — proxy a SQL query on the host (credentials stay home).
  if (req.method === 'POST' && sub === 'db-query') {
    const payload = await readJson<{ token?: string; id?: string; sql?: string }>(req);
    if (!payload) return payloadTooLarge(res);
    const auth = authPeer(payload.token);
    if (!auth) return unauthorized(res);
    if (!requireCapability(res, auth, 'database')) return true;
    try {
      const result = await host.dbQuery(auth.root, payload.id ?? '', payload.sql ?? '');
      sendJson(res, 200, { ok: true, result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errMsg(error) });
    }
    return true;
  }

  // GET /team/queue — expose host pressure so peers can back off politely.
  if (req.method === 'GET' && sub === 'queue') {
    const auth = authPeer(token);
    if (!auth) return unauthorized(res);
    sendJson(res, 200, { ok: true, status: host.queueStatus(auth.root) });
    return true;
  }

  // POST /team/leave
  if (req.method === 'POST' && sub === 'leave') {
    const payload = await readJson<{ token?: string }>(req);
    if (!payload) return payloadTooLarge(res);
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
