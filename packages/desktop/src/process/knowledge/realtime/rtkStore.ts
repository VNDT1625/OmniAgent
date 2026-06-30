/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-backed store for Realtime Knowledge facts.
 *
 * Persists all facts as a single JSON document at
 * `<userData>/knowledge/realtime/facts.json`, using the same robustness
 * conventions as `company/memoryStore.ts`: an injectable filesystem adapter
 * (testable against a temp/in-memory dir) and an atomic write-to-tmp-then-rename
 * so a crash mid-write cannot corrupt the store.
 *
 * The store is intentionally simple (load-all / save-all): the realtime
 * knowledge set is small (curated volatile facts), so an in-memory map flushed
 * atomically is sufficient and keeps reads/queries cheap. Heavy semantic search
 * lives in `rtkVectorIndex.ts`.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs. The
 * Electron `userData` directory is resolved lazily so injected dirs (tests) never
 * touch a live `app`.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FactStatus, KnowledgeFact, KnowledgeRelation } from './rtkTypes';

/** Sub-directory (under userData) holding the realtime-knowledge store. */
const RTK_DIR = path.join('knowledge', 'realtime');
/** Filename of the persisted facts document. */
const FACTS_FILE = 'facts.json';
/** Persisted document schema version (bump on breaking shape changes). */
export const RTK_STORE_VERSION = 1;

/** On-disk shape of the persisted store. */
type RtkDocument = {
  version: number;
  facts: KnowledgeFact[];
  relations: KnowledgeRelation[];
};

/**
 * Minimal subset of `fs/promises` used by the store. Declared explicitly so
 * tests can supply an in-memory implementation (mirrors `MemoryStoreFs`).
 */
export type RtkStoreFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Default adapter backed by Node's `fs/promises`. */
export const defaultRtkStoreFs: RtkStoreFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

/** Options for {@link createRtkStore}. */
export type RtkStoreOptions = {
  /** Root directory holding the store. Defaults to `<userData>/knowledge/realtime`. */
  rootDir?: string;
  /** Filesystem adapter. Injectable for tests; defaults to `fs/promises`. */
  fs?: RtkStoreFs;
};

/** Filter for {@link IRtkStore.list}. */
export type RtkListFilter = {
  /** Only facts with this status. */
  status?: FactStatus;
  /** Only facts whose `expiresAt` is strictly before this ISO timestamp. */
  expiredBefore?: string;
  /** Only facts of these volatility classes / matching topics prefix. */
  topicPrefix?: string;
};

/** Public contract of the realtime-knowledge store. */
export type IRtkStore = {
  /** Insert or replace a fact (matched by `id`). Returns the stored fact. */
  upsert(fact: KnowledgeFact): Promise<KnowledgeFact>;
  /** Shallow-merge a patch into an existing fact. Throws if the id is unknown. */
  patch(id: string, patch: Partial<KnowledgeFact>): Promise<KnowledgeFact>;
  /** Get a fact by id, or `null`. */
  get(id: string): Promise<KnowledgeFact | null>;
  /** Get the first fact with this exact `topic`, or `null`. */
  byTopic(topic: string): Promise<KnowledgeFact | null>;
  /** List facts, optionally filtered. */
  list(filter?: RtkListFilter): Promise<KnowledgeFact[]>;
  /** Remove a fact by id. Returns whether one was removed. */
  remove(id: string): Promise<boolean>;
  /** Replace the full relation set. */
  setRelations(relations: KnowledgeRelation[]): Promise<void>;
  /** Read all relations. */
  relations(): Promise<KnowledgeRelation[]>;
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const emptyDocument = (): RtkDocument => ({ version: RTK_STORE_VERSION, facts: [], relations: [] });

/**
 * Create an {@link IRtkStore}.
 *
 * @param options Root dir + fs adapter overrides. Both optional.
 */
export const createRtkStore = (options: RtkStoreOptions = {}): IRtkStore => {
  const fsImpl = options.fs ?? defaultRtkStoreFs;

  const resolveRoot = (): string => options.rootDir ?? path.join(app.getPath('userData'), RTK_DIR);

  const factsPath = (): string => path.join(resolveRoot(), FACTS_FILE);

  const load = async (): Promise<RtkDocument> => {
    try {
      const raw = await fsImpl.readFile(factsPath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<RtkDocument> | null;
      if (!parsed || !Array.isArray(parsed.facts)) {
        return emptyDocument();
      }
      return {
        version: typeof parsed.version === 'number' ? parsed.version : RTK_STORE_VERSION,
        facts: parsed.facts,
        relations: Array.isArray(parsed.relations) ? parsed.relations : [],
      };
    } catch (error) {
      if (isFileNotFound(error)) return emptyDocument();
      throw error;
    }
  };

  const save = async (doc: RtkDocument): Promise<void> => {
    const target = factsPath();
    const dir = path.dirname(target);
    const tmp = `${target}.tmp`;
    await fsImpl.mkdir(dir, { recursive: true });
    await fsImpl.writeFile(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmp, target);
  };

  const upsert: IRtkStore['upsert'] = async (fact) => {
    const doc = await load();
    const index = doc.facts.findIndex((f) => f.id === fact.id);
    if (index >= 0) {
      doc.facts[index] = fact;
    } else {
      doc.facts.push(fact);
    }
    await save(doc);
    return fact;
  };

  const patch: IRtkStore['patch'] = async (id, partial) => {
    const doc = await load();
    const index = doc.facts.findIndex((f) => f.id === id);
    if (index < 0) {
      throw new Error(`[RTK] Cannot patch unknown fact ${JSON.stringify(id)}.`);
    }
    const merged = { ...doc.facts[index], ...partial, id };
    doc.facts[index] = merged;
    await save(doc);
    return merged;
  };

  const get: IRtkStore['get'] = async (id) => {
    const doc = await load();
    return doc.facts.find((f) => f.id === id) ?? null;
  };

  const byTopic: IRtkStore['byTopic'] = async (topic) => {
    const doc = await load();
    return doc.facts.find((f) => f.topic === topic) ?? null;
  };

  const list: IRtkStore['list'] = async (filter) => {
    const doc = await load();
    return doc.facts.filter((fact) => {
      if (filter?.status && fact.status !== filter.status) return false;
      if (filter?.expiredBefore && !(fact.expiresAt < filter.expiredBefore)) return false;
      if (filter?.topicPrefix && !fact.topic.startsWith(filter.topicPrefix)) return false;
      return true;
    });
  };

  const remove: IRtkStore['remove'] = async (id) => {
    const doc = await load();
    const next = doc.facts.filter((f) => f.id !== id);
    if (next.length === doc.facts.length) return false;
    doc.facts = next;
    await save(doc);
    return true;
  };

  const setRelations: IRtkStore['setRelations'] = async (relations) => {
    const doc = await load();
    doc.relations = relations;
    await save(doc);
  };

  const relations: IRtkStore['relations'] = async () => {
    const doc = await load();
    return doc.relations;
  };

  return { upsert, patch, get, byTopic, list, remove, setRelations, relations };
};
