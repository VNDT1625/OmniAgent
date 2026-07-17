/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `runTargetBridge` — the IPC surface that powers Quick Test's one-press **Run**.
 *
 * It exposes three mechanical (no-model) operations to the renderer:
 *
 *   - `ide.qr-plan`   — read the repo's PERSISTED run data (the KnowledgeGraph
 *     {@link ProjectRunbook} produced earlier by the AI wiki/Understand build)
 *     plus every `package.json`, and return a {@link RunPlan}: which platforms
 *     the project supports (web/android/desktop, independent booleans) and one
 *     best-guess {@link RunCandidate} per platform. ALSO returns any saved
 *     {@link SavedRunConfig}s so the panel can run straight from them.
 *   - `ide.qr-save`   — persist the recipe that just ran (so later runs need no
 *     AI and no detection — exactly the "lần sau chạy không dùng AI" plane).
 *   - `ide.qr-clear`  — forget a saved recipe for a platform.
 *
 * The AI is involved ONLY when building the wiki/runbook (elsewhere) or, in the
 * renderer, when a run fails and the user asks the agent to fix it. This bridge
 * itself never calls a model.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { planRunTargets, type RunPlan, type RunPlatform } from './runTargetPlanner';
import {
  clearRunConfig,
  loadRepoRunConfigs,
  saveRunConfig,
  type RepoRunConfigs,
  type RunConfigStoreDeps,
  type SavedRunConfig,
} from './runConfigStore';
import { loadGraph } from '../quickTestBridgeHelpers';

/** IPC channel names for the Quick-Run surface (renderer-safe contract). */
export const RUN_TARGET_CHANNELS = {
  plan: 'ide.qr-plan',
  save: 'ide.qr-save',
  clear: 'ide.qr-clear',
  probe: 'ide.qr-probe',
} as const;

/** Always-resolving envelope (the platform bridge swallows thrown errors). */
export type RunTargetResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Request for {@link RUN_TARGET_CHANNELS.plan}. */
export type RunPlanRequest = {
  /** Absolute repo root the IDE has open. */
  rootPath: string;
};

/** Response for {@link RUN_TARGET_CHANNELS.plan}: the derived plan + saved recipes. */
export type RunPlanResponse = {
  /** The mechanical run plan derived from the repo's run data. */
  plan: RunPlan;
  /** Previously-saved, replayable run recipes (one per platform), if any. */
  saved: SavedRunConfig[];
  /** What persisted/fallback sources were available while deriving the plan. */
  source: RunPlanSource;
};

/** Metadata used by Quick Test to show whether setup came from wiki/Understand or fallback files. */
export type RunPlanSource = {
  /** True when a persisted KnowledgeGraph was loaded for this root. */
  graphLoaded: boolean;
  /** True when the graph carried structured runbook data. */
  graphHasRunbook: boolean;
  /** Number of run commands available from the persisted graph runbook. */
  runbookCommandCount: number;
  /** Number of manifest/lock files read directly from disk as fallback evidence. */
  manifestFileCount: number;
};

/** Request for {@link RUN_TARGET_CHANNELS.save}. */
export type RunSaveRequest = {
  /** Absolute repo root the config belongs to. */
  rootPath: string;
  /** The recipe to persist (without the `savedAt` stamp). */
  config: Omit<SavedRunConfig, 'savedAt'>;
};

/** Request for {@link RUN_TARGET_CHANNELS.clear}. */
export type RunClearRequest = {
  /** Absolute repo root. */
  rootPath: string;
  /** The platform whose saved recipe to forget. */
  platform: RunPlatform;
};

/** Request for {@link RUN_TARGET_CHANNELS.probe}: poll a dev URL once. */
export type RunProbeRequest = {
  /** The dev URL to probe (e.g. `http://localhost:5173`). */
  url: string;
};

/** Response for {@link RUN_TARGET_CHANNELS.probe}: whether the URL answered. */
export type RunProbeResponse = {
  /** True when the server answered (any HTTP status), false on timeout/refused. */
  reachable: boolean;
};

/** Typed Quick-Run channels. Exported for bootstrap registration wiring. */
export const runTargetChannels = {
  plan: bridge.buildProvider<RunTargetResult<RunPlanResponse>, RunPlanRequest>(RUN_TARGET_CHANNELS.plan),
  save: bridge.buildProvider<RunTargetResult<RepoRunConfigs>, RunSaveRequest>(RUN_TARGET_CHANNELS.save),
  clear: bridge.buildProvider<RunTargetResult<RepoRunConfigs>, RunClearRequest>(RUN_TARGET_CHANNELS.clear),
  probe: bridge.buildProvider<RunTargetResult<RunProbeResponse>, RunProbeRequest>(RUN_TARGET_CHANNELS.probe),
};

