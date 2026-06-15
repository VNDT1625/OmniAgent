/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistence + CRUD layer for the Personal Manager feature.
 *
 * The full {@link ManagerData} document (tasks, notes, events, settings) is
 * mirrored to `manager-data.json` in the Electron `userData` directory — the
 * same app-data-dir convention used by `resource-state.json` and
 * `company.json`. Writes go to a sibling `.tmp` file then rename into place so a
 * process kill mid-write never leaves a half-written (corrupt) file
 * (Property 2). Reads are defensive: a missing/corrupt/partial file yields a
 * fresh empty document and individual malformed records are dropped rather than
 * throwing (Property 3).
 *
 * This single store is the source of truth shared by both planes: the UI via
 * `managerBridge` and agents via the built-in `managerServer` MCP process (which
 * points at the same file path). It exposes an {@link IManagerStore.onChange}
 * subscription so the bridge can push live updates to the renderer.
 *
 * Testability: the directory and fs implementation are injectable via
 * {@link ManagerStoreOptions}; tests target a temp dir or an in-memory fs
 * without touching real disk. `app.getPath` is resolved lazily so callers that
 * inject a `dir` never depend on a live Electron `app`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  emptyManagerData,
  defaultManagerSettings,
  defaultManagerAppearance,
  MANAGER_DATA_VERSION,
  type CalendarEvent,
  type ManagerAppearance,
  type ManagerData,
  type ManagerSettings,
  type Note,
  type NoteCategory,
  type NoteSource,
  type Priority,
  type Reminder,
  type Subtask,
  type Task,
  type TaskKind,
  type TaskStatus,
} from './managerTypes';

/** Name of the persisted document inside the app data directory. */
const MANAGER_DATA_FILE = 'manager-data.json';

/** Minimal subset of `fs/promises` used here (injectable for tests). */
export type ManagerFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Default fs adapter backed by Node's `fs/promises`. */
const defaultFs: ManagerFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

/** Where + how the document is persisted. Both default to userData + `fs/promises`. */
export type ManagerStoreOptions = {
  /** Directory the data file lives in. Defaults to the Electron `userData` dir. */
  dir?: string;
  /** File-system implementation. Injectable for tests; defaults to `fs/promises`. */
  fs?: ManagerFs;
  /** Clock for `createdAt`/`updatedAt`. Defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  /** Id generator. Defaults to `crypto.randomUUID`. Injectable for tests. */
  newId?: () => string;
};

const resolveDir = (options?: ManagerStoreOptions): string => options?.dir ?? app.getPath('userData');
const resolveFs = (options?: ManagerStoreOptions): ManagerFs => options?.fs ?? defaultFs;
const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

// ---------------------------------------------------------------------------
// Defensive normalisation (Property 3)
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const TASK_KINDS: readonly TaskKind[] = ['oneoff', 'recurring', 'habit', 'milestone'];
const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'urgent'];
const STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'done'];

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;

const normaliseSubtask = (v: unknown): Subtask | null => {
  if (!isObject(v) || typeof v.title !== 'string') return null;
  return { id: str(v.id) || randomUUID(), title: v.title, done: v.done === true };
};

const normaliseReminder = (v: unknown): Reminder | null => {
  if (!isObject(v)) return null;
  const fireAt = num(v.fireAt);
  if (fireAt === null) return null;
  return { id: str(v.id) || randomUUID(), fireAt, firedAt: num(v.firedAt), snoozedTo: num(v.snoozedTo) };
};

