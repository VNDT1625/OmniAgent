/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistence + CRUD layer for the "Make Video" feature.
 *
 * The full list of {@link VideoProject} records is mirrored to
 * `make-video-projects.json` in the Electron `userData` directory — the same
 * app-data-dir convention used by `manager-data.json` and `company.json`.
 * Writes go to a sibling `.tmp` file then rename into place so a process kill
 * mid-write never leaves a half-written (corrupt) file. Reads are defensive: a
 * missing/corrupt/partial file yields an empty list, and individual malformed
 * records are dropped rather than throwing.
 *
 * Testability: the directory, fs implementation, clock, and id generator are
 * all injectable via {@link MakeVideoStoreOptions}; tests target a temp dir or
 * an in-memory fs without touching real disk. `app.getPath` is resolved lazily
 * so callers that inject a `dir` never depend on a live Electron `app`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Scene, VideoProject } from './makeVideoTypes';

/** Name of the persisted document inside the app data directory. */
const MAKE_VIDEO_DATA_FILE = 'make-video-projects.json';

/** Minimal subset of `fs/promises` used here (injectable for tests). */
export type MakeVideoFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Default fs adapter backed by Node's `fs/promises`. */
const defaultFs: MakeVideoFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

/** Where + how the document is persisted. Both default to userData + `fs/promises`. */
export type MakeVideoStoreOptions = {
  /** Directory the data file lives in. Defaults to the Electron `userData` dir. */
  dir?: string;
  /** File-system implementation. Injectable for tests; defaults to `fs/promises`. */
  fs?: MakeVideoFs;
  /** Clock for `createdAt`/`updatedAt`. Defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  /** Id generator. Defaults to `crypto.randomUUID`. Injectable for tests. */
  newId?: () => string;
};

const resolveDir = (options?: MakeVideoStoreOptions): string => options?.dir ?? app.getPath('userData');
const resolveFs = (options?: MakeVideoStoreOptions): MakeVideoFs => options?.fs ?? defaultFs;
const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

// ---------------------------------------------------------------------------
// Defensive normalisation
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Coerce an unknown record into a valid {@link Scene}, falling back per field. */
const normaliseScene = (v: unknown, index: number, newId: () => string): Scene | null => {
  if (!isObject(v)) return null;
  return {
    id: str(v.id) || newId(),
    index: num(v.index) ?? index,
    title: str(v.title),
    narration: str(v.narration),
    imagePrompt: str(v.imagePrompt),
    imagePath: typeof v.imagePath === 'string' ? v.imagePath : null,
    imageError: typeof v.imageError === 'string' ? v.imageError : null,
    audioPath: typeof v.audioPath === 'string' ? v.audioPath : null,
    audioError: typeof v.audioError === 'string' ? v.audioError : null,
    videoClipPath: typeof v.videoClipPath === 'string' ? v.videoClipPath : null,
    videoClipError: typeof v.videoClipError === 'string' ? v.videoClipError : null,
    frameStartPath: typeof v.frameStartPath === 'string' ? v.frameStartPath : null,
    frameEndPath: typeof v.frameEndPath === 'string' ? v.frameEndPath : null,
  };
};

/** Coerce an unknown record into a valid {@link VideoProject}, or `null` to drop it. */
const normaliseProject = (v: unknown, now: number, newId: () => string): VideoProject | null => {
  if (!isObject(v) || typeof v.id !== 'string') return null;
  const scenes = Array.isArray(v.scenes)
    ? v.scenes.map((s, i) => normaliseScene(s, i, newId)).filter((x): x is Scene => x !== null)
    : [];
  return {
    id: v.id,
    topic: str(v.topic),
    style: str(v.style),
    language: str(v.language),
    scenes,
    createdAt: num(v.createdAt) ?? now,
    updatedAt: num(v.updatedAt) ?? now,
  };
};

