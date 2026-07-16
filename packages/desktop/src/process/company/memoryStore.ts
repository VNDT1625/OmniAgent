/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistent, file-based memory for high-level company agents (Requirement 3 —
 * agent company model, criterion 3.4).
 *
 * Each high-level agent (President, division leads, ...) gets its own directory
 * holding two plain-text files:
 *
 * - `soul.md`   — the agent's role / personality. Rarely changes.
 * - `memory.md` — accumulated experience. Grows over time; the `memoryCompactor`
 *   (Task 4.3) periodically summarises and trims it so it never bloats.
 *
 * The on-disk layout follows `design.md` (Yêu cầu 3 — trí nhớ dạng file):
 *
 * ```
 * <companiesRoot>/<companyId>/agents/<agentId>/
 *   ├── soul.md
 *   └── memory.md
 * ```
 *
 * A store instance is scoped to a single company (`companyId`); agents inside it
 * are addressed by `agentId` alone.
 *
 * ## Storage location (local vs cloud)
 *
 * Per criterion 3.4, memory may live **on the local machine** or **in the
 * cloud**, chosen by the user via {@link MemoryStoreOptions.storageLocation}:
 *
 * - `'local'` (default) — files live under the Electron `userData` directory,
 *   next to the other Main-process state (mirrors `resourceState.ts`). This
 *   reuses the existing app-data-dir convention rather than inventing a new one.
 * - `'cloud'`  — the companies root is resolved through an injected
 *   {@link CloudStorageProvider}. The design treats "cloud" as a user-configured
 *   sync folder, so the local-fs implementation here (writing into that folder)
 *   is sufficient for now; a real provider-API sync is a TODO (see
 *   {@link CloudStorageProvider.sync}).
 *
 * ## Testability
 *
 * Both the filesystem layer ({@link MemoryStoreFs}) and the directory resolution
 * (`localRootDir` / `cloudProvider`) are injectable so tests can target a temp
 * dir (or an in-memory fs) without touching real disk or a live Electron `app`.
 * The DI style mirrors `systemProbe.ts`; the atomic write-to-tmp-then-rename
 * strategy (and `mode: 0o600`) mirrors `resourceState.ts`.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Name of the directory (under the companies root) holding per-company data. */
const COMPANIES_DIR = 'companies';
/** Name of the sub-directory (under a company) holding per-agent directories. */
const AGENTS_DIR = 'agents';
/** File holding the agent's role / personality (rarely changes). */
const SOUL_FILE = 'soul.md';
/** File holding the agent's accumulated experience (grows over time). */
const MEMORY_FILE = 'memory.md';

/** Where an agent's memory is persisted. */
export type StorageLocation = 'local' | 'cloud';

/**
 * The full memory snapshot of a single agent — the contents of its `soul.md`
 * and `memory.md`. Returned by {@link IMemoryStore.readAll}.
 */
export type AgentMemory = {
  /** The agent this memory belongs to. */
  agentId: string;
  /** Contents of `soul.md` (role / personality). Empty string if not written yet. */
  soul: string;
  /** Contents of `memory.md` (accumulated experience). Empty string if not written yet. */
  memory: string;
};

/**
 * Minimal subset of `fs/promises` used by this module. Declared explicitly so
 * tests can supply an in-memory implementation without pulling in all of `fs`.
 * Same shape as `ResourceStateFs` in `resourceState.ts` for consistency.
 */
export type MemoryStoreFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Default file-system adapter backed by Node's `fs/promises`. */
export const defaultMemoryStoreFs: MemoryStoreFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

/**
 * Injection point for cloud-backed storage (criterion 3.4 — "lưu trên đám mây").
 *
 * The design models "cloud" as a user-configured sync folder, so resolving a
 * root directory is enough for the local-fs implementation: files written into
 * that folder are uploaded by the user's OS-level sync client. A real
 * provider-API sync (uploading explicitly) is left as a TODO via {@link sync}.
 */
export type CloudStorageProvider = {
  /**
   * Resolve the root directory under which the `companies/` tree is stored for
   * cloud storage (e.g. a Dropbox / Google Drive synced folder).
   */
  resolveRoot(): Promise<string>;
  /**
   * Optional hook invoked after each successful write to trigger an explicit
   * sync/upload of the given file.
   *
   * TODO(cloud-sync): wire this to a real cloud backend when one exists. The
   * default (omitted) relies on the resolved folder being OS-synced.
   */
  sync?(filePath: string): Promise<void>;
};

