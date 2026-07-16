/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistence + CRUD layer for the Automation feature.
 *
 * The list of {@link Workflow} documents is mirrored to
 * `automation-workflows.json` in the Electron `userData` directory — the same
 * app-data-dir convention used by `manager-data.json` and `company.json`. Writes
 * go to a sibling `.tmp` file then rename into place so a process kill mid-write
 * never leaves a half-written (corrupt) file. Reads are defensive: a
 * missing/corrupt/partial file yields an empty list, and individual malformed
 * records are dropped rather than throwing.
 *
 * The store exposes an {@link IAutomationStore.onChange} subscription so the
 * bridge can push live updates to the renderer after each mutation.
 *
 * Testability: the directory and fs implementation are injectable via
 * {@link AutomationStoreOptions}; tests target a temp dir or an in-memory fs
 * without touching real disk. `app.getPath` is resolved lazily so callers that
 * inject a `dir` never depend on a live Electron `app`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workflow, WorkflowNode, WorkflowNodeKind } from './automationTypes';

/** Name of the persisted document inside the app data directory. */
const AUTOMATION_DATA_FILE = 'automation-workflows.json';

/** Minimal subset of `fs/promises` used here (injectable for tests). */
export type AutomationFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Default fs adapter backed by Node's `fs/promises`. */
const defaultFs: AutomationFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

/** Where + how the document is persisted. Both default to userData + `fs/promises`. */
export type AutomationStoreOptions = {
  /** Directory the data file lives in. Defaults to the Electron `userData` dir. */
  dir?: string;
  /** File-system implementation. Injectable for tests; defaults to `fs/promises`. */
  fs?: AutomationFs;
  /** Clock for `createdAt`/`updatedAt`. Defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  /** Id generator. Defaults to `crypto.randomUUID`. Injectable for tests. */
  newId?: () => string;
};

const resolveDir = (options?: AutomationStoreOptions): string => options?.dir ?? app.getPath('userData');
const resolveFs = (options?: AutomationStoreOptions): AutomationFs => options?.fs ?? defaultFs;
const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

// ---------------------------------------------------------------------------
// Defensive normalisation (drop malformed records rather than throwing)
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const NODE_KINDS: readonly WorkflowNodeKind[] = [
  'trigger.manual',
  'trigger.schedule',
  'trigger.webhook',
  'action.http',
  'action.ai',
  'action.transform',
  'action.delay',
  'action.log',
  'action.set',
  'action.code',
  'action.filesystem',
  'control.if',
  'control.switch',
  'control.loop',
  'control.parallel',
  'control.tryCatch',
  'control.filter',
  'control.merge',
  'control.stop',
  'action.app.makeVideo',
  'action.app.editor',
  'action.notify',
  'action.manager',
  'action.browser',
  'action.conversation',
  'action.cron',
  'action.subworkflow',
  'action.cloud.upload',
  'action.email.send',
  'action.social.facebook',
  'action.social.tiktok',
  'action.company',
];

const isNodeKind = (v: unknown): v is WorkflowNodeKind =>
  typeof v === 'string' && (NODE_KINDS as readonly string[]).includes(v);

/** Coerce an unknown record into a valid {@link WorkflowNode}, or `null` to drop it. */
const normaliseNode = (v: unknown): WorkflowNode | null => {
  if (!isObject(v) || !isNodeKind(v.kind)) return null;
  const node: WorkflowNode = {
    id: typeof v.id === 'string' && v.id.length > 0 ? v.id : randomUUID(),
    kind: v.kind,
    name: typeof v.name === 'string' ? v.name : v.kind,
    config: isObject(v.config) ? v.config : {},
  };
  // Preserve control-flow child pipelines (each branch is a node list).
  if (isObject(v.branches)) {
    const branches: Record<string, WorkflowNode[]> = {};
    for (const [key, value] of Object.entries(v.branches)) {
      if (Array.isArray(value)) {
        branches[key] = value.map(normaliseNode).filter((n): n is WorkflowNode => n !== null);
      }
    }
    node.branches = branches;
  }
  // Preserve a per-node error/retry policy.
  if (isObject(v.onError)) {
    node.onError = {
      retries: typeof v.onError.retries === 'number' ? v.onError.retries : undefined,
      retryDelayMs: typeof v.onError.retryDelayMs === 'number' ? v.onError.retryDelayMs : undefined,
      continueOnError: typeof v.onError.continueOnError === 'boolean' ? v.onError.continueOnError : undefined,
    };
  }
  return node;
};

