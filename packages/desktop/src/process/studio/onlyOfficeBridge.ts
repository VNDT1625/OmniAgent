/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ONLYOFFICE editing IPC bridge (Yêu cầu 2a — full Office editing on demand).
 *
 * Exposes the on-demand integration host ({@link onlyOfficeServer}) to the
 * renderer. The renderer asks to start an editing session for a file; the host
 * spins up (only now), and returns the URLs/keys the renderer feeds to the
 * ONLYOFFICE Document Server editor. When the editor closes, the renderer ends
 * the session and the host idles down.
 *
 * The Document Server URL itself is chosen on the renderer side (a Studio
 * setting) — this bridge only manages OUR integration host, which is the part
 * that must run "only when needed".
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import {
  endEditSession,
  getServerPort,
  setAdvertisedHost,
  startEditSession,
  stopServer,
  type EditSessionInfo,
} from './onlyOfficeServer';
import { ensureDocumentServer, type EnsureServerResult } from './documentServerManager';
import {
  getPrimarySession,
  listParticipants,
  publishSession,
  unpublishSession,
  type CollabParticipant,
  type PublishInfo,
} from './collabServer';
import {
  listDiscovered,
  startBeacon,
  startDiscovery,
  stopBeacon,
  stopDiscovery,
  type DiscoveredSession,
} from './collabDiscovery';
import { ensureCloudflared, startTunnel, stopAllTunnels } from './cloudflareTunnel';

/** IPC channel names for the ONLYOFFICE surface (renderer-safe contract). */
export const ONLYOFFICE_CHANNELS = {
  editStart: 'studio.office-edit-start',
  editStop: 'studio.office-edit-stop',
  ensureServer: 'studio.office-ensure-server',
  collabPublish: 'studio.collab-publish',
  collabUnpublish: 'studio.collab-unpublish',
  collabJoin: 'studio.collab-join',
  collabParticipants: 'studio.collab-participants',
  collabDiscoverStart: 'studio.collab-discover-start',
  collabDiscoverStop: 'studio.collab-discover-stop',
  collabDiscoverList: 'studio.collab-discover-list',
} as const;

/** Request for {@link ONLYOFFICE_CHANNELS.editStart}. */
export type OfficeEditStartRequest = {
  /** Absolute path of the file to edit. */
  path: string;
  /**
   * Host the Document Server uses to reach our integration host. Default
   * `127.0.0.1`; when DS runs in Docker use `host.docker.internal`.
   */
  advertisedHost?: string;
};

/** Request for {@link ONLYOFFICE_CHANNELS.editStop}. */
export type OfficeEditStopRequest = { token: string };

/** Request for {@link ONLYOFFICE_CHANNELS.ensureServer}. */
export type EnsureServerRequest = { configuredUrl?: string };

/** Request for {@link ONLYOFFICE_CHANNELS.collabPublish}. */
export type CollabPublishRequest = {
  /** Absolute path of the file to share. */
  path: string;
  /** Document Server base URL (host LAN-reachable). */
  documentServerUrl: string;
  /** Join password (defaults to 123456 when empty). */
  password?: string;
  /** Host display name. */
  hostName?: string;
  /** Host the DS uses to reach the integration host (host.docker.internal for Docker). */
  advertisedHost?: string;
  /**
   * Share over the Internet (different networks) via a Cloudflare quick tunnel.
   * When true, the Document Server is exposed publicly and peers join with the
   * returned public URL instead of a LAN code.
   */
  online?: boolean;
};

/** Request for {@link ONLYOFFICE_CHANNELS.collabJoin}. */
export type CollabJoinRequest = {
  /** Join code `<ip>:<port>` from the host. */
  joinCode: string;
  /** Join password. */
  password: string;
  /** This peer's display name. */
  name?: string;
};

/** Request for {@link ONLYOFFICE_CHANNELS.collabParticipants}. */
export type CollabParticipantsRequest = { shareId: string; baseUrl?: string };

/** Editor config a peer needs (mirrors the host's `/collab/join` response). */
export type CollabJoinData = {
  shareId: string;
  documentServerUrl: string;
  documentType: 'word' | 'cell' | 'slide';
  fileType: string;
  title: string;
  documentKey: string;
  downloadUrl: string;
  callbackUrl: string;
  participant: CollabParticipant;
};

/** Result envelope — always resolves so the renderer can branch on `ok`. */
export type OfficeEditResult = { ok: true; data: EditSessionInfo } | { ok: false; error: string };
export type CollabPublishResult = { ok: true; data: PublishInfo } | { ok: false; error: string };
export type CollabJoinResult =
  | { ok: true; data: CollabJoinData }
  | { ok: false; error: string; code?: 'bad-password' | 'no-session' | 'unreachable' };
export type CollabParticipantsResult = { ok: true; participants: CollabParticipant[] } | { ok: false; error: string };
export type CollabDiscoverResult = { ok: true; sessions: DiscoveredSession[] };