/** Package-manifest / lockfile names worth reading for the planner. */
const MANIFEST_FILES = [
  'package.json',
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'pyproject.toml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
] as const;

/** Subfolders commonly holding the real app(s) in a monorepo (one level deep). */
const WORKSPACE_DIRS = ['apps', 'packages', 'services', 'frontend', 'backend', 'web', 'client', 'server'] as const;

/** Directories that are never a source repo when detecting a duplicate parent shell. */
const DUPLICATE_PARENT_IGNORED_DIRS = new Set(['.omni', '.aionui', '.cache', '.git', '.mtui', 'node_modules', 'out']);

/** Marker dirs/files the planner checks for native shells (Tauri/Android). */
const MARKER_PATHS = [
  'src-tauri',
  'android',
  'ios',
  'src-tauri/tauri.conf.json',
  'backend/main.py',
  'mcp_server/server.py',
  '.venv/Scripts/python.exe',
  '.venv/bin/python',
] as const;

/** Read one file as UTF-8, or undefined when missing/unreadable. */
const readMaybe = async (filePath: string): Promise<string | undefined> => {
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
};

/** Basename that works on Windows and POSIX paths without depending on path flavor. */
const pathBasename = (input: string): string => {
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
};

/** Join repo-relative path segments with forward slashes, preserving '' as root. */
const joinRel = (...segments: string[]): string =>
  segments
    .map((segment) => segment.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

/** Whether a path exists (file or dir). */
const pathExists = async (target: string): Promise<boolean> => {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
};

type ManifestReadScope = {
  /** Absolute directory to inspect. */
  absDir: string;
  /** Repo-relative prefix from the originally-opened root to {@link absDir}. */
  relBase: string;
};

/**
 * If the opened folder is only a duplicate parent shell
 * (`AI_Education-main/AI_Education-main`), read manifests from the inner repo
 * but keep the inner folder as the candidate cwd relative to the opened root.
 */
const resolveManifestReadScopes = async (rootPath: string): Promise<ManifestReadScope[]> => {
  try {
    const entries = await fsp.readdir(rootPath, { withFileTypes: true });
    const candidateDirs = entries.filter(
      (entry) => entry.isDirectory() && !DUPLICATE_PARENT_IGNORED_DIRS.has(entry.name.toLowerCase())
    );
    const hasFiles = entries.some((entry) => entry.isFile());
    const onlyDir = candidateDirs.length === 1 ? candidateDirs[0] : undefined;
    if (!hasFiles && onlyDir && onlyDir.name.toLowerCase() === pathBasename(rootPath).toLowerCase()) {
      return [{ absDir: path.join(rootPath, onlyDir.name), relBase: onlyDir.name }];
    }
  } catch {
    /* Fall through to the opened root. */
  }
  return [{ absDir: rootPath, relBase: '' }];
};

/**
 * Read the declarative manifest files (root + one level of common monorepo
 * subfolders) into a relative-path → content map, plus the set of existing
 * marker paths. Bounded: only known manifest names, only one workspace level.
 */
const readRepoManifests = async (rootPath: string): Promise<{ files: Map<string, string>; existing: Set<string> }> => {
  const files = new Map<string, string>();
  const existing = new Set<string>();
  const scopes = await resolveManifestReadScopes(rootPath);

  /** Read the manifest files inside one relative dir. */
  const readDir = async (scope: ManifestReadScope, relDir: string): Promise<void> => {
    const manifests = await Promise.all(
      MANIFEST_FILES.map(
        async (name): Promise<{ rel: string; content: string | undefined }> => ({
          rel: joinRel(scope.relBase, relDir, name),
          content: await readMaybe(path.join(scope.absDir, relDir, name)),
        })
      )
    );
    for (const { rel, content } of manifests) {
      if (content !== undefined) files.set(rel, content);
    }
  };

  await Promise.all(
    scopes.map(async (scope) => {
      await readDir(scope, '');
      await Promise.all(
        WORKSPACE_DIRS.map(async (ws) => {
          const wsAbs = path.join(scope.absDir, ws);
          if (!(await pathExists(wsAbs))) return;
          // Read the workspace dir itself (e.g. `frontend/package.json`)…
          await readDir(scope, ws);
          // …and one level of children (e.g. `apps/web/package.json`).
          try {
            const entries = await fsp.readdir(wsAbs, { withFileTypes: true });
            await Promise.all(
              entries.filter((entry) => entry.isDirectory()).map((entry) => readDir(scope, `${ws}/${entry.name}`))
            );
          } catch {
            /* unreadable dir — skip */
          }
        })
      );

      const markers = await Promise.all(
        MARKER_PATHS.map(
          async (marker): Promise<string | null> =>
            (await pathExists(path.join(scope.absDir, marker))) ? joinRel(scope.relBase, marker) : null
        )
      );
      for (const marker of markers) {
        if (marker !== null) existing.add(marker);
      }
    })
  );

  return { files, existing };
};

/** Directory holding persisted per-repo run configs. */
const resolveStoreDir = (): string => path.join(app.getPath('userData'), 'ide-run-config');

/** Whether a thrown error is a "file not found" (ENOENT). */
const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** Build the Node-backed {@link RunConfigStoreDeps}. */
const nodeStoreDeps = (): RunConfigStoreDeps => ({
  storeDir: resolveStoreDir(),
  readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
  writeFile: (filePath, data) => fsp.writeFile(filePath, data, 'utf-8'),
  mkdirp: async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
  },
  rename: (from, to) => fsp.rename(from, to),
  join: (...segments) => path.join(...segments),
  hash: (value) => createHash('sha256').update(value).digest('hex').slice(0, 32),
  isNotFound: isFileNotFound,
});

