/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistence + CRUD for terminal schedules (Phase 2).
 *
 * Mirrors the `automationStore` convention exactly: the list of
 * {@link TerminalSchedule} records is mirrored to `terminal-schedules.json` in
 * the Electron `userData` dir, written atomically (tmp + rename) so a kill
 * mid-write never corrupts the file, and read defensively (missing/corrupt file
 * → empty list, malformed records dropped).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TerminalSchedule, TerminalScheduleKind } from './terminalTypes';

const SCHEDULE_DATA_FILE = 'terminal-schedules.json';

/** Minimal subset of `fs/promises` used here (injectable for tests). */
export type ScheduleFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

const defaultFs: ScheduleFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

/** Where + how the schedule list is persisted. */
export type ScheduleStoreOptions = {
  dir?: string;
  fs?: ScheduleFs;
  now?: () => number;
  newId?: () => string;
};

const resolveDir = (options?: ScheduleStoreOptions): string => options?.dir ?? app.getPath('userData');
const resolveFs = (options?: ScheduleStoreOptions): ScheduleFs => options?.fs ?? defaultFs;
const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const KINDS: readonly TerminalScheduleKind[] = ['cron', 'once'];
const isKind = (v: unknown): v is TerminalScheduleKind =>
  typeof v === 'string' && (KINDS as readonly string[]).includes(v);

/** Coerce an unknown record into a valid {@link TerminalSchedule}, or null to drop it. */
const normalise = (v: unknown, now: number): TerminalSchedule | null => {
  if (!isObject(v) || typeof v.name !== 'string' || typeof v.script !== 'string') return null;
  const kind: TerminalScheduleKind = isKind(v.kind) ? v.kind : 'cron';
  return {
    id: typeof v.id === 'string' && v.id.length > 0 ? v.id : randomUUID(),
    name: v.name,
    shell: str(v.shell),
    cwd: str(v.cwd),
    script: v.script,
    kind,
    cron: str(v.cron),
    at: num(v.at) ?? undefined,
    tz: str(v.tz),
    enabled: v.enabled !== false,
    lastRunAt: num(v.lastRunAt),
    lastStatus: v.lastStatus === 'ok' || v.lastStatus === 'error' ? v.lastStatus : null,
    lastError: str(v.lastError) ?? null,
    createdAt: num(v.createdAt) ?? now,
    updatedAt: num(v.updatedAt) ?? now,
  };
};

const normaliseList = (parsed: unknown, now: number): TerminalSchedule[] => {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((s) => normalise(s, now)).filter((s): s is TerminalSchedule => s !== null);
};

/** Public contract of the schedule store. */
export type ITerminalScheduleStore = {
  load(): Promise<TerminalSchedule[]>;
  list(): Promise<TerminalSchedule[]>;
  get(id: string): Promise<TerminalSchedule | undefined>;
  save(schedule: Partial<TerminalSchedule> & { name: string; script: string }): Promise<TerminalSchedule>;
  /** Patch mutable runtime fields after a fire (lastRunAt/status/error). */
  patch(id: string, updates: Partial<TerminalSchedule>): Promise<TerminalSchedule | undefined>;
  remove(id: string): Promise<TerminalSchedule[]>;
  onChange(listener: (schedules: TerminalSchedule[]) => void): () => void;
};

/** Create a schedule store rooted at the given dir (defaults to userData). */
export const createTerminalScheduleStore = (options?: ScheduleStoreOptions): ITerminalScheduleStore => {
  const now = options?.now ?? Date.now;
  const newId = options?.newId ?? randomUUID;
  const fsImpl = resolveFs(options);
  const filePath = path.join(resolveDir(options), SCHEDULE_DATA_FILE);
  const listeners = new Set<(schedules: TerminalSchedule[]) => void>();

  let cache: TerminalSchedule[] = [];
  let loaded = false;

  const persist = async (next: TerminalSchedule[]): Promise<TerminalSchedule[]> => {
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
        console.error('[TerminalScheduleStore] onChange listener threw:', error);
      }
    }
    return next;
  };

  const load = async (): Promise<TerminalSchedule[]> => {
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      cache = normaliseList(JSON.parse(raw) as unknown, now());
    } catch (error) {
      if (!isFileNotFound(error)) {
        console.warn('[TerminalScheduleStore] Failed to read terminal-schedules.json; using empty list:', error);
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
      return cache.find((s) => s.id === id);
    },

    async save(schedule) {
      await ensureLoaded();
      const ts = now();
      const existing = schedule.id ? cache.find((s) => s.id === schedule.id) : undefined;
      const next: TerminalSchedule = {
        id: existing?.id ?? (schedule.id && schedule.id.length > 0 ? schedule.id : newId()),
        name: schedule.name,
        shell: schedule.shell ?? existing?.shell,
        cwd: schedule.cwd ?? existing?.cwd,
        script: schedule.script,
        kind: schedule.kind ?? existing?.kind ?? 'cron',
        cron: schedule.cron ?? existing?.cron,
        at: schedule.at ?? existing?.at,
        tz: schedule.tz ?? existing?.tz,
        enabled: schedule.enabled ?? existing?.enabled ?? true,
        lastRunAt: existing?.lastRunAt ?? null,
        lastStatus: existing?.lastStatus ?? null,
        lastError: existing?.lastError ?? null,
        createdAt: existing?.createdAt ?? ts,
        updatedAt: ts,
      };
      const list = existing ? cache.map((s) => (s.id === next.id ? next : s)) : [...cache, next];
      await persist(list);
      return next;
    },

    async patch(id, updates) {
      await ensureLoaded();
      const existing = cache.find((s) => s.id === id);
      if (!existing) return undefined;
      const next: TerminalSchedule = { ...existing, ...updates, id: existing.id, updatedAt: now() };
      await persist(cache.map((s) => (s.id === id ? next : s)));
      return next;
    },

    async remove(id) {
      await ensureLoaded();
      return persist(cache.filter((s) => s.id !== id));
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