/** Coerce an unknown record into a valid {@link Task}, or `null` to drop it. */
const normaliseTask = (v: unknown, now: number): Task | null => {
  if (!isObject(v) || typeof v.title !== 'string') return null;
  return {
    id: str(v.id) || randomUUID(),
    title: v.title,
    description: typeof v.description === 'string' ? v.description : undefined,
    kind: oneOf(v.kind, TASK_KINDS, 'oneoff'),
    priority: oneOf(v.priority, PRIORITIES, 'medium'),
    status: oneOf(v.status, STATUSES, 'todo'),
    dueAt: num(v.dueAt),
    estimateMinutes: num(v.estimateMinutes),
    tags: strArr(v.tags),
    subtasks: Array.isArray(v.subtasks) ? v.subtasks.map(normaliseSubtask).filter((x): x is Subtask => x !== null) : [],
    recurrence: isObject(v.recurrence) ? (v.recurrence as Task['recurrence']) : null,
    reminders: Array.isArray(v.reminders)
      ? v.reminders.map(normaliseReminder).filter((x): x is Reminder => x !== null)
      : [],
    createdAt: num(v.createdAt) ?? now,
    updatedAt: num(v.updatedAt) ?? now,
    completedAt: num(v.completedAt),
  };
};

const normaliseNote = (v: unknown, now: number): Note | null => {
  if (!isObject(v) || typeof v.body !== 'string') return null;
  const category: Note['category'] = v.category === 'learn' || v.category === 'data' ? v.category : 'daily';
  const sources = Array.isArray(v.sources)
    ? v.sources
        .filter((s): s is { title?: unknown; url: string } => isObject(s) && typeof s.url === 'string')
        .map((s) => ({ title: typeof s.title === 'string' ? s.title : s.url, url: s.url }))
    : undefined;
  return {
    id: str(v.id) || randomUUID(),
    category,
    title: typeof v.title === 'string' ? v.title : undefined,
    body: v.body,
    tags: strArr(v.tags),
    linkedTaskId: typeof v.linkedTaskId === 'string' ? v.linkedTaskId : null,
    linkedEventId: typeof v.linkedEventId === 'string' ? v.linkedEventId : null,
    dayAt: num(v.dayAt),
    sources,
    cover: typeof v.cover === 'string' ? v.cover : null,
    icon: typeof v.icon === 'string' ? v.icon : null,
    filePath: typeof v.filePath === 'string' ? v.filePath : null,
    url: typeof v.url === 'string' ? v.url : null,
    createdAt: num(v.createdAt) ?? now,
    updatedAt: num(v.updatedAt) ?? now,
  };
};

const normaliseEvent = (v: unknown, now: number): CalendarEvent | null => {
  if (!isObject(v) || typeof v.title !== 'string') return null;
  const startAt = num(v.startAt);
  const endAt = num(v.endAt);
  if (startAt === null || endAt === null) return null;
  return {
    id: str(v.id) || randomUUID(),
    title: v.title,
    startAt,
    endAt,
    lockKind: v.lockKind === 'fixed' ? 'fixed' : 'flexible',
    location: typeof v.location === 'string' ? v.location : null,
    linkedTaskId: typeof v.linkedTaskId === 'string' ? v.linkedTaskId : null,
    note: typeof v.note === 'string' ? v.note : null,
    recurrence: isObject(v.recurrence) ? (v.recurrence as CalendarEvent['recurrence']) : null,
    source:
      v.source === 'manual' || v.source === 'prompt' || v.source === 'image' || v.source === 'optimizer'
        ? v.source
        : 'manual',
    createdAt: num(v.createdAt) ?? now,
    updatedAt: num(v.updatedAt) ?? now,
  };
};

const normaliseSettings = (v: unknown): ManagerSettings => {
  const base = defaultManagerSettings();
  if (!isObject(v)) return base;
  const travelMode =
    v.travelMode === 'walking' ||
    v.travelMode === 'bicycling' ||
    v.travelMode === 'transit' ||
    v.travelMode === 'driving'
      ? v.travelMode
      : 'driving';
  return {
    weatherEnabled: v.weatherEnabled === true,
    defaultLocation: typeof v.defaultLocation === 'string' ? v.defaultLocation : null,
    travelTimeEnabled: v.travelTimeEnabled === true,
    travelMode,
    googleMapsApiKey: typeof v.googleMapsApiKey === 'string' ? v.googleMapsApiKey : null,
    homeLocation: typeof v.homeLocation === 'string' ? v.homeLocation : null,
    appearance: normaliseAppearance(v.appearance),
  };
};

