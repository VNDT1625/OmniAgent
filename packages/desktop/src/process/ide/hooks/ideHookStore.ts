/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistence + CRUD for IDE Agent Hooks, scoped PER WORKSPACE.
 *
 * Mirrors the `terminalScheduleStore` convention: hook records are mirrored to
 * a JSON file written atomically (tmp + rename) and read defensively (missing/
 * corrupt → empty list, malformed records dropped). Because hooks are per
 * workspace, the file lives under the Electron `userData` dir keyed by a hash of
 * the workspace root path, so each opened folder keeps its own hook set.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { IdeHook, IdeHookActionKind, IdeHookEvent } from './ideHookTypes';
import { IDE_HOOK_ACTIONS, IDE_HOOK_EVENTS } from './ideHookTypes';

/** Minimal subset of `fs/promises` used here (injectable for tests). */
export type HookFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

const defaultFs: HookFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

/** Where + how a workspace's hook list is persisted. */
export type HookStoreOptions = {
  /** Workspace root this store is scoped to (used to derive the file name). */
  rootPath: string;
  /** Base directory for hook files. Defaults to `<userData>/ide-hooks`. */
  dir?: string;
  fs?: HookFs;
  now?: () => number;
  newId?: () => string;
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const isEvent = (v: unknown): v is IdeHookEvent =>
  typeof v === 'string' && (IDE_HOOK_EVENTS as readonly string[]).includes(v);
const isAction = (v: unknown): v is IdeHookActionKind =>
  typeof v === 'string' && (IDE_HOOK_ACTIONS as readonly string[]).includes(v);

/** A short, stable, filesystem-safe key for a workspace root. */
export const workspaceKey = (rootPath: string): string =>
  createHash('sha1').update(rootPath.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16);

/** Coerce an unknown record into a valid {@link IdeHook}, or null to drop it. */
const normalise = (v: unknown, now: number): IdeHook | null => {
  if (!isObject(v) || typeof v.name !== 'string') return null;
  const event: IdeHookEvent = isEvent(v.event) ? v.event : 'manual';
  const action: IdeHookActionKind = isAction(v.action) ? v.action : 'askAgent';
  const filePatterns = Array.isArray(v.filePatterns)
    ? v.filePatterns.filter((p): p is string => typeof p === 'string')
    : [];
  return {
    id: typeof v.id === 'string' && v.id.length > 0 ? v.id : randomUUID(),
    name: v.name,
    description: str(v.description),
    enabled: v.enabled !== false,
    event,
    filePatterns,
    action,
    prompt: str(v.prompt),
    command: str(v.command),
    createdAt: num(v.createdAt) ?? now,
    updatedAt: num(v.updatedAt) ?? now,
    lastRunAt: num(v.lastRunAt),
  };
};

const normaliseList = (parsed: unknown, now: number): IdeHook[] => {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((h) => normalise(h, now)).filter((h): h is IdeHook => h !== null);
};

/** Public contract of the per-workspace hook store. */
export type IIdeHookStore = {
  load(): Promise<IdeHook[]>;
  list(): Promise<IdeHook[]>;
  get(id: string): Promise<IdeHook | undefined>;
  save(hook: Partial<IdeHook> & { name: string }): Promise<IdeHook>;
  patch(id: string, updates: Partial<IdeHook>): Promise<IdeHook | undefined>;
  remove(id: string): Promise<IdeHook[]>;
  onChange(listener: (hooks: IdeHook[]) => void): () => void;
};

/** Create a hook store for one workspace root. */
export const createIdeHookStore = (options: HookStoreOptions): IIdeHookStore => {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  const fsImpl = options.fs ?? defaultFs;
  const baseDir = options.dir ?? path.join(app.getPath('userData'), 'ide-hooks');
  const filePath = path.join(baseDir, `${workspaceKey(options.rootPath)}.json`);
  const listeners = new Set<(hooks: IdeHook[]) => void>();

  let cache: IdeHook[] = [];
  let loaded = false;

  const persist = async (next: IdeHook[]): Promise<IdeHook[]> => {
    cache = next;
    const tmpPath = `${filePath}.tmp`;
    await fsImpl.mkdir(baseDir, { recursive: true });
    await fsImpl.writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, filePath);
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (error) {
        console.error('[IdeHookStore] onChange listener threw:', error);
      }
    }
    return next;
  };

  const load = async (): Promise<IdeHook[]> => {
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      cache = normaliseList(JSON.parse(raw) as unknown, now());
    } catch (error) {
      if (!isFileNotFound(error)) {
        console.warn('[IdeHookStore] Failed to read hook file; using empty list:', error);
      }
      cache = [];
    }
    loaded = true;
    return cache;
  };

  const ensureLoaded = async (): Promise<void> => {
    if (!loaded) await load();
  };

  return {
    load,

    async list() {
      await ensureLoaded();
      return cache;
    },

    async get(id) {
      await ensureLoaded();
      return cache.find((h) => h.id === id);
    },

    async save(hook) {
      await ensureLoaded();
      const ts = now();
      const existing = hook.id ? cache.find((h) => h.id === hook.id) : undefined;
      const next: IdeHook = {
        id: existing?.id ?? (hook.id && hook.id.length > 0 ? hook.id : newId()),
        name: hook.name,
        description: hook.description ?? existing?.description,
        enabled: hook.enabled ?? existing?.enabled ?? true,
        event: hook.event ?? existing?.event ?? 'manual',
        filePatterns: hook.filePatterns ?? existing?.filePatterns ?? [],
        action: hook.action ?? existing?.action ?? 'askAgent',
        prompt: hook.prompt ?? existing?.prompt,
        command: hook.command ?? existing?.command,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
        lastRunAt: existing?.lastRunAt ?? null,
      };
      const list = existing ? cache.map((h) => (h.id === next.id ? next : h)) : [...cache, next];
      await persist(list);
      return next;
    },

    async patch(id, updates) {
      await ensureLoaded();
      const existing = cache.find((h) => h.id === id);
      if (!existing) return undefined;
      const next: IdeHook = { ...existing, ...updates, id: existing.id, updatedAt: now() };
      await persist(cache.map((h) => (h.id === id ? next : h)));
      return next;
    },

    async remove(id) {
      await ensureLoaded();
      return persist(cache.filter((h) => h.id !== id));
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