/** Coerce an unknown record into a valid {@link Workflow}, or `null` to drop it. */
const normaliseWorkflow = (v: unknown, now: number): Workflow | null => {
  if (!isObject(v) || typeof v.name !== 'string') return null;
  const nodes = Array.isArray(v.nodes) ? v.nodes.map(normaliseNode).filter((n): n is WorkflowNode => n !== null) : [];
  return {
    id: typeof v.id === 'string' && v.id.length > 0 ? v.id : randomUUID(),
    name: v.name,
    description: typeof v.description === 'string' ? v.description : undefined,
    nodes,
    enabled: v.enabled !== false,
    createdAt: num(v.createdAt) ?? now,
    updatedAt: num(v.updatedAt) ?? now,
  };
};

/** Coerce an arbitrary parsed JSON value into a valid workflow list. */
const normaliseList = (parsed: unknown, now: number): Workflow[] => {
  if (!Array.isArray(parsed)) return [];
  return parsed.map((w) => normaliseWorkflow(w, now)).filter((w): w is Workflow => w !== null);
};

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

/** Public contract of the Automation store. */
export type IAutomationStore = {
  /** Load (and cache) the workflow list from disk. Safe — never throws on bad data. */
  load(): Promise<Workflow[]>;
  /** All workflows (ordered as persisted). */
  list(): Promise<Workflow[]>;
  /** Find one workflow by id, or `undefined` if absent. */
  get(id: string): Promise<Workflow | undefined>;
  /**
   * Upsert a workflow. An incoming workflow with a known id replaces it
   * (preserving `createdAt`, bumping `updatedAt`); a new/blank id is inserted
   * with generated id + timestamps. Returns the persisted workflow.
   */
  save(workflow: Partial<Workflow> & { name: string }): Promise<Workflow>;
  /** Remove a workflow by id. Returns the new list. */
  remove(id: string): Promise<Workflow[]>;
  /** Subscribe to post-write list changes. Returns an unsubscribe fn. */
  onChange(listener: (workflows: Workflow[]) => void): () => void;
};

/**
 * Create an Automation store rooted at the given directory (defaults to
 * `userData`).
 *
 * The returned store caches the list in memory after the first {@link load} and
 * persists atomically after each mutation, emitting the new list to `onChange`
 * listeners.
 */
export const createAutomationStore = (options?: AutomationStoreOptions): IAutomationStore => {
  const now = options?.now ?? Date.now;
  const newId = options?.newId ?? randomUUID;
  const fsImpl = resolveFs(options);
  const filePath = path.join(resolveDir(options), AUTOMATION_DATA_FILE);
  const listeners = new Set<(workflows: Workflow[]) => void>();

  let cache: Workflow[] = [];
  let loaded = false;

  const persist = async (next: Workflow[]): Promise<Workflow[]> => {
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
        console.error('[AutomationStore] onChange listener threw:', error);
      }
    }
    return next;
  };

  const load = async (): Promise<Workflow[]> => {
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      cache = normaliseList(JSON.parse(raw) as unknown, now());
    } catch (error) {
      if (!isFileNotFound(error)) {
        console.warn('[AutomationStore] Failed to read automation-workflows.json; using empty list:', error);
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
      return cache;
    },

    async get(id) {
      await ensureLoaded();
      return cache.find((w) => w.id === id);
    },

    async save(workflow) {
      await ensureLoaded();
      const ts = now();
      const existing = workflow.id ? cache.find((w) => w.id === workflow.id) : undefined;
      const next: Workflow = {
        id: existing?.id ?? (workflow.id && workflow.id.length > 0 ? workflow.id : newId()),
        name: workflow.name,
        description: workflow.description,
        nodes: workflow.nodes ?? existing?.nodes ?? [],
        enabled: workflow.enabled ?? existing?.enabled ?? true,
        createdAt: existing?.createdAt ?? workflow.createdAt ?? ts,
        updatedAt: ts,
      };
      const list = existing ? cache.map((w) => (w.id === next.id ? next : w)) : [...cache, next];
      await persist(list);
      return next;
    },

    async remove(id) {
      await ensureLoaded();
      return persist(cache.filter((w) => w.id !== id));
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