/** Typed ONLYOFFICE channels. Exported for bootstrap registration wiring. */
export const onlyOfficeChannels = {
  editStart: bridge.buildProvider<OfficeEditResult, OfficeEditStartRequest>(ONLYOFFICE_CHANNELS.editStart),
  editStop: bridge.buildProvider<{ ok: true }, OfficeEditStopRequest>(ONLYOFFICE_CHANNELS.editStop),
  ensureServer: bridge.buildProvider<EnsureServerResult, EnsureServerRequest>(ONLYOFFICE_CHANNELS.ensureServer),
  collabPublish: bridge.buildProvider<CollabPublishResult, CollabPublishRequest>(ONLYOFFICE_CHANNELS.collabPublish),
  collabUnpublish: bridge.buildProvider<{ ok: true }, { shareId: string }>(ONLYOFFICE_CHANNELS.collabUnpublish),
  collabJoin: bridge.buildProvider<CollabJoinResult, CollabJoinRequest>(ONLYOFFICE_CHANNELS.collabJoin),
  collabParticipants: bridge.buildProvider<CollabParticipantsResult, CollabParticipantsRequest>(
    ONLYOFFICE_CHANNELS.collabParticipants
  ),
  collabDiscoverStart: bridge.buildProvider<{ ok: true }, void>(ONLYOFFICE_CHANNELS.collabDiscoverStart),
  collabDiscoverStop: bridge.buildProvider<{ ok: true }, void>(ONLYOFFICE_CHANNELS.collabDiscoverStop),
  collabDiscoverList: bridge.buildProvider<CollabDiscoverResult, void>(ONLYOFFICE_CHANNELS.collabDiscoverList),
};

/** Map a file extension to the ONLYOFFICE documentType (word | cell | slide). */
const docTypeFor = (ext: string): 'word' | 'cell' | 'slide' => {
  if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) return 'cell';
  if (['pptx', 'ppt', 'odp'].includes(ext)) return 'slide';
  return 'word';
};

/**
 * Register the ONLYOFFICE IPC handlers. Idempotent. Intended to be called once
 * during Main-process bootstrap.
 */
