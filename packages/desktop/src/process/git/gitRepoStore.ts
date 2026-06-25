/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `gitRepoStore` — CRUD + persistence for the repos the user has registered with
 * the Git Manager. Mirrors `terminalScheduleStore`: the {@link GitRepo} list is
 * mirrored to `git-repos.json` in `userData`, written atomically (tmp + rename),
 * and read defensively (missing/corrupt → empty list, bad records dropped).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GitRepo } from './gitTypes';

const REPOS_FILE = 'git-repos.json';

export type RepoFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

const defaultFs: RepoFs = {
  readFile: (p, e) => fs.promises.readFile(p, e),
  writeFile: (p, d, o) => fs.promises.writeFile(p, d, o),
  rename: (a, b) => fs.promises.rename(a, b),
  mkdir: (d, o) => fs.promises.mkdir(d, o),
};

export type RepoStoreOptions = {
  dir?: string;
  fs?: RepoFs;
  now?: () => number;
  newId?: () => string;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isFileNotFound = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Coerce an unknown record into a valid {@link GitRepo}, or null to drop it. */
const normalise = (v: unknown, now: number): GitRepo | null => {
  if (!isObject(v) || typeof v.remoteUrl !== 'string' || typeof v.localPath !== 'string') return null;
  return {
    id: typeof v.id === 'string' && v.id.length > 0 ? v.id : randomUUID(),
    name: str(v.name) ?? deriveName(v.remoteUrl),
    remoteUrl: v.remoteUrl,
    localPath: v.localPath,
    branch: str(v.branch) ?? 'main',
    credentialId: typeof v.credentialId === 'string' ? v.credentialId : null,
    createdAt: num(v.createdAt) ?? now,
    lastPushAt: num(v.lastPushAt),
    lastPullAt: num(v.lastPullAt),
  };
};

/** Best-effort repo name from a remote URL (`.../owner/repo.git` → `repo`). */
export const deriveName = (remoteUrl: string): string => {
  const cleaned = remoteUrl
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const last = cleaned.split(/[/:]/).pop();
  return last && last.length > 0 ? last : 'repo';
};

/** Public contract of the repo store. */
export type IGitRepoStore = {
  list(): Promise<GitRepo[]>;
  get(id: string): Promise<GitRepo | undefined>;
  add(input: {
    remoteUrl: string;
    localPath: string;
    branch?: string;
    name?: string;
    credentialId?: string | null;
  }): Promise<GitRepo>;
  patch(id: string, updates: Partial<GitRepo>): Promise<GitRepo | undefined>;
  remove(id: string): Promise<GitRepo[]>;
  onChange(listener: (repos: GitRepo[]) => void): () => void;
};

/** Create a repo store rooted at `dir` (defaults to userData). */
export const createGitRepoStore = (options?: RepoStoreOptions): IGitRepoStore => {
  const now = options?.now ?? Date.now;
  const newId = options?.newId ?? randomUUID;
  const fsImpl = options?.fs ?? defaultFs;
  const filePath = path.join(options?.dir ?? app.getPath('userData'), REPOS_FILE);
  const listeners = new Set<(repos: GitRepo[]) => void>();

  let cache: GitRepo[] = [];
  let loaded = false;

  const persist = async (next: GitRepo[]): Promise<GitRepo[]> => {
    cache = next;
    const tmpPath = `${filePath}.tmp`;
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    await fsImpl.writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, filePath);
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        console.error('[GitRepoStore] onChange listener threw:', error);
      }
    }
    return next;
  };

  const load = async (): Promise<void> => {
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      cache = Array.isArray(parsed)
        ? parsed.map((r) => normalise(r, now())).filter((r): r is GitRepo => r !== null)
        : [];
    } catch (error) {
      if (!isFileNotFound(error)) console.warn('[GitRepoStore] read failed; using empty list:', error);
      cache = [];
    }
    loaded = true;
  };

  const ensureLoaded = async (): Promise<void> => {
    if (!loaded) await load();
  };

  return {
    async list() {
      await ensureLoaded();
      return cache;
    },
    async get(id) {
      await ensureLoaded();
      return cache.find((r) => r.id === id);
    },
    async add(input) {
      await ensureLoaded();
      const repo: GitRepo = {
        id: newId(),
        name: input.name?.trim() || deriveName(input.remoteUrl),
        remoteUrl: input.remoteUrl.trim(),
        localPath: input.localPath.trim(),
        branch: input.branch?.trim() || 'main',
        credentialId: input.credentialId ?? null,
        createdAt: now(),
        lastPushAt: null,
        lastPullAt: null,
      };
      await persist([...cache, repo]);
      return repo;
    },
    async patch(id, updates) {
      await ensureLoaded();
      const existing = cache.find((r) => r.id === id);
      if (!existing) return undefined;
      const next: GitRepo = { ...existing, ...updates, id: existing.id };
      await persist(cache.map((r) => (r.id === id ? next : r)));
      return next;
    },
    async remove(id) {
      await ensureLoaded();
      return persist(cache.filter((r) => r.id !== id));
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