/**
 * Options for {@link createMemoryStore}. Only `companyId` is required; every
 * other field defaults to a local, real-`fs`, `userData`-backed configuration.
 */
export type MemoryStoreOptions = {
  /** Company this store is scoped to. All agents live under this company. */
  companyId: string;
  /** Where memory is persisted. Defaults to `'local'`. */
  storageLocation?: StorageLocation;
  /**
   * Root directory that holds the per-company folders for `'local'` storage.
   * Defaults to `<userData>/companies`. Inject a temp dir in tests.
   */
  localRootDir?: string;
  /**
   * Cloud storage provider, used (and required) when
   * `storageLocation === 'cloud'`.
   */
  cloudProvider?: CloudStorageProvider;
  /** File-system implementation. Injectable for tests; defaults to `fs/promises`. */
  fs?: MemoryStoreFs;
};

/**
 * File-based memory store for a single company's high-level agents.
 *
 * All methods address an agent by its `agentId` (the company is fixed by the
 * options passed to {@link createMemoryStore}). Reads of a not-yet-written file
 * resolve to an empty string rather than throwing.
 */
export type IMemoryStore = {
  /** Absolute path to the directory holding the given agent's memory files. */
  getAgentDir(agentId: string): Promise<string>;
  /** Create the agent's directory and seed empty `soul.md` / `memory.md` if missing. */
  ensureAgent(agentId: string): Promise<void>;
  /** Read `soul.md`. Resolves to `''` if it does not exist yet. */
  readSoul(agentId: string): Promise<string>;
  /** Overwrite `soul.md` with `content` (atomic). */
  writeSoul(agentId: string, content: string): Promise<void>;
  /** Read `memory.md`. Resolves to `''` if it does not exist yet. */
  readMemory(agentId: string): Promise<string>;
  /** Append a newline-delimited `entry` to `memory.md` (atomic read-modify-write). */
  appendMemory(agentId: string, entry: string): Promise<void>;
  /** Overwrite `memory.md` with `content` (atomic). Used by the compactor. */
  writeMemory(agentId: string, content: string): Promise<void>;
  /** Read both files at once into an {@link AgentMemory} snapshot. */
  readAll(agentId: string): Promise<AgentMemory>;
};

/** Characters / sequences that would let an id escape its company directory. */
const UNSAFE_ID_PATTERN = /[/\\]|\.\./;

/**
 * Guard against path traversal: an `agentId` (or `companyId`) must not contain
 * path separators or `..`, otherwise it could write outside the company tree.
 * Throws a descriptive error on violation.
 */
