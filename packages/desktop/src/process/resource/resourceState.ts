/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistence layer for the ResourceCoordinator (Requirement 5 — anti-lag
 * resource management, criterion 5.8).
 *
 * The coordinator's full {@link ResourceState} — the active budget, the leases
 * currently held, the wait queue, and the history of automatic budget
 * adjustments (each with its `reason`, `from` and `to` snapshots) — is mirrored
 * to `resource-state.json` so the Dashboard can show the user *why* the budget
 * changed and so the coordinator can restore its last view after a restart.
 *
 * The file lives in the Electron `userData` directory, next to the other
 * Main-process config files (`gpu.config.json`, `webui.config.json`,
 * `analytics.json`). This reuses the existing app-data-dir convention rather
 * than inventing a new location. The atomic write-to-tmp-then-rename strategy
 * (and `mode: 0o600`) mirrors `saveUserWebUIConfig` in `utils/webuiConfig.ts`.
 *
 * Testability: the directory and the file-system implementation are injectable
 * via {@link ResourceStateStoreOptions} so tests can target a temp dir (or a
 * fully in-memory fs) without touching real disk. When no overrides are given,
 * the real `userData` dir and Node's `fs/promises` are used — `app.getPath` is
 * resolved lazily so callers that always inject a `dir` never depend on a live
 * Electron `app`.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BudgetAdjustment, ResourceState } from './leaseTypes';

/** Name of the persisted state file inside the app data directory. */
const RESOURCE_STATE_FILE = 'resource-state.json';

/**
 * Minimal subset of `fs/promises` used by this module. Declared explicitly so
 * tests can supply an in-memory implementation without pulling in all of `fs`.
 */
export type ResourceStateFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Default file-system adapter backed by Node's `fs/promises`. */
const defaultFs: ResourceStateFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

/**
 * Optional overrides for where and how the state is persisted. Both default to
 * the real app data directory and Node's `fs/promises` when omitted.
 */
export type ResourceStateStoreOptions = {
  /** Directory the state file lives in. Defaults to the Electron `userData` dir. */
  dir?: string;
  /** File-system implementation. Injectable for tests; defaults to `fs/promises`. */
  fs?: ResourceStateFs;
};

/** Options for {@link loadResourceState}. */
export type ResourceStateLoadOptions = ResourceStateStoreOptions & {
  /**
   * Value returned when the file does not exist yet or cannot be parsed. When
   * omitted, `undefined` is returned in those cases.
   */
  defaultState?: ResourceState;
};

/** Resolve the directory holding the state file, lazily reading `userData`. */
const resolveDir = (options?: ResourceStateStoreOptions): string => options?.dir ?? app.getPath('userData');

/** Resolve the file-system adapter to use. */
const resolveFs = (options?: ResourceStateStoreOptions): ResourceStateFs => options?.fs ?? defaultFs;

/**
 * Absolute path to `resource-state.json` for the given options. Exposed so the
 * coordinator/bridge can surface the location without duplicating the join.
 */
export const getResourceStateFilePath = (options?: ResourceStateStoreOptions): string =>
  path.join(resolveDir(options), RESOURCE_STATE_FILE);

/** Type guard: a parsed JSON value is shaped like a {@link ResourceState}. */
const isResourceStateShape = (value: unknown): value is ResourceState => {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ResourceState>;
  return (
    typeof candidate.budget === 'object' &&
    candidate.budget !== null &&
    Array.isArray(candidate.active) &&
    Array.isArray(candidate.queued) &&
    Array.isArray(candidate.lastAdjustments)
  );
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/**
 * Load the persisted {@link ResourceState} from disk.
 *
 * Returns `options.defaultState` (or `undefined` when none is provided) if the
 * file does not exist yet, if it cannot be read, or if it contains malformed /
 * unexpected JSON. Parse and read errors are handled gracefully — a corrupt
 * file never throws, so a fresh state can take over.
 */
export const loadResourceState = async (options?: ResourceStateLoadOptions): Promise<ResourceState | undefined> => {
  const fallback = options?.defaultState;
  const filePath = getResourceStateFilePath(options);
  try {
    const raw = await resolveFs(options).readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isResourceStateShape(parsed)) {
      console.warn('[Resource] resource-state.json has unexpected shape; using default state');
      return fallback;
    }
    return parsed;
  } catch (error) {
    if (!isFileNotFound(error)) {
      console.warn('[Resource] Failed to read resource-state.json; using default state:', error);
    }
    return fallback;
  }
};

/**
 * Persist the full {@link ResourceState} to disk.
 *
 * Writes to a sibling `.tmp` file then renames it into place so a process kill
 * mid-write cannot leave a half-written (corrupt) state file. The directory is
 * created if needed.
 */
export const saveResourceState = async (state: ResourceState, options?: ResourceStateStoreOptions): Promise<void> => {
  const dir = resolveDir(options);
  const fsImpl = resolveFs(options);
  const filePath = path.join(dir, RESOURCE_STATE_FILE);
  const tmpPath = `${filePath}.tmp`;

  await fsImpl.mkdir(dir, { recursive: true });
  const payload = JSON.stringify(state, null, 2) + '\n';
  await fsImpl.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  await fsImpl.rename(tmpPath, filePath);
};

/**
 * Append a {@link BudgetAdjustment} to `lastAdjustments` and persist the result
 * (criterion 5.8 — record *why* the budget changed).
 *
 * Returns the updated state. The input `state` is not mutated.
 */
export const appendBudgetAdjustment = async (
  state: ResourceState,
  adjustment: BudgetAdjustment,
  options?: ResourceStateStoreOptions
): Promise<ResourceState> => {
  const next: ResourceState = {
    ...state,
    budget: adjustment.to,
    lastAdjustments: [...state.lastAdjustments, adjustment],
  };
  await saveResourceState(next, options);
  return next;
};
