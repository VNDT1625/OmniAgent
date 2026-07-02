/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `teamSessionHost` — the host-side brain of a **team collaboration session**.
 *
 * When a user "publishes" their open repo as a team session, this module turns
 * the host machine into the single source of truth for that repo: it wraps the
 * in-process {@link TeamEditService} (file leases + MTUI-guarded write/edit) and
 * adds the read surfaces peers need — browse the repo tree, read a file, pull
 * the Understand graph + Wiki (read-only), and run database queries by proxy
 * (so DB credentials never leave the host). Every successful write/edit triggers
 * a deterministic, model-free Understand-graph refresh ({@link KgRefreshFn}) so
 * the graph the host serves stays accurate as files change — the one allowed
 * mutation of Understand while peers are in read-only mode.
 *
 * Everything here is wired through injected collaborators ({@link TeamSessionHostDeps})
 * so the HTTP layer + the unit tests share one implementation with no Electron /
 * disk / network coupling at module scope.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { TeamEditService, TeamEditSnapshot, GuardedWriteResult, GuardedEditResult } from './teamEditService';
import { createTeamRequestQueue, type TeamRequestQueue, type TeamRequestQueueStatus } from './teamRequestQueue';
import type { FileLease } from './teamEditCoordinator';

/** One entry when listing a repo directory for a peer. */
export type TeamTreeEntry = { name: string; isDir: boolean };

/** A read of one file's content + MTUI content hash (for the peer editor). */
export type TeamFileRead = { content: string; contentHash?: string };

/** A database connection surfaced to peers (NEVER includes secrets). */
export type TeamDbConnection = { id: string; name: string; kind: string };

/** Result of a proxied database query (mirrors the host dbService result shape). */
export type TeamDbQueryResult = { columns: string[]; rows: unknown[][]; rowCount: number; error?: string };

/** Injected collaborators for {@link createTeamSessionHost}. */
export type TeamSessionHostDeps = {
  /** The shared team-edit service (leases + guarded write/edit). */
  team: TeamEditService;
  /**
   * Refresh ONE file's Understand-graph node from disk after a write/edit
   * (deterministic, no model). Best-effort — must never throw into the write.
   */
  refreshGraph: KgRefreshFn;
  /** Load the host's persisted Understand graph for a repo, or null. */
  loadGraph: (rootPath: string) => Promise<unknown | null>;
  /** Load the host's persisted Wiki for a repo, or null. */
  loadWiki: (rootPath: string) => Promise<unknown | null>;
  /** List database connections for the repo (no secrets). */
  listDbConnections: (rootPath: string) => Promise<TeamDbConnection[]>;
  /** Run a SQL query on the host BY PROXY (credentials stay on the host). */
  runDbQuery: (id: string, sql: string) => Promise<TeamDbQueryResult>;
  /** List a directory's entries; injected for testability. */
  readDir?: (absDir: string) => Promise<TeamTreeEntry[]>;
  /** Read a file's text; injected for testability. */
  readFileText?: (absPath: string) => Promise<string>;
  /** Optional per-workspace back-pressure queue for remote peer work. */
  queue?: TeamRequestQueue;
};

/** Signature of the deterministic graph-refresh hook. */
export type KgRefreshFn = (rootPath: string, relPath: string, absPath: string) => Promise<void>;

/** The host surface the HTTP routes call (one repo root per session). */
export type TeamSessionHost = {
  /** Register/refresh a peer as a participant in presence. */
  joinPeer: (rootPath: string, token: string, name: string) => void;
  /** Drop a peer from presence + release its leases. */
  leavePeer: (rootPath: string, token: string) => void;
  /** Current presence/leases/activity snapshot. */
  snapshot: (rootPath: string) => TeamEditSnapshot;
  /** Claim/renew a lease on behalf of a peer. */
  claim: (
    rootPath: string,
    token: string,
    relPath: string,
    intent?: string
  ) => { ok: true; lease: FileLease; renewed: boolean } | { ok: false; reason: 'held'; lease: FileLease };
  /** Release a peer's lease. */
  release: (rootPath: string, token: string, relPath: string) => boolean;
  /** List a repo-relative directory (defends against path escape). */
  listDir: (rootPath: string, relDir: string) => Promise<TeamTreeEntry[]>;
  /** Read a repo-relative file (defends against path escape). */
  readFile: (rootPath: string, relPath: string) => Promise<TeamFileRead>;
  /** Guarded full-file write on behalf of a peer (then refresh the graph). */
  write: (rootPath: string, token: string, relPath: string, data: string) => Promise<GuardedWriteResult>;
  /** Guarded anchor edit on behalf of a peer (then refresh the graph). */
  edit: (
    rootPath: string,
    token: string,
    relPath: string,
    oldText: string,
    newText: string
  ) => Promise<GuardedEditResult>;
  /** The host's Understand graph (read-only for peers). */
  understand: (rootPath: string) => Promise<unknown | null>;
  /** The host's Wiki (read-only for peers). */
  wiki: (rootPath: string) => Promise<unknown | null>;
  /** Database connections for the repo (no secrets). */
  dbConnections: (rootPath: string) => Promise<TeamDbConnection[]>;
  /** Proxy a database query on the host. */
  dbQuery: (rootPath: string, id: string, sql: string) => Promise<TeamDbQueryResult>;
  /** Current queue pressure for a workspace. */
  queueStatus: (rootPath: string) => TeamRequestQueueStatus;
};