const ACCENTS = ['blue', 'violet', 'green', 'orange', 'red', 'pink', 'teal'] as const;
const FONTS = ['default', 'serif', 'mono', 'rounded'] as const;

/** Coerce an arbitrary value into a valid {@link ManagerAppearance}. */
const normaliseAppearance = (v: unknown): ManagerAppearance => {
  const base = defaultManagerAppearance();
  if (!isObject(v)) return base;
  const accent = (ACCENTS as readonly string[]).includes(v.accent as string)
    ? (v.accent as ManagerAppearance['accent'])
    : base.accent;
  const font = (FONTS as readonly string[]).includes(v.font as string)
    ? (v.font as ManagerAppearance['font'])
    : base.font;
  const density = v.density === 'compact' ? 'compact' : 'comfortable';
  const fontSizeRaw = num(v.fontSize);
  const fontSize = fontSizeRaw != null ? Math.min(18, Math.max(13, Math.round(fontSizeRaw))) : base.fontSize;
  return { accent, font, density, fontSize, tintedBackground: v.tintedBackground === true };
};

/** Coerce an arbitrary parsed JSON value into a valid {@link ManagerData}. */
const normaliseData = (parsed: unknown, now: number): ManagerData => {
  if (!isObject(parsed)) return emptyManagerData();
  return {
    version: MANAGER_DATA_VERSION,
    tasks: Array.isArray(parsed.tasks)
      ? parsed.tasks.map((t) => normaliseTask(t, now)).filter((x): x is Task => x !== null)
      : [],
    notes: Array.isArray(parsed.notes)
      ? parsed.notes.map((n) => normaliseNote(n, now)).filter((x): x is Note => x !== null)
      : [],
    events: Array.isArray(parsed.events)
      ? parsed.events.map((e) => normaliseEvent(e, now)).filter((x): x is CalendarEvent => x !== null)
      : [],
    settings: normaliseSettings(parsed.settings),
  };
};

// ---------------------------------------------------------------------------
// Recurrence — spawn the next occurrence of a recurring task
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shift a timestamp forward by one recurrence interval (pure). */
const advance = (ts: number, rule: NonNullable<Task['recurrence']>): number => {
  const interval = Math.max(1, rule.interval ?? 1);
  const d = new Date(ts);
  if (rule.freq === 'daily') return ts + interval * DAY_MS;
  if (rule.freq === 'weekly') return ts + interval * 7 * DAY_MS;
  // monthly: advance calendar month, clamping the day.
  d.setMonth(d.getMonth() + interval);
  return d.getTime();
};

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/** Fields accepted when creating a task; the rest are defaulted/generated. */
export type NewTaskInput = {
  title: string;
  description?: string;
  kind?: TaskKind;
  priority?: Priority;
  status?: TaskStatus;
  dueAt?: number | null;
  estimateMinutes?: number | null;
  tags?: string[];
  subtasks?: Array<{ title: string; done?: boolean }>;
  recurrence?: Task['recurrence'];
  reminders?: Array<{ fireAt: number }>;
};

export type NewNoteInput = {
  title?: string;
  body: string;
  category?: NoteCategory;
  tags?: string[];
  linkedTaskId?: string | null;
  linkedEventId?: string | null;
  dayAt?: number | null;
  sources?: NoteSource[];
  cover?: string | null;
  icon?: string | null;
  filePath?: string | null;
  url?: string | null;
};
export type NewEventInput = Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'>;

