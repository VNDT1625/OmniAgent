/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `teamCollabBridge` — the renderer-facing control surface for **team
 * collaboration sessions** (whole-repo sharing, distinct from the single-doc
 * `/collab/*` flow).
 *
 * Two roles:
 *  - HOST: `publish` turns the open repo into a shared session — it builds the
 *    {@link TeamSessionHost}, registers the `/team/*` routes on the integration
 *    host (`onlyOfficeServer`), keeps that host alive, and (LAN) broadcasts a
 *    discovery beacon / (WAN) opens a Cloudflare tunnel so peers on a different
 *    network can still reach it. `unpublish` tears all of that down.
 *  - PEER: `join` authenticates against a host's `/team/*` surface (LAN ip:port
 *    or a tunnel URL) and remembers the returned peer token; `getRemoteSnapshot`
 *    polls presence/leases; `leave` drops out. The actual remote file IO lives
 *    in {@link teamRemoteClient} (used by the IDE workspace when in peer mode).
 *
 * Channels (always-resolving envelopes so a renderer await never hangs):
 *   ide.team-collab-publish / -unpublish / -status        (host)
 *   ide.team-collab-join / -leave / -remote-snapshot       (peer)
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { basename } from 'node:path';
import {
  buildTeamPublishInfo,
  getPrimaryTeamSession,
  hasTeamSessions,
  publishTeamSession,
  unpublishTeamSession,
  type TeamPublishInfo,
} from '@process/studio/collabServer';
import {
  addServerKeepAlive,
  ensureTeamHostServer,
  getServerPort,
  registerExtraRoute,
  releaseServerKeepAlive,
} from '@process/studio/onlyOfficeServer';
import { startBeacon, stopBeacon } from '@process/studio/collabDiscovery';
import { ensureCloudflared, startTunnel, stopTunnel } from '@process/studio/cloudflareTunnel';
import { getDbService } from '@process/ide/db/dbWiring';
import { loadGraph as loadKnowledgeGraph } from '@process/ide/quickTestBridgeHelpers';
import { refreshGraphFileOnDisk } from '@process/ide/kgRefresh';
import { loadWikiForRoot } from '@process/ide/wiki/wikiBuildBridge';
import { getTeamEditService } from './teamEditService';
import { createTeamSessionHost, type TeamSessionHost, type TeamDbConnection } from './teamSessionHost';
import { handleTeamRequest } from './teamHttpRoutes';
import { teamRemoteClient, type RemoteTeamSnapshot } from './teamRemoteClient';
import type { TeamTreeEntry, TeamFileRead } from './teamSessionHost';
import type { GuardedWriteResult } from './teamEditService';

/** IPC channel names for the team-collab surface. */
export const TEAM_COLLAB_CHANNELS = {
  publish: 'ide.team-collab-publish',
  unpublish: 'ide.team-collab-unpublish',
  status: 'ide.team-collab-status',
  join: 'ide.team-collab-join',
  leave: 'ide.team-collab-leave',
  remoteSnapshot: 'ide.team-collab-remote-snapshot',
  remoteTree: 'ide.team-collab-remote-tree',
  remoteFile: 'ide.team-collab-remote-file',
  remoteClaim: 'ide.team-collab-remote-claim',
  remoteRelease: 'ide.team-collab-remote-release',
  remoteWrite: 'ide.team-collab-remote-write',
} as const;

/** Always-resolving envelope. */
export type TeamCollabResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Host publish request. */
export type TeamPublishRequest = { rootPath: string; password: string; online?: boolean };
/** Host publish data (join code/url + identity). */
export type TeamPublishData = TeamPublishInfo & { online: boolean; joinUrl?: string };
/** Host status (is a session live + its info). */
export type TeamStatusData = { publishing: boolean; info?: TeamPublishData };

