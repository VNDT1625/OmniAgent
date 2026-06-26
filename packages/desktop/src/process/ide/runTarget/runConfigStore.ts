/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `runConfigStore` — DURABLE per-repo "how I ran it last time" memory for Quick
 * Test, so a run that once succeeded can be repeated with ZERO AI and zero
 * detection on every later press of Run.
 *
 * The flow the user asked for has two planes:
 *   1. First run (AI plane): the wiki/Understand build already produced the run
 *      data; {@link planRunTargets} turns it into candidates mechanically. When
 *      a run SUCCEEDS, {@link saveRunConfig} persists the exact recipe here.
 *   2. Later runs (no-AI plane): {@link loadRunConfig} returns the saved recipe
 *      and Quick Test runs straight from it — the AI is never touched again
 *      unless the saved run breaks (or the wiki was never built, in which case
 *      the user types the command manually and it is saved the same way).
 *
 * One config is kept PER platform per repo (a project can run as web AND
 * android), keyed by a stable hash of the repo root. All filesystem access is
 * INJECTED ({@link RunConfigStoreDeps}) so the policy is unit-testable with an
 * in-memory fs; the bridge supplies Node `fs` + Electron `userData`.
 *
 * Process boundary: pure TS module (IO injected). No Node/DOM at module scope.
 */

import type { RunPlatform } from './runTargetPlanner';

/** Schema version of the persisted run-config payload. */
export const RUN_CONFIG_VERSION = 1;

/** One saved, replayable run recipe for a single platform of a repo. */
export type SavedRunConfig = {
  /** The platform this recipe runs (web/android/desktop). */
  platform: RunPlatform;
  /** Shell command that starts the app (e.g. `npm run dev`). Empty = none. */
  command: string;
  /** Working directory RELATIVE to the repo root ('' = root). */
  cwd: string;
  /** Dev URL to open + attach the tracer to (web only). */
  url?: string;
  /** Native target hint: android device serial / windows exe path. */
  target?: string;
  /** Whether the user entered this by hand (vs derived from the wiki runbook). */
  manual: boolean;
  /** Unix-ms when this recipe last ran successfully (or was saved manually). */
  savedAt: number;
};

/** The full persisted set of run configs for one repo. */
export type RepoRunConfigs = {
  /** Schema version. */
  version: number;
  /** Absolute repo root the configs belong to. */
  rootPath: string;
  /** One config per platform (latest wins). */
  configs: SavedRunConfig[];
};

/** Injected filesystem + path collaborators (Node `fs` / `path` in production). */
export type RunConfigStoreDeps = {
  /** Absolute path of the per-machine run-config directory. */
  storeDir: string;
  /** Read a UTF-8 file; reject with an ENOENT-like error when missing. */
  readFile: (filePath: string) => Promise<string>;
  /** Write a UTF-8 file (parent dir guaranteed by {@link RunConfigStoreDeps.mkdirp}). */
  writeFile: (filePath: string, data: string) => Promise<void>;
  /** Create a directory (recursive). */
  mkdirp: (dir: string) => Promise<void>;
  /** Atomically move a file (rename over an existing target). */
  rename: (from: string, to: string) => Promise<void>;
  /** Join path segments. */
  join: (...segments: string[]) => string;
  /** Stable short hash of a string (filesystem-safe). */
  hash: (value: string) => string;
  /** Whether a thrown error is "file not found". */
  isNotFound: (error: unknown) => boolean;
  /** Monotonic clock for tmp filenames + savedAt (defaults to Date.now). */
  now?: () => number;
};

/** The store filename for a repo root. */
const storeFile = (deps: RunConfigStoreDeps, rootPath: string): string =>
  deps.join(deps.storeDir, `${deps.hash(rootPath)}.run.json`);

/** Atomic write: tmp then rename, so a reader never sees a half-written file. */
const atomicWrite = async (deps: RunConfigStoreDeps, target: string, data: string): Promise<void> => {
  const stamp = (deps.now ?? Date.now)();
  const tmp = `${target}.${stamp}.tmp`;
  await deps.writeFile(tmp, data);
  await deps.rename(tmp, target);
};

/** Load all persisted run configs for a repo root (empty set when absent). */
export const loadRepoRunConfigs = async (deps: RunConfigStoreDeps, rootPath: string): Promise<RepoRunConfigs> => {
  const empty: RepoRunConfigs = { version: RUN_CONFIG_VERSION, rootPath, configs: [] };
  try {
    const text = await deps.readFile(storeFile(deps, rootPath));
    const parsed = JSON.parse(text) as RepoRunConfigs;
    if (parsed.version !== RUN_CONFIG_VERSION || !Array.isArray(parsed.configs)) return empty;
    // Drop malformed records defensively.
    const configs = parsed.configs.filter(
      (c): c is SavedRunConfig =>
        c != null &&
        (c.platform === 'web' || c.platform === 'android' || c.platform === 'desktop') &&
        typeof c.command === 'string' &&
        typeof c.cwd === 'string'
    );
    return { version: RUN_CONFIG_VERSION, rootPath, configs };
  } catch (error) {
    if (deps.isNotFound(error)) return empty;
    throw error;
  }
};

/** Load the saved run config for one platform of a repo, or null when none. */
export const loadRunConfig = async (
  deps: RunConfigStoreDeps,
  rootPath: string,
  platform: RunPlatform
): Promise<SavedRunConfig | null> => {
  const all = await loadRepoRunConfigs(deps, rootPath);
  return all.configs.find((c) => c.platform === platform) ?? null;
};

/**
 * Persist a run config for a repo platform (replacing any prior one for that
 * platform). Returns the full updated set. Best-effort `savedAt` stamp.
 */
export const saveRunConfig = async (
  deps: RunConfigStoreDeps,
  rootPath: string,
  config: Omit<SavedRunConfig, 'savedAt'>
): Promise<RepoRunConfigs> => {
  const now = (deps.now ?? Date.now)();
  const all = await loadRepoRunConfigs(deps, rootPath);
  const next: SavedRunConfig = { ...config, savedAt: now };
  const configs = [...all.configs.filter((c) => c.platform !== config.platform), next];
  const payload: RepoRunConfigs = { version: RUN_CONFIG_VERSION, rootPath, configs };
  await deps.mkdirp(deps.storeDir);
  await atomicWrite(deps, storeFile(deps, rootPath), JSON.stringify(payload, null, 2));
  return payload;
};

/** Forget the saved run config for one platform (e.g. the user resets it). */
export const clearRunConfig = async (
  deps: RunConfigStoreDeps,
  rootPath: string,
  platform: RunPlatform
): Promise<RepoRunConfigs> => {
  const all = await loadRepoRunConfigs(deps, rootPath);
  const configs = all.configs.filter((c) => c.platform !== platform);
  const payload: RepoRunConfigs = { version: RUN_CONFIG_VERSION, rootPath, configs };
  await deps.mkdirp(deps.storeDir);
  await atomicWrite(deps, storeFile(deps, rootPath), JSON.stringify(payload, null, 2));
  return payload;
};
