/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-based persistence for {@link ExperienceEntry} records.
 *
 * On-disk layout (mirrors `company/memoryStore.ts`):
 *
 * ```
 * <root>/experience/<projectId>/entries/<id>.json
 * ```
 *
 * Each entry is one atomic JSON file (write-to-tmp-then-rename). The filesystem
 * layer and root directory are injectable so tests can target a temp dir
 * without a live Electron `app`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExperienceEntry, ExperienceEntryPatch, ExperienceFilter } from './experienceTypes';

/** Name of the directory (under the app data root) holding all experience data. */
const EXPERIENCE_DIR = 'experience';
/** Name of the sub-directory (under a project) holding per-entry JSON files. */
const ENTRIES_DIR = 'entries';

/** Minimal filesystem surface used by the store; injectable for tests. */
export type ExperienceStoreFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  readdir(dirPath: string): Promise<string[]>;
  rm(filePath: string, options: { force: true }): Promise<void>;
};

/** Default adapter backed by Node's `fs/promises`. */
export const defaultExperienceStoreFs: ExperienceStoreFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
  readdir: (dirPath) => fs.promises.readdir(dirPath),
  rm: (filePath, options) => fs.promises.rm(filePath, options),
};

/** Options for {@link createExperienceStore}. */
export type ExperienceStoreOptions = {
  /** Root directory holding the `experience/` tree. Defaults to `<userData>`. */
  rootDir?: string;
  /** Filesystem implementation. Injectable for tests. */
  fs?: ExperienceStoreFs;
};

/** Persistent metadata store for experience entries. */
export type IExperienceStore = {
  create(entry: ExperienceEntry): Promise<ExperienceEntry>;
  update(id: string, patch: ExperienceEntryPatch): Promise<ExperienceEntry>;
  get(id: string): Promise<ExperienceEntry | null>;
  remove(id: string): Promise<void>;
  /** List all entries (optionally filtered) across every project. */
  searchMetadata(filter?: ExperienceFilter): Promise<ExperienceEntry[]>;
};

/** Characters that would let an id escape its directory. */
const UNSAFE_ID_PATTERN = /[/\\]|\.\./;

const assertSafeId = (kind: 'projectId' | 'entryId', value: string): void => {
  if (value.length === 0 || UNSAFE_ID_PATTERN.test(value)) {
    throw new Error(`[Experience] Invalid ${kind} ${JSON.stringify(value)}: must be non-empty with no path separators or "..".`);
  }
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const matchesFilter = (entry: ExperienceEntry, filter: ExperienceFilter): boolean => {
  if (filter.projectId !== undefined && entry.projectId !== filter.projectId) {
    return false;
  }
  if (filter.kind !== undefined && entry.kind !== filter.kind) {
    return false;
  }
  if (filter.status !== undefined && entry.status !== filter.status) {
    return false;
  }
  if (filter.tags && filter.tags.length > 0) {
    const tagSet = new Set(entry.tags.map((tag) => tag.toLowerCase()));
    if (!filter.tags.every((tag) => tagSet.has(tag.toLowerCase()))) {
      return false;
    }
  }
  return true;
};

/**
 * Create a file-based {@link IExperienceStore}. The Electron `userData` path is
 * read lazily only when no `rootDir` override is supplied, so tests injecting a
 * directory never depend on a live Electron `app`.
 */
export const createExperienceStore = (options: ExperienceStoreOptions = {}): IExperienceStore => {
  const fsImpl = options.fs ?? defaultExperienceStoreFs;

  const resolveRoot = (): string => options.rootDir ?? path.join(app.getPath('userData'), EXPERIENCE_DIR);

  const resolveEntriesDir = (projectId: string): string => {
    assertSafeId('projectId', projectId);
    return path.join(resolveRoot(), projectId, ENTRIES_DIR);
  };

  const resolveEntryPath = (projectId: string, entryId: string): string => {
    assertSafeId('entryId', entryId);
    return path.join(resolveEntriesDir(projectId), `${entryId}.json`);
  };

  const writeFileAtomic = async (filePath: string, content: string): Promise<void> => {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    await fsImpl.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, filePath);
  };

  const readEntryAt = async (filePath: string): Promise<ExperienceEntry | null> => {
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      return JSON.parse(raw) as ExperienceEntry;
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }
  };

  /** Scan every project directory to find an entry by id (id alone is unique). */
  const findEntry = async (entryId: string): Promise<{ entry: ExperienceEntry; filePath: string } | null> => {
    assertSafeId('entryId', entryId);
    const root = resolveRoot();
    let projects: string[];
    try {
      projects = await fsImpl.readdir(root);
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      throw error;
    }
    for (const projectId of projects) {
      const filePath = path.join(root, projectId, ENTRIES_DIR, `${entryId}.json`);
      const entry = await readEntryAt(filePath);
      if (entry) {
        return { entry, filePath };
      }
    }
    return null;
  };

  const create: IExperienceStore['create'] = async (entry) => {
    const filePath = resolveEntryPath(entry.projectId, entry.id);
    await writeFileAtomic(filePath, JSON.stringify(entry, null, 2));
    return entry;
  };

  const get: IExperienceStore['get'] = async (id) => {
    const found = await findEntry(id);
    return found?.entry ?? null;
  };

  const update: IExperienceStore['update'] = async (id, patch) => {
    const found = await findEntry(id);
    if (!found) {
      throw new Error(`[Experience] Cannot update unknown entry ${JSON.stringify(id)}.`);
    }
    const next: ExperienceEntry = { ...found.entry, ...patch, id: found.entry.id, createdAt: found.entry.createdAt };
    await writeFileAtomic(found.filePath, JSON.stringify(next, null, 2));
    return next;
  };

  const remove: IExperienceStore['remove'] = async (id) => {
    const found = await findEntry(id);
    if (!found) {
      return;
    }
    await fsImpl.rm(found.filePath, { force: true });
  };

  const searchMetadata: IExperienceStore['searchMetadata'] = async (filter = {}) => {
    const root = resolveRoot();
    let projects: string[];
    try {
      projects = await fsImpl.readdir(root);
    } catch (error) {
      if (isFileNotFound(error)) {
        return [];
      }
      throw error;
    }
    const targetProjects = filter.projectId ? projects.filter((projectId) => projectId === filter.projectId) : projects;
    const results: ExperienceEntry[] = [];
    for (const projectId of targetProjects) {
      const entriesDir = path.join(root, projectId, ENTRIES_DIR);
      let files: string[];
      try {
        files = await fsImpl.readdir(entriesDir);
      } catch (error) {
        if (isFileNotFound(error)) {
          continue;
        }
        throw error;
      }
      // Read all entry files in this directory in parallel — independent reads.
      const jsonFiles = files.filter((file) => file.endsWith('.json') && !file.endsWith('.tmp'));
      const entries = await Promise.all(jsonFiles.map((file) => readEntryAt(path.join(entriesDir, file))));
      for (const entry of entries) {
        if (entry && matchesFilter(entry, filter)) {
          results.push(entry);
        }
      }
    }
    return results.toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  return { create, update, get, remove, searchMetadata };
};