/** Peer join request (base URL is LAN `http://ip:port` or a tunnel URL). */
export type TeamJoinRequest = { baseUrl: string; password: string; name: string };
/** Peer join data. */
export type TeamJoinData = { peerToken: string; repoName: string; baseUrl: string };

/** Auth+target tuple every peer browse/read/write request carries. */
export type PeerCtx = { baseUrl: string; token: string };
/** Peer: list one directory on the host (relPath; '' = root). */
export type PeerTreeRequest = PeerCtx & { dir: string };
/** Peer: read one file from the host. */
export type PeerFileRequest = PeerCtx & { relPath: string };
/** Peer: claim a lease before editing. */
export type PeerClaimRequest = PeerCtx & { relPath: string; intent?: string };
/** Peer: release a lease. */
export type PeerReleaseRequest = PeerCtx & { relPath: string };
/** Peer: send a full-file write to the host (guarded by lease + MTUI). */
export type PeerWriteRequest = PeerCtx & { relPath: string; data: string };

/** Typed channels. */
export const teamCollabChannels = {
  publish: bridge.buildProvider<TeamCollabResult<TeamPublishData>, TeamPublishRequest>(TEAM_COLLAB_CHANNELS.publish),
  unpublish: bridge.buildProvider<TeamCollabResult<boolean>, { rootPath: string }>(TEAM_COLLAB_CHANNELS.unpublish),
  status: bridge.buildProvider<TeamCollabResult<TeamStatusData>, void>(TEAM_COLLAB_CHANNELS.status),
  join: bridge.buildProvider<TeamCollabResult<TeamJoinData>, TeamJoinRequest>(TEAM_COLLAB_CHANNELS.join),
  leave: bridge.buildProvider<TeamCollabResult<boolean>, { baseUrl: string; token: string }>(
    TEAM_COLLAB_CHANNELS.leave
  ),
  remoteSnapshot: bridge.buildProvider<TeamCollabResult<RemoteTeamSnapshot>, { baseUrl: string; token: string }>(
    TEAM_COLLAB_CHANNELS.remoteSnapshot
  ),
  remoteTree: bridge.buildProvider<TeamCollabResult<TeamTreeEntry[]>, PeerTreeRequest>(TEAM_COLLAB_CHANNELS.remoteTree),
  remoteFile: bridge.buildProvider<TeamCollabResult<TeamFileRead>, PeerFileRequest>(TEAM_COLLAB_CHANNELS.remoteFile),
  remoteClaim: bridge.buildProvider<TeamCollabResult<{ claim: unknown }>, PeerClaimRequest>(
    TEAM_COLLAB_CHANNELS.remoteClaim
  ),
  remoteRelease: bridge.buildProvider<TeamCollabResult<boolean>, PeerReleaseRequest>(
    TEAM_COLLAB_CHANNELS.remoteRelease
  ),
  remoteWrite: bridge.buildProvider<TeamCollabResult<GuardedWriteResult>, PeerWriteRequest>(
    TEAM_COLLAB_CHANNELS.remoteWrite
  ),
};

/** The tunnel key used for the team host (separate from the doc-collab `host`/`ds`). */
const TEAM_TUNNEL_KEY = 'team-host';

/**
 * Race a Main-side async step against a hard timeout so a wedged primitive
 * (e.g. `server.listen` never firing, a hung tunnel probe) can never leave the
 * renderer's `invoke` hanging until its own 60s budget. On timeout we reject
 * with a clear message that surfaces in the publish error envelope.
 */
