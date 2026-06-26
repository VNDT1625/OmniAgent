/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the team-collaboration control surface
 * (`ide.team-collab-*`). The Main bridge imports Node-only modules, so the
 * renderer mirrors the channel-name strings, rebuilds matching providers, and
 * borrows only TYPES via `import type` (same pattern as `teamEditClient`).
 *
 * Host: `publish` / `unpublish` / `status`.
 * Peer: `join` / `leave` / `remoteSnapshot` / `remoteTree` / `remoteFile` /
 *        `remoteClaim` / `remoteRelease` / `remoteWrite`.
 *
 * Every invoke is timeout-guarded so an unregistered channel (bridge not wired)
 * rejects fast instead of hanging the UI.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  PeerClaimRequest,
  PeerFileRequest,
  PeerReleaseRequest,
  PeerTreeRequest,
  PeerWriteRequest,
  TeamCollabResult,
  TeamJoinData,
  TeamJoinRequest,
  TeamPublishData,
  TeamPublishRequest,
  TeamStatusData,
} from '@process/ide/teamEdit/teamCollabBridge';
import type { RemoteTeamSnapshot } from '@process/ide/teamEdit/teamRemoteClient';
import type { TeamFileRead, TeamTreeEntry } from '@process/ide/teamEdit/teamSessionHost';
import type { GuardedWriteResult } from '@process/ide/teamEdit/teamEditService';

/** Team-collab channel names (mirror of the bridge consts). */
const TEAM_COLLAB_CHANNELS = {
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

/** Round-trip timeout (ms). Publish opens a tunnel, so allow generous time. */
const OP_TIMEOUT_MS = 60000;

/** Raw typed invokers. */
const channels = {
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

/** Error thrown when a team-collab IPC call does not reply within its budget. */
export class TeamCollabTimeoutError extends Error {
  constructor(channel: string, timeoutMs: number) {
    super(`[teamCollabClient] No reply on "${channel}" after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'TeamCollabTimeoutError';
  }
}

/** Race an `invoke` against a timeout so an unregistered channel rejects fast. */
const withTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs = OP_TIMEOUT_MS): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TeamCollabTimeoutError(channel, timeoutMs));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Timeout-guarded team-collab invokers for the renderer. */
export const teamCollabClient = {
  /** HOST: publish the open repo as a team session (LAN or, when `online`, WAN). */
  publish: (rootPath: string, password: string, online: boolean): Promise<TeamCollabResult<TeamPublishData>> =>
    withTimeout(TEAM_COLLAB_CHANNELS.publish, () => channels.publish.invoke({ rootPath, password, online })),
  /** HOST: stop sharing. */
  unpublish: (rootPath: string): Promise<TeamCollabResult<boolean>> =>
    withTimeout(TEAM_COLLAB_CHANNELS.unpublish, () => channels.unpublish.invoke({ rootPath }), 15000),
  /** HOST: current publish status. */
  status: (): Promise<TeamCollabResult<TeamStatusData>> =>
    withTimeout(TEAM_COLLAB_CHANNELS.status, () => channels.status.invoke(), 15000),
  /** PEER: join a host's session by base URL (LAN ip:port or tunnel URL). */
  join: (baseUrl: string, password: string, name: string): Promise<TeamCollabResult<TeamJoinData>> =>
    withTimeout(TEAM_COLLAB_CHANNELS.join, () => channels.join.invoke({ baseUrl, password, name })),
  /** PEER: leave a session. */
  leave: (baseUrl: string, token: string): Promise<TeamCollabResult<boolean>> =>
    withTimeout(TEAM_COLLAB_CHANNELS.leave, () => channels.leave.invoke({ baseUrl, token }), 15000),
  /** PEER: poll the remote presence/leases/activity snapshot. */
  remoteSnapshot: (baseUrl: string, token: string): Promise<TeamCollabResult<RemoteTeamSnapshot>> =>
    withTimeout(TEAM_COLLAB_CHANNELS.remoteSnapshot, () => channels.remoteSnapshot.invoke({ baseUrl, token }), 15000),
  /** PEER: list a directory on the host (`dir` is repo-relative; '' = root). */
  remoteTree: (baseUrl: string, token: string, dir: string): Promise<TeamCollabResult<TeamTreeEntry[]>> =>
    withTimeout(TEAM_COLLAB_CHANNELS.remoteTree, () => channels.remoteTree.invoke({ baseUrl, token, dir }), 15000),
  /** PEER: read one file from the host. */
  remoteFile: (baseUrl: string, token: string, relPath: string): Promise<TeamCollabResult<TeamFileRead>> =>
    withTimeout(TEAM_COLLAB_CHANNELS.remoteFile, () => channels.remoteFile.invoke({ baseUrl, token, relPath }), 20000),
  /** PEER: claim a lease (presence-only, blocks other peers from claiming). */
  remoteClaim: (
    baseUrl: string,
    token: string,
    relPath: string,
    intent?: string
  ): Promise<TeamCollabResult<{ claim: unknown }>> =>
    withTimeout(
      TEAM_COLLAB_CHANNELS.remoteClaim,
      () => channels.remoteClaim.invoke({ baseUrl, token, relPath, intent }),
      15000
    ),
  /** PEER: release a previously-claimed lease. */
  remoteRelease: (baseUrl: string, token: string, relPath: string): Promise<TeamCollabResult<boolean>> =>
    withTimeout(
      TEAM_COLLAB_CHANNELS.remoteRelease,
      () => channels.remoteRelease.invoke({ baseUrl, token, relPath }),
      15000
    ),
  /** PEER: full-file write to host (lease-guarded, MTUI-backed). */
  remoteWrite: (
    baseUrl: string,
    token: string,
    relPath: string,
    data: string
  ): Promise<TeamCollabResult<GuardedWriteResult>> =>
    withTimeout(
      TEAM_COLLAB_CHANNELS.remoteWrite,
      () => channels.remoteWrite.invoke({ baseUrl, token, relPath, data }),
      20000
    ),
};

export type { TeamPublishData, TeamStatusData, TeamJoinData } from '@process/ide/teamEdit/teamCollabBridge';
export type { RemoteTeamSnapshot } from '@process/ide/teamEdit/teamRemoteClient';
export type { TeamFileRead, TeamTreeEntry } from '@process/ide/teamEdit/teamSessionHost';