/** Public contract of the Manager store. */
export type IManagerStore = {
  /** Load (and cache) the document from disk. Safe — never throws on bad data. */
  load(): Promise<ManagerData>;
  /** The currently-cached document (loads lazily on first use is the caller's job). */
  getData(): ManagerData;
  // Tasks
  addTask(input: NewTaskInput): Promise<Task>;
  updateTask(id: string, patch: Partial<Omit<Task, 'id' | 'createdAt'>>): Promise<ManagerData>;
  removeTask(id: string): Promise<ManagerData>;
  toggleSubtask(taskId: string, subtaskId: string): Promise<ManagerData>;
  /** Set a task's status; completing a `recurring` task spawns the next occurrence. */
  setTaskStatus(id: string, status: TaskStatus): Promise<ManagerData>;
  // Notes
  addNote(input: NewNoteInput): Promise<Note>;
  updateNote(id: string, patch: Partial<Omit<Note, 'id' | 'createdAt'>>): Promise<ManagerData>;
  removeNote(id: string): Promise<ManagerData>;
  // Events
  addEvent(input: NewEventInput): Promise<CalendarEvent>;
  updateEvent(id: string, patch: Partial<Omit<CalendarEvent, 'id' | 'createdAt'>>): Promise<ManagerData>;
  removeEvent(id: string): Promise<ManagerData>;
  /** Replace the whole event set (used to apply an AI optimisation + undo). */
  setEvents(events: CalendarEvent[]): Promise<ManagerData>;
  // Settings + reminders
  updateSettings(patch: Partial<ManagerSettings>): Promise<ManagerData>;
  updateReminder(taskId: string, reminderId: string, patch: Partial<Reminder>): Promise<ManagerData>;
  /** Subscribe to post-write document changes. Returns an unsubscribe fn. */
  onChange(listener: (data: ManagerData) => void): () => void;
};

/**
 * Create a Manager store rooted at the given directory (defaults to `userData`).
 *
 * The returned store caches the document in memory after the first {@link load}
 * and persists atomically after each mutation, emitting the new document to
 * `onChange` listeners.
 */
