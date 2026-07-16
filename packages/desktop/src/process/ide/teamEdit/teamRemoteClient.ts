/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `teamRemoteClient` — the PEER-side HTTP client for a team collaboration
 * session. It talks to a host's `/team/*` surface (served by the host's
 * `onlyOfficeServer` + `teamHttpRoutes`) so the peer's IDE workspace can browse,
 * read, write/edit (file-leased through the host's MTUI), and pull the host's
 * Understand graph / Wiki / Database — even across networks (the `baseUrl` is a
 * LAN `http://ip:port` or a Cloudflare tunnel URL).
 *
 * Every call is timeout-guarded so an unreachable / vanished host rejects fast
 * instead of hanging the renderer. All methods return discriminated `{ ok }`
 * envelopes; nothing throws across the bridge.
 *
 * Process boundary: Main-process (Node.js) module — uses global `fetch`. No DOM.
 */

import type { GuardedEditResult, GuardedWriteResult, TeamEditSnapshot } from './teamEditService';
import type { TeamPeerCapabilities } from '@process/studio/collabServer';
import type { TeamTreeEntry, TeamFileRead, TeamDbConnection, TeamDbQueryResult } from './teamSessionHost';
import type { TeamRequestQueueStatus } from './teamRequestQueue';

/** A snapshot fetched from a remote host (same shape the host serves). */
export type RemoteTeamSnapshot = TeamEditSnapshot;

/** Host queue pressure fetched by a peer. */
export type RemoteTeamQueueStatus = TeamRequestQueueStatus;

/** Default per-request timeout (ms). Repo IO over a tunnel can be slow-ish. */
const REQUEST_TIMEOUT_MS = 15000;

/** Normalise a base URL (strip a trailing slash). */
const normBase = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

/** Build the full `/team/<sub>` URL with optional query params. */
const teamUrl = (baseUrl: string, sub: string, params?: Record<string, string>): string => {
  const url = new URL(`${normBase(baseUrl)}/team/${sub}`);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
};

/** Fetch JSON with a hard timeout; resolves to a discriminated envelope. */
const fetchJson = async <T>(
  url: string,
  init?: RequestInit
): Promise<{ ok: true; data: T } | { ok: false; error: string }> => {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.ok === false) {
      return { ok: false, error: typeof body.error === 'string' ? body.error : `HTTP ${res.status}` };
    }
    return { ok: true, data: body as T };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, error: msg.includes('timeout') || msg.includes('aborted') ? 'host-unreachable' : msg };
  }
};