const withMainTimeout = <T>(label: string, ms: number, op: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    op().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Lazily-built host facade (shared by all sessions in this process). */
let sessionHost: TeamSessionHost | undefined;
/** The currently-published info (host side), so `status` is cheap. */
let publishedInfo: TeamPublishData | undefined;

/** Build (once) the team session host over the real services. */
const resolveSessionHost = (): TeamSessionHost => {
  if (sessionHost) return sessionHost;
  const db = getDbService();
  sessionHost = createTeamSessionHost({
    team: getTeamEditService(),
    refreshGraph: refreshGraphFileOnDisk,
    loadGraph: (rootPath) => loadKnowledgeGraph(rootPath),
    loadWiki: (rootPath) => loadWikiForRoot(rootPath),
    listDbConnections: async (rootPath): Promise<TeamDbConnection[]> => {
      try {
        const states = await db.listConnections(rootPath);
        return states.map((s) => ({ id: s.config.id, name: s.config.name, kind: s.config.kind }));
      } catch {
        return [];
      }
    },
    runDbQuery: async (id, sql) => {
      await db.connect(id);
      const result = await db.query(id, sql, { maxRows: 1000 });
      return { columns: result.columns, rows: result.rows, rowCount: result.rows.length };
    },
  });
  return sessionHost;
};

/** Register the `/team/*` routes against the integration host (idempotent). */
const ensureTeamRoutes = (): void => {
  const host = resolveSessionHost();
  registerExtraRoute('team', (req, res, parts) => handleTeamRequest(req, res, parts, host));
};

/**
 * Register the team-collab IPC handlers. Idempotent; call once at bootstrap.
 */
export function registerTeamCollabBridge(): void {
  // Register the IPC providers FIRST. Binding handlers cannot fail, so the
  // channels always exist and a renderer invoke always gets a reply. (Doing any
  // side-effecting setup — e.g. building the session host / DB service — before
  // this point risks throwing during bootstrap, which the caller's try/catch
  // swallows, leaving the channels unregistered and every invoke hanging until
  // its 60s timeout. The actual `/team/*` routes are brought up lazily inside
  // `publish`, and again defensively at the end of this function.)

  teamCollabChannels.publish.provider(async (req): Promise<TeamCollabResult<TeamPublishData>> => {
    console.log('[teamCollab] publish invoked', { rootPath: req.rootPath, online: req.online });
    try {
      const rootPath = req.rootPath?.trim();
      if (!rootPath) return { ok: false, error: 'rootPath is required.' };
      // Bring the integration host up and keep it alive for the session lifetime.
      // Guard with a timeout: a hung `listen()` (e.g. blocked socket bind) must
      // surface as an error envelope, never hang the renderer until its 60s
      // client timeout.
      await withMainTimeout('ensureTeamHostServer', 10000, () => ensureTeamHostServer());
      ensureTeamRoutes();
      addServerKeepAlive();

      const session = publishTeamSession({
        repoRoot: rootPath,
        repoName: basename(rootPath),
        password: req.password || '123456',
      });
      // Register the host's user in presence so peers see who owns the repo.
      getTeamEditService().join(rootPath, 'host', 'Host', true);

      const info = buildTeamPublishInfo(session, getServerPort());
      let joinUrl: string | undefined;
      if (req.online) {
        const ensured = await ensureCloudflared();
        if (ensured.ok === false) {
          releaseServerKeepAlive();
          unpublishTeamSession(session.shareId);
          return { ok: false, error: ensured.detail };
        }
        const tunnel = await startTunnel(TEAM_TUNNEL_KEY, `http://localhost:${getServerPort()}`);
        if (tunnel.ok === false) {
          releaseServerKeepAlive();
          unpublishTeamSession(session.shareId);
          return { ok: false, error: `Could not open a tunnel (${tunnel.reason}).` };
        }
        joinUrl = tunnel.url;
      } else {
        // LAN: broadcast a discovery beacon so peers need not type the code.
        startBeacon({
          shareId: session.shareId,
          joinCode: info.joinCode,
          title: session.repoName,
          fileType: 'repo',
          hostName: info.lanIps[0] ?? 'host',
        });
      }
      publishedInfo = { ...info, online: !!req.online, joinUrl };
      return { ok: true, data: publishedInfo };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamCollabChannels.unpublish.provider(async (req): Promise<TeamCollabResult<boolean>> => {
    try {
      const session = getPrimaryTeamSession();
      if (session && (!req.rootPath || session.repoRoot === req.rootPath)) {
        unpublishTeamSession(session.shareId);
        getTeamEditService().reset(session.repoRoot);
      }
      stopBeacon();
      stopTunnel(TEAM_TUNNEL_KEY);
      releaseServerKeepAlive();
      publishedInfo = undefined;
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamCollabChannels.status.provider(async (): Promise<TeamCollabResult<TeamStatusData>> => {
    return { ok: true, data: { publishing: hasTeamSessions(), info: publishedInfo } };
  });

  teamCollabChannels.join.provider(async (req): Promise<TeamCollabResult<TeamJoinData>> => {
    try {
      const joined = await teamRemoteClient.join(req.baseUrl, req.password, req.name);
      if (joined.ok === false) return { ok: false, error: joined.error };
      return { ok: true, data: { peerToken: joined.peerToken, repoName: joined.repoName, baseUrl: joined.baseUrl } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamCollabChannels.leave.provider(async (req): Promise<TeamCollabResult<boolean>> => {
    try {
      await teamRemoteClient.leave(req.baseUrl, req.token);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamCollabChannels.remoteSnapshot.provider(async (req): Promise<TeamCollabResult<RemoteTeamSnapshot>> => {
    try {
      const snap = await teamRemoteClient.snapshot(req.baseUrl, req.token);
      if (snap.ok === false) return { ok: false, error: snap.error };
      return { ok: true, data: snap.snapshot };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // --- Peer browse / read / edit (forwarded straight to the remote client) ---
  // The renderer cannot hit the host's HTTP surface directly (CORS + Electron
  // security), so every peer-side IDE call rides through here. Each handler is
  // a thin pass-through that converts thrown errors into envelopes so a renderer
  // `invoke` never rejects unexpectedly.

  teamCollabChannels.remoteTree.provider(async (req): Promise<TeamCollabResult<TeamTreeEntry[]>> => {
    try {
      const res = await teamRemoteClient.tree(req.baseUrl, req.token, req.dir ?? '');
      if ('error' in res) return { ok: false, error: res.error };
      return { ok: true, data: res.entries };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamCollabChannels.remoteFile.provider(async (req): Promise<TeamCollabResult<TeamFileRead>> => {
    try {
      const res = await teamRemoteClient.file(req.baseUrl, req.token, req.relPath);
      if ('error' in res) return { ok: false, error: res.error };
      return { ok: true, data: res.read };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamCollabChannels.remoteClaim.provider(async (req): Promise<TeamCollabResult<{ claim: unknown }>> => {
    try {
      const res = await teamRemoteClient.claim(req.baseUrl, req.token, req.relPath, req.intent);
      if ('error' in res) return { ok: false, error: res.error };
      return { ok: true, data: res.data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamCollabChannels.remoteRelease.provider(async (req): Promise<TeamCollabResult<boolean>> => {
    try {
      const res = await teamRemoteClient.release(req.baseUrl, req.token, req.relPath);
      if ('error' in res) return { ok: false, error: res.error };
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamCollabChannels.remoteWrite.provider(async (req): Promise<TeamCollabResult<GuardedWriteResult>> => {
    try {
      const res = await teamRemoteClient.write(req.baseUrl, req.token, req.relPath, req.data);
      if ('error' in res) return { ok: false, error: res.error };
      return { ok: true, data: res.result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Best-effort: pre-register the `/team/*` routes now that the providers are
  // bound. If building the session host throws (e.g. DB service init), the
  // providers are already registered, so a renderer invoke still gets a reply
  // and `publish` retries this lazily.
  try {
    ensureTeamRoutes();
  } catch (error) {
    console.error('[teamCollabBridge] Deferred team route setup failed:', error);
  }

  console.log('[teamCollabBridge] registered channels:', Object.values(TEAM_COLLAB_CHANNELS).join(', '));
}