export const createManagerStore = (options?: ManagerStoreOptions): IManagerStore => {
  const now = options?.now ?? Date.now;
  const newId = options?.newId ?? randomUUID;
  const fsImpl = resolveFs(options);
  const filePath = path.join(resolveDir(options), MANAGER_DATA_FILE);
  const listeners = new Set<(data: ManagerData) => void>();

  let cache: ManagerData = emptyManagerData();
  let loaded = false;

  const persist = async (next: ManagerData): Promise<ManagerData> => {
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
        console.error('[ManagerStore] onChange listener threw:', error);
      }
    }
    return next;
  };

  const load = async (): Promise<ManagerData> => {
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      cache = normaliseData(JSON.parse(raw) as unknown, now());
    } catch (error) {
      if (!isFileNotFound(error)) {
        console.warn('[ManagerStore] Failed to read manager-data.json; using empty document:', error);
      }
      cache = emptyManagerData();
    }
    loaded = true;
    return cache;
  };

  /** Ensure the cache is populated before a mutation. */
  const ensureLoaded = async (): Promise<void> => {
    if (!loaded) await load();
  };

  return {
    load,
    getData: () => cache,

    async addTask(input) {
      await ensureLoaded();
      const ts = now();
      const task: Task = {
        id: newId(),
        title: input.title,
        description: input.description,
        kind: input.kind ?? 'oneoff',
        priority: input.priority ?? 'medium',
        status: input.status ?? 'todo',
        dueAt: input.dueAt ?? null,
        estimateMinutes: input.estimateMinutes ?? null,
        tags: input.tags ?? [],
        subtasks: (input.subtasks ?? []).map((s) => ({ id: newId(), title: s.title, done: s.done === true })),
        recurrence: input.recurrence ?? null,
        reminders: (input.reminders ?? []).map(
          (r): Reminder => ({ id: newId(), fireAt: r.fireAt, firedAt: null, snoozedTo: null })
        ),
        createdAt: ts,
        updatedAt: ts,
        completedAt: null,
      };
      await persist({ ...cache, tasks: [...cache.tasks, task] });
      return task;
    },

    async updateTask(id, patch) {
      await ensureLoaded();
      const tasks = cache.tasks.map((t) => (t.id === id ? { ...t, ...patch, id: t.id, updatedAt: now() } : t));
      return persist({ ...cache, tasks });
    },

    async removeTask(id) {
      await ensureLoaded();
      return persist({ ...cache, tasks: cache.tasks.filter((t) => t.id !== id) });
    },

    async toggleSubtask(taskId, subtaskId) {
      await ensureLoaded();
      const tasks = cache.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              updatedAt: now(),
              subtasks: t.subtasks.map((s) => (s.id === subtaskId ? { ...s, done: !s.done } : s)),
            }
          : t
      );
      return persist({ ...cache, tasks });
    },

    async setTaskStatus(id, status) {
      await ensureLoaded();
      const ts = now();
      const target = cache.tasks.find((t) => t.id === id);
      const tasks = cache.tasks.map((t) =>
        t.id === id ? { ...t, status, updatedAt: ts, completedAt: status === 'done' ? ts : null } : t
      );
      const next: ManagerData = { ...cache, tasks };
      // Completing a recurring task spawns the next occurrence (criterion 1.3b).
      if (target && status === 'done' && target.kind === 'recurring' && target.recurrence) {
        const baseDue = target.dueAt ?? ts;
        const nextDue = advance(baseDue, target.recurrence);
        next.tasks = [
          ...tasks,
          {
            ...target,
            id: newId(),
            status: 'todo',
            completedAt: null,
            dueAt: nextDue,
            reminders: target.reminders.map(
              (r): Reminder => ({
                id: newId(),
                fireAt: r.fireAt + (nextDue - baseDue),
                firedAt: null,
                snoozedTo: null,
              })
            ),
            createdAt: ts,
            updatedAt: ts,
          },
        ];
      }
      return persist(next);
    },

    async addNote(input) {
      await ensureLoaded();
      const ts = now();
      const category = input.category ?? 'daily';
      const note: Note = {
        id: newId(),
        category,
        title: input.title,
        body: input.body,
        tags: input.tags ?? [],
        linkedTaskId: input.linkedTaskId ?? null,
        linkedEventId: input.linkedEventId ?? null,
        dayAt: category === 'daily' ? (input.dayAt ?? ts) : (input.dayAt ?? null),
        sources: input.sources,
        cover: input.cover ?? null,
        icon: input.icon ?? null,
        filePath: input.filePath ?? null,
        url: input.url ?? null,
        createdAt: ts,
        updatedAt: ts,
      };
      await persist({ ...cache, notes: [...cache.notes, note] });
      return note;
    },

    async updateNote(id, patch) {
      await ensureLoaded();
      const notes = cache.notes.map((n) => (n.id === id ? { ...n, ...patch, id: n.id, updatedAt: now() } : n));
      return persist({ ...cache, notes });
    },

    async removeNote(id) {
      await ensureLoaded();
      return persist({ ...cache, notes: cache.notes.filter((n) => n.id !== id) });
    },

    async addEvent(input) {
      await ensureLoaded();
      const ts = now();
      const event: CalendarEvent = { ...input, id: newId(), createdAt: ts, updatedAt: ts };
      await persist({ ...cache, events: [...cache.events, event] });
      return event;
    },

    async updateEvent(id, patch) {
      await ensureLoaded();
      const events = cache.events.map((e) => (e.id === id ? { ...e, ...patch, id: e.id, updatedAt: now() } : e));
      return persist({ ...cache, events });
    },

    async removeEvent(id) {
      await ensureLoaded();
      return persist({ ...cache, events: cache.events.filter((e) => e.id !== id) });
    },

    async setEvents(events) {
      await ensureLoaded();
      return persist({ ...cache, events });
    },

    async updateSettings(patch) {
      await ensureLoaded();
      return persist({ ...cache, settings: { ...cache.settings, ...patch } });
    },

    async updateReminder(taskId, reminderId, patch) {
      await ensureLoaded();
      const tasks = cache.tasks.map((t) =>
        t.id === taskId
          ? {
              ...t,
              updatedAt: now(),
              reminders: t.reminders.map((r) => (r.id === reminderId ? { ...r, ...patch, id: r.id } : r)),
            }
          : t
      );
      return persist({ ...cache, tasks });
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