/** Default Node fs directory listing. */
const defaultReadDir = async (absDir: string): Promise<TeamTreeEntry[]> => {
  const dirents = await fsp.readdir(absDir, { withFileTypes: true });
  return dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
};

/** Default Node fs text read. */
const defaultReadFileText = (absPath: string): Promise<string> => fsp.readFile(absPath, 'utf-8');

/**
 * Resolve a repo-relative path to an absolute one, REFUSING any path that
 * escapes the repo root (`..`, absolute paths, symlinked-out targets by prefix).
 * Throws on violation so a peer can never read/write outside the shared repo.
 */
export const resolveWithinRepo = (rootPath: string, relPath: string): string => {
  const cleaned = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(rootPath, cleaned);
  const rootResolved = path.resolve(rootPath);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    throw new Error('Path escapes the shared repository.');
  }
  return abs;
};

/**
 * Create a {@link TeamSessionHost} over the injected collaborators. Stateless
 * beyond what the team service holds; safe to build once and reuse per process.
 */
export const createTeamSessionHost = (deps: TeamSessionHostDeps): TeamSessionHost => {
  const readDir = deps.readDir ?? defaultReadDir;
  const readFileText = deps.readFileText ?? defaultReadFileText;
  const queue = deps.queue ?? createTeamRequestQueue();

  const joinPeer = (rootPath: string, token: string, name: string): void => {
    deps.team.join(rootPath, token, name, true);
  };

  const leavePeer = (rootPath: string, token: string): void => {
    deps.team.releaseAll(rootPath, token);
  };

  const listDir = (rootPath: string, relDir: string): Promise<TeamTreeEntry[]> =>
    queue.enqueue(rootPath, `tree:${relDir || '.'}`, async () => {
      const abs = resolveWithinRepo(rootPath, relDir || '.');
      const entries = await readDir(abs);
      // Hide noisy dot-dirs the IDE also hides; keep it light.
      return entries
        .filter((e) => !(e.isDir && (e.name === 'node_modules' || e.name === '.git')))
        .toSorted((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    });

  const readFile = (rootPath: string, relPath: string): Promise<TeamFileRead> =>
    queue.enqueue(rootPath, `file:${relPath}`, async () => {
      const abs = resolveWithinRepo(rootPath, relPath);
      const content = await readFileText(abs);
      return { content };
    });

  const write = (rootPath: string, token: string, relPath: string, data: string): Promise<GuardedWriteResult> =>
    queue.enqueue(rootPath, `write:${relPath}`, async () => {
      // Guard against path escape BEFORE touching the service/MTUI.
      const abs = resolveWithinRepo(rootPath, relPath);
      const result = await deps.team.write(rootPath, token, relPath, data);
      if (result.ok) await safeRefresh(deps.refreshGraph, rootPath, relPath, abs);
      return result;
    });

  const edit = (
    rootPath: string,
    token: string,
    relPath: string,
    oldText: string,
    newText: string
  ): Promise<GuardedEditResult> =>
    queue.enqueue(rootPath, `edit:${relPath}`, async () => {
      const abs = resolveWithinRepo(rootPath, relPath);
      const result = await deps.team.editReplace(rootPath, token, relPath, oldText, newText);
      if (result.ok) await safeRefresh(deps.refreshGraph, rootPath, relPath, abs);
      return result;
    });

  return {
    joinPeer,
    leavePeer,
    snapshot: (rootPath) => deps.team.snapshot(rootPath),
    claim: (rootPath, token, relPath, intent) => deps.team.claim(rootPath, token, relPath, intent),
    release: (rootPath, token, relPath) => deps.team.release(rootPath, token, relPath),
    listDir,
    readFile,
    write,
    edit,
    understand: (rootPath) => queue.enqueue(rootPath, 'understand', () => deps.loadGraph(rootPath)),
    wiki: (rootPath) => queue.enqueue(rootPath, 'wiki', () => deps.loadWiki(rootPath)),
    dbConnections: (rootPath) => queue.enqueue(rootPath, 'db-connections', () => deps.listDbConnections(rootPath)),
    dbQuery: (rootPath, id, sql) => queue.enqueue(rootPath, `db-query:${id}`, () => deps.runDbQuery(id, sql)),
    queueStatus: (rootPath) => queue.status(rootPath),
  };
};

/** Run the graph refresh, swallowing any error (a refresh must never fail a write). */
const safeRefresh = async (fn: KgRefreshFn, rootPath: string, relPath: string, absPath: string): Promise<void> => {
  try {
    await fn(rootPath, relPath, absPath);
  } catch {
    /* best-effort */
  }
};
