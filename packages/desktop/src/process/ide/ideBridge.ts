/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE repo-scan IPC bridge — the Main-process plane that turns a folder on disk
 * into the lightweight intra-repo import graph the IDE "repo-intelligence" view
 * renders. The renderer cannot walk the filesystem itself, so this bridge does
 * the walk with Node `fs` (injecting the primitives into the pure
 * {@link collectRepoFiles}) and then builds the graph with the pure
 * {@link buildGraphFromFiles}.
 *
 * One channel: `ide.scan-repo` — given an absolute folder path, returns the
 * {@link RepoGraph}. Result is wrapped in an always-resolving {@link IdeScanResult}
 * envelope so a failure (bad path, permission error) is observable instead of
 * hanging the renderer (the platform bridge swallows rejected promises).
 *
 * The global bootstrap calls {@link registerIdeBridge} once; this module does
 * not wire itself in (mirrors `studioChatBridge.ts`).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { buildGraphFromFiles, collectRepoFiles, type RepoGraph } from './repoGraph';

/** IPC channel names for the IDE repo-scan surface (renderer-safe contract). */
export const IDE_SCAN_CHANNELS = {
  scanRepo: 'ide.scan-repo',
} as const;

/** Request for {@link IDE_SCAN_CHANNELS.scanRepo}. */
export type ScanRepoRequest = {
  /** Absolute path of the folder to scan. */
  rootPath: string;
  /** Optional hard cap on the number of files walked (defaults to the graph cap). */
  maxFiles?: number;
};

/**
 * Result envelope — always resolves (never rejects), so the renderer can branch
 * on `ok` instead of hanging on a swallowed rejection.
 */
export type IdeScanResult = { ok: true; data: RepoGraph } | { ok: false; error: string };

/** Typed IDE scan channels. Exported for bootstrap registration wiring. */
export const ideScanChannels = {
  scanRepo: bridge.buildProvider<IdeScanResult, ScanRepoRequest>(IDE_SCAN_CHANNELS.scanRepo),
};

/** Walk a folder with Node `fs` and build its intra-repo import graph. */
const scanRepo = async (req: ScanRepoRequest): Promise<RepoGraph> => {
  const rootPath = req.rootPath?.trim();
  if (!rootPath || rootPath.length === 0) {
    throw new Error('A folder path is required.');
  }

  const files = await collectRepoFiles(
    rootPath,
    {
      listDir: async (dir) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          fullPath: path.join(dir, entry.name),
          isDir: entry.isDirectory(),
        }));
      },
      readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
      toRel: (full) => path.relative(rootPath, full).replace(/\\/g, '/'),
    },
    { maxFiles: req.maxFiles }
  );

  return buildGraphFromFiles(rootPath, files);
};

/**
 * Register the IDE repo-scan IPC handler. Idempotent (re-registration replaces
 * the bound handler). Intended to be called once during Main-process bootstrap.
 */
export function registerIdeBridge(): void {
  ideScanChannels.scanRepo.provider(async (req): Promise<IdeScanResult> => {
    try {
      return { ok: true, data: await scanRepo(req) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[IdeBridge] scan-repo failed:', error);
      return { ok: false, error: message };
    }
  });
}