const assertSafeId = (kind: 'companyId' | 'agentId', value: string): void => {
  if (value.length === 0 || UNSAFE_ID_PATTERN.test(value)) {
    throw new Error(
      `[Company] Invalid ${kind} ${JSON.stringify(value)}: must be non-empty and contain no path separators or "..".`
    );
  }
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/**
 * Create a {@link IMemoryStore} for one company.
 *
 * Resolution of the on-disk root is lazy: the Electron `userData` directory is
 * only read when `storageLocation` is `'local'` and no `localRootDir` override
 * is supplied, so callers (and tests) that inject a directory never depend on a
 * live Electron `app`.
 *
 * @param options Store configuration. Only `companyId` is required.
 * @returns A memory store scoped to `options.companyId`.
 */
export const createMemoryStore = (options: MemoryStoreOptions): IMemoryStore => {
  const { companyId } = options;
  assertSafeId('companyId', companyId);

  const fsImpl = options.fs ?? defaultMemoryStoreFs;
  const storageLocation: StorageLocation = options.storageLocation ?? 'local';

  /** Resolve the directory that contains the per-company folders. */
  const resolveCompaniesRoot = async (): Promise<string> => {
    if (storageLocation === 'cloud') {
      if (!options.cloudProvider) {
        throw new Error("[Company] storageLocation 'cloud' requires a cloudProvider to be supplied.");
      }
      return path.join(await options.cloudProvider.resolveRoot(), COMPANIES_DIR);
    }
    const localRoot = options.localRootDir ?? path.join(app.getPath('userData'), COMPANIES_DIR);
    return localRoot;
  };

  /** Resolve the absolute directory holding `soul.md` / `memory.md` for an agent. */
  const resolveAgentDir = async (agentId: string): Promise<string> => {
    assertSafeId('agentId', agentId);
    const companiesRoot = await resolveCompaniesRoot();
    return path.join(companiesRoot, companyId, AGENTS_DIR, agentId);
  };

  /** Read a file, returning `''` when it does not exist yet. */
  const readFileOrEmpty = async (filePath: string): Promise<string> => {
    try {
      return await fsImpl.readFile(filePath, 'utf-8');
    } catch (error) {
      if (isFileNotFound(error)) return '';
      throw error;
    }
  };

  /**
   * Atomically write `content` to `filePath`: write a sibling `.tmp` file then
   * rename it into place so a process kill mid-write cannot leave a corrupt
   * file (mirrors `resourceState.ts`). Triggers an optional cloud sync after.
   */
  const writeFileAtomic = async (filePath: string, content: string): Promise<void> => {
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.tmp`;
    await fsImpl.mkdir(dir, { recursive: true });
    await fsImpl.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, filePath);
    if (storageLocation === 'cloud' && options.cloudProvider?.sync) {
      await options.cloudProvider.sync(filePath);
    }
  };

  const getAgentDir: IMemoryStore['getAgentDir'] = (agentId) => resolveAgentDir(agentId);

  const ensureAgent: IMemoryStore['ensureAgent'] = async (agentId) => {
    const agentDir = await resolveAgentDir(agentId);
    await fsImpl.mkdir(agentDir, { recursive: true });
    // Seed empty files only when absent so the directory always "contains" both.
    const soulPath = path.join(agentDir, SOUL_FILE);
    const memoryPath = path.join(agentDir, MEMORY_FILE);
    const [soul, memory] = await Promise.all([readFileOrEmpty(soulPath), readFileOrEmpty(memoryPath)]);
    const writes: Promise<void>[] = [];
    if (soul === '') writes.push(writeFileAtomic(soulPath, ''));
    if (memory === '') writes.push(writeFileAtomic(memoryPath, ''));
    await Promise.all(writes);
  };

  const readSoul: IMemoryStore['readSoul'] = async (agentId) => {
    const agentDir = await resolveAgentDir(agentId);
    return readFileOrEmpty(path.join(agentDir, SOUL_FILE));
  };

  const writeSoul: IMemoryStore['writeSoul'] = async (agentId, content) => {
    const agentDir = await resolveAgentDir(agentId);
    await writeFileAtomic(path.join(agentDir, SOUL_FILE), content);
  };

  const readMemory: IMemoryStore['readMemory'] = async (agentId) => {
    const agentDir = await resolveAgentDir(agentId);
    return readFileOrEmpty(path.join(agentDir, MEMORY_FILE));
  };

  const writeMemory: IMemoryStore['writeMemory'] = async (agentId, content) => {
    const agentDir = await resolveAgentDir(agentId);
    await writeFileAtomic(path.join(agentDir, MEMORY_FILE), content);
  };

  const appendMemory: IMemoryStore['appendMemory'] = async (agentId, entry) => {
    const agentDir = await resolveAgentDir(agentId);
    const memoryPath = path.join(agentDir, MEMORY_FILE);
    const existing = await readFileOrEmpty(memoryPath);
    // Keep each entry on its own block: separate from prior content with a
    // newline when needed, and ensure the new entry ends with a newline.
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const suffix = entry.endsWith('\n') ? '' : '\n';
    await writeFileAtomic(memoryPath, `${existing}${separator}${entry}${suffix}`);
  };

  const readAll: IMemoryStore['readAll'] = async (agentId) => {
    const agentDir = await resolveAgentDir(agentId);
    const [soul, memory] = await Promise.all([
      readFileOrEmpty(path.join(agentDir, SOUL_FILE)),
      readFileOrEmpty(path.join(agentDir, MEMORY_FILE)),
    ]);
    return { agentId, soul, memory };
  };

  return { getAgentDir, ensureAgent, readSoul, writeSoul, readMemory, appendMemory, writeMemory, readAll };
};