/** POST a JSON body. */
const postJson = <T>(url: string, payload: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> =>
  fetchJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

/** The peer-side remote client surface. */
export const teamRemoteClient = {
  /** Authenticate against a host; returns the peer token used for all later calls. */
  join: async (
    baseUrl: string,
    password: string,
    name: string
  ): Promise<
    | { ok: true; peerToken: string; repoName: string; baseUrl: string; peerCapabilities: TeamPeerCapabilities }
    | { ok: false; error: string }
  > => {
    const res = await postJson<{ peerToken: string; repoName: string; peerCapabilities: TeamPeerCapabilities }>(
      teamUrl(baseUrl, 'join'),
      { password, name }
    );
    if (res.ok === false) return res;
    return {
      ok: true,
      peerToken: res.data.peerToken,
      repoName: res.data.repoName,
      baseUrl: normBase(baseUrl),
      peerCapabilities: res.data.peerCapabilities,
    };
  },

  /** Drop out of a session (best-effort). */
  leave: async (baseUrl: string, token: string): Promise<void> => {
    await postJson(teamUrl(baseUrl, 'leave'), { token }).catch((): undefined => undefined);
  },

  /** Poll the presence/leases/activity snapshot. */
  snapshot: async (
    baseUrl: string,
    token: string
  ): Promise<{ ok: true; snapshot: RemoteTeamSnapshot } | { ok: false; error: string }> => {
    const res = await fetchJson<{ snapshot: RemoteTeamSnapshot }>(teamUrl(baseUrl, 'snapshot', { token }));
    if (res.ok === false) return res;
    return { ok: true, snapshot: res.data.snapshot };
  },

  /** List a repo-relative directory on the host. */
  tree: async (
    baseUrl: string,
    token: string,
    dir: string
  ): Promise<{ ok: true; entries: TeamTreeEntry[] } | { ok: false; error: string }> => {
    const res = await fetchJson<{ entries: TeamTreeEntry[] }>(teamUrl(baseUrl, 'tree', { token, dir }));
    if (res.ok === false) return res;
    return { ok: true, entries: res.data.entries };
  },

  /** Read a repo-relative file from the host. */
  file: async (
    baseUrl: string,
    token: string,
    relPath: string
  ): Promise<{ ok: true; read: TeamFileRead } | { ok: false; error: string }> => {
    const res = await fetchJson<TeamFileRead>(teamUrl(baseUrl, 'file', { token, relPath }));
    if (res.ok === false) return res;
    return { ok: true, read: { content: res.data.content, contentHash: res.data.contentHash } };
  },

  /** Claim a lease on the host. */
  claim: (
    baseUrl: string,
    token: string,
    relPath: string,
    intent?: string
  ): Promise<{ ok: true; data: { claim: unknown } } | { ok: false; error: string }> =>
    postJson<{ claim: unknown }>(teamUrl(baseUrl, 'claim'), { token, relPath, intent }),

  /** Release a lease on the host. */
  release: (
    baseUrl: string,
    token: string,
    relPath: string
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> =>
    postJson(teamUrl(baseUrl, 'release'), { token, relPath }),

  /** Guarded full-file write on the host. */
  write: async (
    baseUrl: string,
    token: string,
    relPath: string,
    data: string
  ): Promise<{ ok: true; result: GuardedWriteResult } | { ok: false; error: string }> => {
    const res = await postJson<{ result: GuardedWriteResult }>(teamUrl(baseUrl, 'write'), { token, relPath, data });
    if (res.ok === false) return res;
    return { ok: true, result: res.data.result };
  },

  /** Guarded anchor edit on the host. */
  edit: async (
    baseUrl: string,
    token: string,
    relPath: string,
    oldText: string,
    newText: string
  ): Promise<{ ok: true; result: GuardedEditResult } | { ok: false; error: string }> => {
    const res = await postJson<{ result: GuardedEditResult }>(teamUrl(baseUrl, 'edit'), {
      token,
      relPath,
      oldText,
      newText,
    });
    if (res.ok === false) return res;
    return { ok: true, result: res.data.result };
  },

  /** Pull the host's Understand graph (read-only). */
  understand: async (
    baseUrl: string,
    token: string
  ): Promise<{ ok: true; graph: unknown } | { ok: false; error: string }> => {
    const res = await fetchJson<{ graph: unknown }>(teamUrl(baseUrl, 'understand', { token }));
    if (res.ok === false) return res;
    return { ok: true, graph: res.data.graph };
  },

  /** Pull the host's Wiki (read-only). */
  wiki: async (baseUrl: string, token: string): Promise<{ ok: true; wiki: unknown } | { ok: false; error: string }> => {
    const res = await fetchJson<{ wiki: unknown }>(teamUrl(baseUrl, 'wiki', { token }));
    if (res.ok === false) return res;
    return { ok: true, wiki: res.data.wiki };
  },

  /** List the host's database connections (no secrets). */
  dbConnections: async (
    baseUrl: string,
    token: string
  ): Promise<{ ok: true; connections: TeamDbConnection[] } | { ok: false; error: string }> => {
    const res = await fetchJson<{ connections: TeamDbConnection[] }>(teamUrl(baseUrl, 'db', { token }));
    if (res.ok === false) return res;
    return { ok: true, connections: res.data.connections };
  },

  /** Proxy a SQL query on the host (credentials stay on the host). */
  dbQuery: async (
    baseUrl: string,
    token: string,
    id: string,
    sql: string
  ): Promise<{ ok: true; result: TeamDbQueryResult } | { ok: false; error: string }> => {
    const res = await postJson<{ result: TeamDbQueryResult }>(teamUrl(baseUrl, 'db-query'), { token, id, sql });
    if (res.ok === false) return res;
    return { ok: true, result: res.data.result };
  },

  /** Inspect host queue pressure so a peer UI/agent can avoid piling on. */
  queue: async (
    baseUrl: string,
    token: string
  ): Promise<{ ok: true; status: RemoteTeamQueueStatus } | { ok: false; error: string }> => {
    const res = await fetchJson<{ status: RemoteTeamQueueStatus }>(teamUrl(baseUrl, 'queue', { token }));
    if (res.ok === false) return res;
    return { ok: true, status: res.data.status };
  },
};
