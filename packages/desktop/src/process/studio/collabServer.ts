/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `collabServer` — real-time collaborative editing over the LAN (host model).
 *
 * The host (the user who owns the file) "publishes" a document: we ensure the
 * ONLYOFFICE Document Server + our integration host are up and reachable on the
 * LAN, then mint a **join code** (`<lan-ip>:<port>`) and a password. Peers on
 * the same network "join" with that code + password; their editor points at the
 * SAME Document Server and the SAME `documentKey`, so ONLYOFFICE's built-in
 * co-editing (operational transform, live cursors) merges everyone's edits —
 * Canvas/Google-Docs style. We do NOT implement OT ourselves.
 *
 * Security: this opens a small HTTP control surface on the LAN. The `/collab/*`
 * routes are password-gated (constant-time compare of a SHA-256 of the secret).
 * The integration host's file routes remain token-scoped. Default password is
 * `123456` (weak — the UI warns and lets the host change it). LAN-only: the
 * join code is a private IP; cross-Internet needs a relay (future work).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

/** One published collaboration session (one shared document). */
export type CollabSession = {
  /** Stable share id (also the integration-host edit token reused for files). */
  shareId: string;
  /** Absolute path of the shared file (host-side). */
  filePath: string;
  /** ONLYOFFICE documentType: word | cell | slide. */
  documentType: 'word' | 'cell' | 'slide';
  /** File extension without dot. */
  fileType: string;
  /** Display title. */
  title: string;
  /** Stable document key all peers share (co-editing requires identical keys). */
  documentKey: string;
  /** SHA-256 hash of the join password. */
  passwordHash: string;
  /** Base URL of the Document Server peers should load (host LAN URL). */
  documentServerUrl: string;
  /** URL the Document Server fetches the file from (host integration host). */
  downloadUrl: string;
  /** URL the Document Server posts saves to (host integration host). */
  callbackUrl: string;
  /** Created-at (Unix ms). */
  createdAt: number;
  /** Connected participants by id. */
  participants: Map<string, CollabParticipant>;
};

/** A participant in a collab session. */
export type CollabParticipant = {
  id: string;
  name: string;
  /** Cursor/presence color (hex). */
  color: string;
  /** `true` for the host. */
  isHost: boolean;
  joinedAt: number;
};

/** Public session info returned to the host renderer on publish. */
export type PublishInfo = {
  shareId: string;
  /** The code peers type to join: `<ip>:<port>`. */
  joinCode: string;
  /** Document Server URL (host LAN). */
  documentServerUrl: string;
  /** Integration host base URL (host LAN). */
  hostBaseUrl: string;
  /** documentType for the editor. */
  documentType: 'word' | 'cell' | 'slide';
  fileType: string;
  title: string;
  documentKey: string;
  /** Detected LAN IPs (first is used in the code; others shown as alternatives). */
  lanIps: string[];
};

/** Editor config a peer needs to mount the shared document. */
export type JoinInfo = {
  shareId: string;
  documentServerUrl: string;
  documentType: 'word' | 'cell' | 'slide';
  fileType: string;
  title: string;
  documentKey: string;
  /** URL the DS fetches the file from (integration host). */
  downloadUrl: string;
  /** URL the DS posts saves to. */
  callbackUrl: string;
  /** This peer's assigned identity. */
  participant: CollabParticipant;
};

