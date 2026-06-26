/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `teamEditCoordinator` — the pure, in-memory brain for **Agent Team Edit**.
 *
 * The goal (per the user) is a LIGHT collaboration model focused on multiple
 * AGENTS (company roles / CLI-agent chat tabs) plus the user dividing work on
 * ONE open workspace WITHOUT stepping on each other — not Google-Docs-style
 * per-keystroke co-typing. So instead of a CRDT we coordinate ownership at the
 * FILE level with an advisory **lease**:
 *
 *  - A participant (`agentId`) `claim`s a file before editing it. While the lease
 *    is held, anyone else who tries to claim/write that file is told who holds it
 *    (a conflict) rather than silently overwriting their work.
 *  - Leases auto-expire after a TTL so a crashed/forgotten agent never locks a
 *    file forever; a `heartbeat` (or a fresh write) renews it.
 *  - `release` drops a lease early when the agent is done (criterion "làm xong
 *    rồi nhả"), mirroring the company orchestrator's ephemeral-worker model.
 *
 * This mirrors `subagent-parallel.md`: parallel work is safe when split BY FILE;
 * the lease makes "two agents touch the same file" explicit so the caller can
 * serialise instead of clobbering.
 *
 * The module is PURE: time is injected (`now`), there is no fs / IPC / Electron
 * access, and every method is deterministic — so it is fully unit-testable. The
 * service layer (`teamEditService.ts`) wires it to MTUI-backed writes and the
 * renderer bridge.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** A participant in a team-edit session (an agent, a CLI tab, or the user). */
export type TeamParticipant = {
  /** Stable id the participant passes on every call (agent id / tab id / `user`). */
  agentId: string;
  /** Human-readable label shown in the presence UI. */
  label: string;
  /** Cursor/presence colour (hex), assigned round-robin on first sight. */
  color: string;
  /** Whether this participant is the human user (vs an agent). */
  isUser: boolean;
  /** First-seen timestamp (Unix ms). */
  joinedAt: number;
  /** Last activity timestamp (Unix ms) — claim / heartbeat / write / release. */
  lastSeenAt: number;
};

/** An active lease on one file (the advisory "who owns this file right now"). */
export type FileLease = {
  /** Workspace-relative, forward-slash path of the leased file. */
  relPath: string;
  /** The participant that holds the lease. */
  agentId: string;
  /** When the lease was first acquired (Unix ms). */
  acquiredAt: number;
  /** When the lease was last renewed (claim / heartbeat / write) (Unix ms). */
  renewedAt: number;
  /** When the lease expires if not renewed (Unix ms). */
  expiresAt: number;
  /** Optional short note on what the holder is doing (shown in the UI). */
  intent?: string;
};

/** One entry in the rolling activity log (presence + audit feed). */
export type TeamActivity = {
  /** Monotonic sequence number (UI ordering / dedupe). */
  seq: number;
  /** When it happened (Unix ms). */
  at: number;
  /** What happened. */
  kind: 'join' | 'claim' | 'release' | 'write' | 'expire' | 'conflict';
  /** The participant that acted (the would-be writer for `conflict`). */
  agentId: string;
  /** The file involved, when relevant (workspace-relative). */
  relPath?: string;
  /** For `conflict`: the agent that currently holds the contested lease. */
  byAgentId?: string;
  /** Optional human detail (intent, byte count, …). */
  detail?: string;
};

/** Result of a claim attempt. */
export type ClaimResult =
  | { ok: true; lease: FileLease; renewed: boolean }
  | { ok: false; reason: 'held'; lease: FileLease };

/** Result of a guard check before a write. */
export type WriteGuard =
  | { allowed: true; lease: FileLease | null }
  | { allowed: false; reason: 'held'; lease: FileLease };

/** Tuning + injected collaborators for {@link createTeamEditCoordinator}. */
export type TeamEditCoordinatorDeps = {
  /** Time source (injected for deterministic tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Lease time-to-live in ms before it auto-expires. Default 2 minutes. */
  leaseTtlMs?: number;
  /** Cap on the rolling activity log kept in memory. Default 200. */
  maxActivity?: number;
};

/** The team-edit coordinator surface (pure, in-memory). */
export type TeamEditCoordinator = {
  /** Register / refresh a participant; returns its presence record. */
  join: (agentId: string, label: string, isUser?: boolean) => TeamParticipant;
  /** Claim (or renew) the lease on a file. Conflicts return the holding lease. */
  claim: (agentId: string, relPath: string, intent?: string) => ClaimResult;
  /** Renew every lease held by an agent + its presence (keep-alive). */
  heartbeat: (agentId: string) => void;
  /** Release one file's lease (no-op if not held by `agentId`). */
  release: (agentId: string, relPath: string) => boolean;
  /** Release every lease held by an agent (e.g. its chat tab closed). */
  releaseAll: (agentId: string) => void;
  /** Check whether `agentId` may write `relPath` right now (advisory). */
  canWrite: (agentId: string, relPath: string) => WriteGuard;
  /**
   * Record that `agentId` wrote `relPath`. Auto-acquires/renews the lease for the
   * writer (so a write implies ownership) and logs the activity.
   */
  noteWrite: (agentId: string, relPath: string, detail?: string) => void;
  /** Log a conflict (a blocked write attempt) for the activity feed. */
  noteConflict: (agentId: string, relPath: string, holder: FileLease) => void;
  /** Snapshot of all live (non-expired) leases. */
  listLeases: () => FileLease[];
  /** Snapshot of all known participants. */
  listParticipants: () => TeamParticipant[];
  /** The most recent activity entries (newest last), up to `limit`. */
  listActivity: (limit?: number) => TeamActivity[];
  /** Drop everything (e.g. the workspace folder changed). */
  reset: () => void;
};

/** Default lease TTL — long enough to survive a slow agent turn, short enough to free a crashed one. */
const DEFAULT_LEASE_TTL_MS = 2 * 60 * 1000;
/** Default rolling activity-log cap. */
const DEFAULT_MAX_ACTIVITY = 200;

/** Presence colour palette (assigned round-robin, same hues as collabServer). */
const COLORS = ['#2C7FFF', '#22C55E', '#F59E0B', '#EF4444', '#A855F7', '#06B6D4', '#EC4899', '#84CC16'];

/** Normalise a path to workspace-relative, forward-slash form for stable keys. */
export const normalizeRelPath = (relPath: string): string =>
  relPath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * Create a {@link TeamEditCoordinator}. Pure + in-memory: inject `now` for
 * deterministic tests; nothing here touches fs / IPC.
 */
export const createTeamEditCoordinator = (deps: TeamEditCoordinatorDeps = {}): TeamEditCoordinator => {
  const now = deps.now ?? Date.now;
  const ttl = deps.leaseTtlMs && deps.leaseTtlMs > 0 ? deps.leaseTtlMs : DEFAULT_LEASE_TTL_MS;
  const maxActivity = deps.maxActivity && deps.maxActivity > 0 ? deps.maxActivity : DEFAULT_MAX_ACTIVITY;

  const participants = new Map<string, TeamParticipant>();
  const leases = new Map<string, FileLease>();
  const activity: TeamActivity[] = [];
  let seq = 0;

  /** Assign a stable colour to the Nth distinct participant. */
  const colorForIndex = (index: number): string => COLORS[index % COLORS.length];

  /** Append an activity entry, trimming the log to its cap. */
  const log = (entry: Omit<TeamActivity, 'seq' | 'at'>): void => {
    seq += 1;
    activity.push({ seq, at: now(), ...entry });
    if (activity.length > maxActivity) activity.splice(0, activity.length - maxActivity);
  };

  /** Drop a lease if it has expired; returns the live lease or undefined. */
  const liveLease = (relPath: string): FileLease | undefined => {
    const lease = leases.get(relPath);
    if (!lease) return undefined;
    if (lease.expiresAt <= now()) {
      leases.delete(relPath);
      log({ kind: 'expire', agentId: lease.agentId, relPath });
      return undefined;
    }
    return lease;
  };

  /** Sweep every expired lease (used by snapshots so the UI never shows stale ones). */
  const sweep = (): void => {
    const t = now();
    for (const [relPath, lease] of leases) {
      if (lease.expiresAt <= t) {
        leases.delete(relPath);
        log({ kind: 'expire', agentId: lease.agentId, relPath });
      }
    }
  };

  const touch = (agentId: string): void => {
    const p = participants.get(agentId);
    if (p) p.lastSeenAt = now();
  };

  const join = (agentId: string, label: string, isUser = false): TeamParticipant => {
    const existing = participants.get(agentId);
    if (existing) {
      existing.label = label || existing.label;
      existing.lastSeenAt = now();
      return existing;
    }
    const participant: TeamParticipant = {
      agentId,
      label: label || agentId,
      color: colorForIndex(participants.size),
      isUser,
      joinedAt: now(),
      lastSeenAt: now(),
    };
    participants.set(agentId, participant);
    log({ kind: 'join', agentId });
    return participant;
  };

  const claim = (agentId: string, relPath: string, intent?: string): ClaimResult => {
    const key = normalizeRelPath(relPath);
    join(agentId, agentId); // ensure presence (label refreshed by explicit join)
    const held = liveLease(key);
    const t = now();
    if (held && held.agentId !== agentId) {
      log({ kind: 'conflict', agentId, relPath: key, byAgentId: held.agentId });
      return { ok: false, reason: 'held', lease: held };
    }
    if (held && held.agentId === agentId) {
      held.renewedAt = t;
      held.expiresAt = t + ttl;
      if (intent !== undefined) held.intent = intent;
      log({ kind: 'claim', agentId, relPath: key, detail: intent });
      return { ok: true, lease: held, renewed: true };
    }
    const lease: FileLease = {
      relPath: key,
      agentId,
      acquiredAt: t,
      renewedAt: t,
      expiresAt: t + ttl,
      ...(intent !== undefined ? { intent } : {}),
    };
    leases.set(key, lease);
    log({ kind: 'claim', agentId, relPath: key, detail: intent });
    return { ok: true, lease, renewed: false };
  };

  const heartbeat = (agentId: string): void => {
    touch(agentId);
    const t = now();
    for (const lease of leases.values()) {
      if (lease.agentId === agentId && lease.expiresAt > t) lease.expiresAt = t + ttl;
    }
  };

  const release = (agentId: string, relPath: string): boolean => {
    const key = normalizeRelPath(relPath);
    const lease = leases.get(key);
    if (!lease || lease.agentId !== agentId) return false;
    leases.delete(key);
    touch(agentId);
    log({ kind: 'release', agentId, relPath: key });
    return true;
  };

  const releaseAll = (agentId: string): void => {
    for (const [key, lease] of leases) {
      if (lease.agentId === agentId) {
        leases.delete(key);
        log({ kind: 'release', agentId, relPath: key });
      }
    }
  };

  const canWrite = (agentId: string, relPath: string): WriteGuard => {
    const key = normalizeRelPath(relPath);
    const held = liveLease(key);
    if (held && held.agentId !== agentId) return { allowed: false, reason: 'held', lease: held };
    return { allowed: true, lease: held ?? null };
  };

  const noteWrite = (agentId: string, relPath: string, detail?: string): void => {
    const key = normalizeRelPath(relPath);
    join(agentId, agentId);
    const t = now();
    const held = liveLease(key);
    if (held && held.agentId === agentId) {
      held.renewedAt = t;
      held.expiresAt = t + ttl;
    } else if (!held) {
      // A write implies ownership: auto-acquire a lease for the writer.
      leases.set(key, { relPath: key, agentId, acquiredAt: t, renewedAt: t, expiresAt: t + ttl });
    }
    log({ kind: 'write', agentId, relPath: key, detail });
  };

  const noteConflict = (agentId: string, relPath: string, holder: FileLease): void => {
    log({ kind: 'conflict', agentId, relPath: normalizeRelPath(relPath), byAgentId: holder.agentId });
  };

  const listLeases = (): FileLease[] => {
    sweep();
    return [...leases.values()].toSorted((a, b) => a.relPath.localeCompare(b.relPath));
  };

  const listParticipants = (): TeamParticipant[] =>
    [...participants.values()].toSorted((a, b) => a.joinedAt - b.joinedAt);

  const listActivity = (limit?: number): TeamActivity[] => {
    const cap = limit && limit > 0 ? limit : activity.length;
    return activity.slice(Math.max(0, activity.length - cap));
  };

  const reset = (): void => {
    participants.clear();
    leases.clear();
    activity.length = 0;
    seq = 0;
  };

  return {
    join,
    claim,
    heartbeat,
    release,
    releaseAll,
    canWrite,
    noteWrite,
    noteConflict,
    listLeases,
    listParticipants,
    listActivity,
    reset,
  };
};