/** Resolve the same mechanical Quick-Run plan used by the UI, for agent services. */
export const resolveRunPlanResponse = async (rootPathInput: string): Promise<RunPlanResponse> => {
  const rootPath = rootPathInput.trim();
  if (!rootPath) throw new Error('A folder path is required.');
  const [{ files, existing }, graph, repoConfigs] = await Promise.all([
    readRepoManifests(rootPath),
    loadGraph(rootPath).catch((): null => null),
    loadRepoRunConfigs(nodeStoreDeps(), rootPath).catch((): RepoRunConfigs => ({ version: 1, rootPath, configs: [] })),
  ]);
  return {
    plan: planRunTargets({ runbook: graph?.runbook, files, existing }),
    saved: repoConfigs.configs,
    source: {
      graphLoaded: graph !== null,
      graphHasRunbook: Boolean(
        graph?.runbook &&
        ((graph.runbook.commands?.length ?? 0) > 0 ||
          (graph.runbook.ports?.length ?? 0) > 0 ||
          (graph.runbook.env?.length ?? 0) > 0)
      ),
      runbookCommandCount: graph?.runbook?.commands?.length ?? 0,
      manifestFileCount: files.size,
    },
  };
};

/**
 * Register the Quick-Run IPC handlers. Idempotent. Called once during
 * Main-process bootstrap. Pure mechanical reads — never calls a model.
 */
export function registerRunTargetBridge(): void {
  runTargetChannels.plan.provider(async (req): Promise<RunTargetResult<RunPlanResponse>> => {
    try {
      const rootPath = req.rootPath?.trim();
      if (!rootPath) return { ok: false, error: 'A folder path is required.' };
      return { ok: true, data: await resolveRunPlanResponse(rootPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  runTargetChannels.save.provider(async (req): Promise<RunTargetResult<RepoRunConfigs>> => {
    try {
      const rootPath = req.rootPath?.trim();
      if (!rootPath) return { ok: false, error: 'A folder path is required.' };
      const updated = await saveRunConfig(nodeStoreDeps(), rootPath, req.config);
      return { ok: true, data: updated };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  runTargetChannels.clear.provider(async (req): Promise<RunTargetResult<RepoRunConfigs>> => {
    try {
      const rootPath = req.rootPath?.trim();
      if (!rootPath) return { ok: false, error: 'A folder path is required.' };
      const updated = await clearRunConfig(nodeStoreDeps(), rootPath, req.platform);
      return { ok: true, data: updated };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Poll a dev URL ONCE (any HTTP response = reachable). The dev server itself
  // runs in the IDE terminal — this never spawns anything; it only lets the
  // panel know when to navigate the embedded browser to the freshly-up app.
  runTargetChannels.probe.provider(async (req): Promise<RunTargetResult<RunProbeResponse>> => {
    const url = req.url?.trim();
    if (!url) return { ok: false, error: 'A URL is required.' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        await fetch(url, { method: 'GET', signal: controller.signal });
        return { ok: true, data: { reachable: true } };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return { ok: true, data: { reachable: false } };
    }
  });
}