/** Palette for participant cursor colors (assigned round-robin). */
const COLORS = ['#2C7FFF', '#22C55E', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4', '#EC4899', '#84CC16'];

const sessions = new Map<string, CollabSession>();

/** Hash a password with SHA-256 (hex). */
const hashPassword = (password: string): string => createHash('sha256').update(password, 'utf8').digest('hex');

/** Constant-time compare of two hex hashes (avoids timing leaks). */
export const passwordMatches = (passwordHash: string, candidate: string): boolean => {
  const a = Buffer.from(passwordHash, 'hex');
  const b = Buffer.from(hashPassword(candidate), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/** Enumerate non-internal IPv4 addresses (LAN candidates), private ranges first. */
export const detectLanIps = (): string[] => {
  const ifaces = networkInterfaces();
  const ips: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const ni of list) {
      // Node <18 uses family 'IPv4'; >=18 may use the number 4.
      const isV4 = ni.family === 'IPv4' || (ni.family as unknown as number) === 4;
      if (isV4 && !ni.internal && ni.address) ips.push(ni.address);
    }
  }
  // Prefer common private LAN ranges (192.168.*, 10.*, 172.16–31.*).
  const isPrivate = (ip: string): boolean => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return ips.toSorted((x, y) => Number(isPrivate(y)) - Number(isPrivate(x)));
};

/** Generate a random participant color. */
const colorForIndex = (index: number): string => COLORS[index % COLORS.length];

/** Generate a short random id. */
const newId = (prefix: string): string => `${prefix}_${randomBytes(8).toString('hex')}`;

/**
 * Register a published collaboration session. The integration host must already
 * be serving `filePath` (the caller passes the documentKey + URLs it built).
 *
 * @returns The host-facing publish info (join code, URLs, identity).
 */
export const publishSession = (params: {
  shareId: string;
  filePath: string;
  documentType: 'word' | 'cell' | 'slide';
  fileType: string;
  title: string;
  documentKey: string;
  password: string;
  documentServerUrl: string;
  downloadUrl: string;
  callbackUrl: string;
  hostPort: number;
  hostName: string;
}): PublishInfo => {
  const lanIps = detectLanIps();
  const hostParticipant: CollabParticipant = {
    id: newId('user'),
    name: params.hostName || 'Host',
    color: colorForIndex(0),
    isHost: true,
    joinedAt: Date.now(),
  };
  const session: CollabSession = {
    shareId: params.shareId,
    filePath: params.filePath,
    documentType: params.documentType,
    fileType: params.fileType,
    title: params.title,
    documentKey: params.documentKey,
    passwordHash: hashPassword(params.password || '123456'),
    documentServerUrl: params.documentServerUrl,
    downloadUrl: params.downloadUrl,
    callbackUrl: params.callbackUrl,
    createdAt: Date.now(),
    participants: new Map([[hostParticipant.id, hostParticipant]]),
  };
  sessions.set(params.shareId, session);

  const ip = lanIps[0] ?? '127.0.0.1';
  return {
    shareId: params.shareId,
    joinCode: `${ip}:${params.hostPort}`,
    documentServerUrl: params.documentServerUrl,
    hostBaseUrl: `http://${ip}:${params.hostPort}`,
    documentType: params.documentType,
    fileType: params.fileType,
    title: params.title,
    documentKey: params.documentKey,
    lanIps,
  };
};

/** Look up a session. */
export const getSession = (shareId: string): CollabSession | undefined => sessions.get(shareId);

/** Whether any collab session is published. */
export const hasSessions = (): boolean => sessions.size > 0;

/** The single (most recent) published session, if any — peers join "the" doc. */
export const getPrimarySession = (): CollabSession | undefined => {
  let latest: CollabSession | undefined;
  for (const s of sessions.values()) {
    if (!latest || s.createdAt > latest.createdAt) latest = s;
  }
  return latest;
};

/** Admit a peer to a session after the password has been verified. */
export const admitParticipant = (session: CollabSession, name: string): CollabParticipant => {
  const participant: CollabParticipant = {
    id: newId('user'),
    name: name.trim() || `Guest ${session.participants.size}`,
    color: colorForIndex(session.participants.size),
    isHost: false,
    joinedAt: Date.now(),
  };
  session.participants.set(participant.id, participant);
  return participant;
};

/** Remove a participant (on leave). */
export const removeParticipant = (shareId: string, participantId: string): void => {
  const s = sessions.get(shareId);
  s?.participants.delete(participantId);
};

/** List participants of a session (presence). */
export const listParticipants = (shareId: string): CollabParticipant[] => {
  const s = sessions.get(shareId);
  return s ? [...s.participants.values()] : [];
};

/** Stop sharing a session (host unpublish). Peers lose access on next request. */
export const unpublishSession = (shareId: string): void => {
  sessions.delete(shareId);
};

/** Drop all collab sessions (e.g. app shutdown). */
export const clearAllSessions = (): void => {
  sessions.clear();
};

// ---------------------------------------------------------------------------
// Team session (whole-repo collaboration — distinct from a single-doc collab)
// ---------------------------------------------------------------------------

/**
 * One published **team session**: a whole repository shared by its host so other
 * people + their agents can browse, edit (file-leased through MTUI), and read
 * the host's Understand graph / Wiki / Database — even across networks (the
 * bridge pairs this with a Cloudflare tunnel). Unlike {@link CollabSession}
 * (one ONLYOFFICE document), a team session is the host's IDE workspace.
 *
 * Ownership is one-directional: the host machine is the single source of truth
 * (files, KG, Wiki, DB all live on its disk); peers act remotely over HTTP.
 */
export type TeamSession = {
  /** Stable share id (also the peer-facing session token namespace). */
  shareId: string;
  /** Absolute repo root on the host disk. */
  repoRoot: string;
  /** Display name of the repo (folder basename). */
  repoName: string;
  /** SHA-256 hash of the join password. */
  passwordHash: string;
  /** Created-at (Unix ms). */
  createdAt: number;
  /** Admitted peers by their peer token (token == coordinator agentId). */
  peers: Map<string, TeamPeer>;
};

/** A peer admitted to a team session. */
export type TeamPeer = {
  /** Opaque token the peer sends on every request; also its coordinator agentId. */
  token: string;
  /** Display name shown in presence. */
  name: string;
  /** Presence color (hex). */
  color: string;
  joinedAt: number;
  /** Last request time (Unix ms) — for idle pruning. */
  lastSeenAt: number;
};

/** Public info returned to the host renderer when a team session is published. */
export type TeamPublishInfo = {
  shareId: string;
  /** LAN join code: `<ip>:<port>`. */
  joinCode: string;
  /** Integration-host base URL (host LAN). */
  hostBaseUrl: string;
  repoName: string;
  lanIps: string[];
};

const teamSessions = new Map<string, TeamSession>();

/** Publish a team session for a repo root. Replaces any prior session for it. */
export const publishTeamSession = (params: { repoRoot: string; repoName: string; password: string }): TeamSession => {
  // One active team session per repo root: drop a stale one first.
  for (const [id, s] of teamSessions) {
    if (s.repoRoot === params.repoRoot) teamSessions.delete(id);
  }
  const session: TeamSession = {
    shareId: newId('team'),
    repoRoot: params.repoRoot,
    repoName: params.repoName,
    passwordHash: hashPassword(params.password),
    createdAt: Date.now(),
    peers: new Map(),
  };
  teamSessions.set(session.shareId, session);
  return session;
};

/** Look up a team session by share id. */
export const getTeamSession = (shareId: string): TeamSession | undefined => teamSessions.get(shareId);

/** The single most-recently-published team session, if any (peers join "the" repo). */
export const getPrimaryTeamSession = (): TeamSession | undefined => {
  let latest: TeamSession | undefined;
  for (const s of teamSessions.values()) {
    if (!latest || s.createdAt > latest.createdAt) latest = s;
  }
  return latest;
};

/** Whether any team session is published. */
export const hasTeamSessions = (): boolean => teamSessions.size > 0;

/** Admit a peer after the password has been verified; returns the new peer. */
export const admitTeamPeer = (session: TeamSession, name: string): TeamPeer => {
  const peer: TeamPeer = {
    token: newId('peer'),
    name: name.trim() || `Guest ${session.peers.size + 1}`,
    color: colorForIndex(session.peers.size),
    joinedAt: Date.now(),
    lastSeenAt: Date.now(),
  };
  session.peers.set(peer.token, peer);
  return peer;
};

/** Resolve an admitted peer by token (and refresh its last-seen). */
export const touchTeamPeer = (session: TeamSession, token: string): TeamPeer | undefined => {
  const peer = session.peers.get(token);
  if (peer) peer.lastSeenAt = Date.now();
  return peer;
};

/** Remove a peer (on leave). */
export const removeTeamPeer = (shareId: string, token: string): void => {
  teamSessions.get(shareId)?.peers.delete(token);
};

/** Stop sharing a team session (host unpublish). */
export const unpublishTeamSession = (shareId: string): void => {
  teamSessions.delete(shareId);
};

/** Build the host-facing publish info for a team session. */
export const buildTeamPublishInfo = (session: TeamSession, hostPort: number): TeamPublishInfo => {
  const lanIps = detectLanIps();
  const ip = lanIps[0] ?? '127.0.0.1';
  return {
    shareId: session.shareId,
    joinCode: `${ip}:${hostPort}`,
    hostBaseUrl: `http://${ip}:${hostPort}`,
    repoName: session.repoName,
    lanIps,
  };
};