export function registerOnlyOfficeBridge(): void {
  onlyOfficeChannels.editStart.provider(async (req): Promise<OfficeEditResult> => {
    try {
      if (!req.path || req.path.trim().length === 0) throw new Error('A file path is required.');
      if (req.advertisedHost) setAdvertisedHost(req.advertisedHost);
      const info = await startEditSession(req.path);
      return { ok: true, data: info };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[OnlyOfficeBridge] editStart failed:', error);
      return { ok: false, error: message };
    }
  });

  onlyOfficeChannels.editStop.provider(async (req): Promise<{ ok: true }> => {
    try {
      if (req.token) endEditSession(req.token);
    } catch (error) {
      console.error('[OnlyOfficeBridge] editStop failed:', error);
    }
    return { ok: true };
  });

  // Resolve a reachable Document Server — prefer the configured URL, else start
  // the managed Docker container on demand.
  onlyOfficeChannels.ensureServer.provider(async (req): Promise<EnsureServerResult> => {
    try {
      return await ensureDocumentServer(req.configuredUrl);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[OnlyOfficeBridge] ensureServer failed:', error);
      return { ok: false, reason: 'start-failed', detail };
    }
  });

  // Publish the open file for LAN co-editing: start an edit session (serves the
  // file + receives saves), then register a collab session keyed by its token.
  onlyOfficeChannels.collabPublish.provider(async (req): Promise<CollabPublishResult> => {
    try {
      if (!req.path || req.path.trim().length === 0) throw new Error('A file path is required.');
      if (!req.documentServerUrl) throw new Error('A Document Server URL is required to publish.');
      if (req.advertisedHost) setAdvertisedHost(req.advertisedHost);
      const info = await startEditSession(req.path);
      const ext = info.fileType;

      // Online mode: expose the Document Server AND our integration host to the
      // Internet via Cloudflare quick tunnels, then publish using the public URLs.
      let documentServerUrl = req.documentServerUrl.replace(/\/+$/, '');
      let downloadUrl = info.downloadUrl;
      let callbackUrl = info.callbackUrl;
      let onlineJoinUrl: string | undefined;
      if (req.online) {
        const ensured = await ensureCloudflared();
        if (!ensured.ok) {
          return {
            ok: false,
            error: (ensured as { detail: string }).detail || 'cloudflared is required for Internet sharing.',
          };
        }
        const dsTunnel = await startTunnel('ds', documentServerUrl);
        if (!dsTunnel.ok) {
          return {
            ok: false,
            error: `Could not open the Internet tunnel (${(dsTunnel as { reason: string }).reason}).`,
          };
        }
        const hostTunnel = await startTunnel('host', `http://localhost:${getServerPort()}`);
        if (!hostTunnel.ok) {
          stopAllTunnels();
          return {
            ok: false,
            error: `Could not open the Internet tunnel (${(hostTunnel as { reason: string }).reason}).`,
          };
        }
        documentServerUrl = dsTunnel.url;
        // The DS now fetches the file from the host through its public tunnel.
        downloadUrl = `${hostTunnel.url}/download/${info.token}`;
        callbackUrl = `${hostTunnel.url}/callback/${info.token}`;
        onlineJoinUrl = hostTunnel.url;
      }

      const data = publishSession({
        shareId: info.token,
        filePath: req.path,
        documentType: docTypeFor(ext),
        fileType: ext,
        title: info.title,
        documentKey: info.documentKey,
        password: req.password ?? '123456',
        documentServerUrl,
        downloadUrl,
        callbackUrl,
        hostPort: getServerPort(),
        hostName: req.hostName ?? 'Host',
      });
      // For online sharing the join code is the public host URL (peers reach the
      // password gate there); LAN keeps the <ip>:<port> code + a discovery beacon.
      if (onlineJoinUrl) {
        data.joinCode = onlineJoinUrl;
      } else {
        startBeacon({
          shareId: data.shareId,
          joinCode: data.joinCode,
          title: data.title,
          fileType: data.fileType,
          hostName: req.hostName ?? 'Host',
        });
      }
      return { ok: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[OnlyOfficeBridge] collabPublish failed:', error);
      return { ok: false, error: message };
    }
  });

  onlyOfficeChannels.collabUnpublish.provider(async (req): Promise<{ ok: true }> => {
    try {
      if (req.shareId) {
        unpublishSession(req.shareId);
        endEditSession(req.shareId);
        stopBeacon();
        stopAllTunnels();
      }
    } catch (error) {
      console.error('[OnlyOfficeBridge] collabUnpublish failed:', error);
    }
    return { ok: true };
  });

  // Join a host's published doc: call the host's `/collab/join` over the LAN
  // (the heavy lifting lives on the host; this peer just forwards credentials).
  onlyOfficeChannels.collabJoin.provider(async (req): Promise<CollabJoinResult> => {
    try {
      const raw = (req.joinCode || '').trim().replace(/\/+$/, '');
      // Accept either a LAN code `<ip>:<port>` or a full online URL `https://...`.
      let base: string;
      if (/^https?:\/\//i.test(raw)) {
        base = raw;
      } else if (/^[\w.-]+:\d+$/.test(raw)) {
        base = `http://${raw}`;
      } else {
        return { ok: false, error: 'Invalid join code. Use <ip>:<port> or the shared link.', code: 'no-session' };
      }
      const response = await fetch(`${base}/collab/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: req.password ?? '', name: req.name ?? '' }),
        signal: AbortSignal.timeout(12000),
      }).catch((): Response | null => null);
      if (!response)
        return {
          ok: false,
          error: 'Could not reach the host. Check the IP and that you are on the same network.',
          code: 'unreachable',
        };
      if (response.status === 401) return { ok: false, error: 'Wrong password.', code: 'bad-password' };
      if (!response.ok) return { ok: false, error: `Host returned HTTP ${response.status}.`, code: 'no-session' };
      const json = (await response.json()) as { ok: boolean; join?: CollabJoinData; error?: string };
      if (!json.ok || !json.join) return { ok: false, error: json.error ?? 'Join was rejected.', code: 'no-session' };
      return { ok: true, data: json.join };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[OnlyOfficeBridge] collabJoin failed:', error);
      return { ok: false, error: message, code: 'unreachable' };
    }
  });

  // Presence: host reads its own session; a peer polls the host over the LAN.
  onlyOfficeChannels.collabParticipants.provider(async (req): Promise<CollabParticipantsResult> => {
    try {
      if (req.baseUrl) {
        const response = await fetch(`${req.baseUrl.replace(/\/+$/, '')}/collab/participants/${req.shareId}`, {
          signal: AbortSignal.timeout(6000),
        }).catch((): Response | null => null);
        if (!response || !response.ok) return { ok: true, participants: [] };
        const json = (await response.json()) as { ok: boolean; participants?: CollabParticipant[] };
        return { ok: true, participants: json.participants ?? [] };
      }
      const local = getPrimarySession();
      if (local && local.shareId === req.shareId) return { ok: true, participants: listParticipants(req.shareId) };
      return { ok: true, participants: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  });

  // LAN auto-discovery: a peer starts listening for host beacons, then polls the
  // list. No Internet — UDP broadcast on the local subnet only.
  onlyOfficeChannels.collabDiscoverStart.provider(async (): Promise<{ ok: true }> => {
    startDiscovery();
    return { ok: true };
  });
  onlyOfficeChannels.collabDiscoverStop.provider(async (): Promise<{ ok: true }> => {
    stopDiscovery();
    return { ok: true };
  });
  onlyOfficeChannels.collabDiscoverList.provider(async (): Promise<CollabDiscoverResult> => {
    return { ok: true, sessions: listDiscovered() };
  });
}

/** Stop the integration host (e.g. on app shutdown). */
export const disposeOnlyOfficeBridge = (): Promise<void> => {
  stopBeacon();
  stopDiscovery();
  stopAllTunnels();
  return stopServer();
};