/** Coerce an arbitrary parsed JSON value into a valid {@link VideoProject} list. */
const normaliseProjects = (parsed: unknown, now: number, newId: () => string): VideoProject[] => {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((p) => normaliseProject(p, now, newId)).filter((x): x is VideoProject => x !== null);
};

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/** Public contract of the Make Video store. */
export type IMakeVideoStore = {
  /** Load (and cache) the project list from disk. Safe — never throws on bad data. */
  load(): Promise<VideoProject[]>;
  /** All persisted projects (most recent first). */
  list(): Promise<VideoProject[]>;
  /** A single project by id, or `null` when not found. */
  get(id: string): Promise<VideoProject | null>;
  /** Upsert a project (insert when new, replace when the id already exists). */
  save(project: VideoProject): Promise<VideoProject>;
  /** Delete a project by id. Returns the remaining project list. */
  remove(id: string): Promise<VideoProject[]>;
  /** Patch a single scene of a project. Returns the updated project, or `null`. */
  updateScene(projectId: string, sceneId: string, patch: Partial<Omit<Scene, 'id'>>): Promise<VideoProject | null>;
  /** Subscribe to post-write list changes. Returns an unsubscribe fn. */
  onChange(listener: (projects: VideoProject[]) => void): () => void;
};

/**
 * Create a Make Video store rooted at the given directory (defaults to
 * `userData`). The returned store caches the list in memory after the first
 * {@link IMakeVideoStore.load} and persists atomically after each mutation,
 * emitting the new list to `onChange` listeners.
 */
export const createMakeVideoStore = (options?: MakeVideoStoreOptions): IMakeVideoStore => {
  const now = options?.now ?? Date.now;
  const newId = options?.newId ?? randomUUID;
  const fsImpl = resolveFs(options);
  const filePath = path.join(resolveDir(options), MAKE_VIDEO_DATA_FILE);
  const listeners = new Set<(projects: VideoProject[]) => void>();

  let cache: VideoProject[] = [];
  let loaded = false;

  const persist = async (next: VideoProject[]): Promise<VideoProject[]> => {
    cache = next;
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.tmp`;
    await fsImpl.mkdir(dir, { recursive: true });
    await fsImpl.writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, filePath);
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        console.error('[MakeVideoStore] onChange listener threw:', error);
      }
    }
    return next;
  };

  const load = async (): Promise<VideoProject[]> => {
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      cache = normaliseProjects(JSON.parse(raw) as unknown, now(), newId);
    } catch (error) {
      if (!isFileNotFound(error)) {
        console.warn('[MakeVideoStore] Failed to read make-video-projects.json; using empty list:', error);
      }
      cache = [];
    }
    loaded = true;
    return cache;
  };

  /** Ensure the cache is populated before a read/mutation. */
  const ensureLoaded = async (): Promise<void> => {
    if (!loaded) await load();
  };

  return {
    load,

    async list() {
      await ensureLoaded();
      return [...cache].toSorted((a, b) => b.updatedAt - a.updatedAt);
    },

    async get(id) {
      await ensureLoaded();
      return cache.find((p) => p.id === id) ?? null;
    },

    async save(project) {
      await ensureLoaded();
      const ts = now();
      const existing = cache.find((p) => p.id === project.id);
      const merged: VideoProject = {
        ...project,
        createdAt: existing?.createdAt ?? project.createdAt ?? ts,
        updatedAt: ts,
      };
      const next = existing ? cache.map((p) => (p.id === project.id ? merged : p)) : [...cache, merged];
      await persist(next);
      return merged;
    },

    async remove(id) {
      await ensureLoaded();
      return persist(cache.filter((p) => p.id !== id));
    },

    async updateScene(projectId, sceneId, patch) {
      await ensureLoaded();
      const target = cache.find((p) => p.id === projectId);
      if (!target) return null;
      const ts = now();
      const updated: VideoProject = {
        ...target,
        updatedAt: ts,
        scenes: target.scenes.map((s) => (s.id === sceneId ? { ...s, ...patch, id: s.id } : s)),
      };
      await persist(cache.map((p) => (p.id === projectId ? updated : p)));
      return updated;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
