/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Persistence for the latest {@link SystemSnapshot}.
 *
 * The System Insight sampler writes a `system-snapshot.json` file to the app
 * data directory at a low cadence. The standalone Agent-plane MCP server reads
 * this file (it runs in a separate `node` process and cannot reach the live
 * Main-process service or Electron APIs) — the same cross-process pattern the
 * Resource MCP server uses with `resource-state.json`.
 *
 * Writes are best-effort and atomic-ish (write to a temp file, then rename) so a
 * reader never observes a half-written file.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SystemSnapshot } from './systemInfoTypes';

/** Name of the persisted snapshot file (read by the MCP server). */
export const SYSTEM_SNAPSHOT_FILE = 'system-snapshot.json';

/** External writes injected for testability. */
export type SnapshotStoreDeps = {
  /** Directory that holds {@link SYSTEM_SNAPSHOT_FILE}. */
  dir: string;
  /** Write a file as UTF-8 (defaults to `fs.writeFileSync`). */
  writeFile: (filePath: string, data: string) => void;
  /** Atomically rename a file (defaults to `fs.renameSync`). */
  rename: (from: string, to: string) => void;
};

/** Build default deps backed by real `fs`. */
export const defaultSnapshotStoreDeps = (dir: string): SnapshotStoreDeps => ({
  dir,
  writeFile: (filePath, data) => fs.writeFileSync(filePath, data, 'utf-8'),
  rename: (from, to) => fs.renameSync(from, to),
});

/** A writer that persists snapshots to disk. */
export type SnapshotStore = {
  /** Persist the given snapshot (best-effort; never throws). */
  write: (snapshot: SystemSnapshot) => void;
};

/** Create a snapshot store writing to {@link SnapshotStoreDeps.dir}. */
export const createSnapshotStore = (deps: SnapshotStoreDeps): SnapshotStore => {
  const target = path.join(deps.dir, SYSTEM_SNAPSHOT_FILE);
  const tmp = `${target}.tmp`;

  const write = (snapshot: SystemSnapshot): void => {
    try {
      deps.writeFile(tmp, JSON.stringify(snapshot));
      deps.rename(tmp, target);
    } catch (error) {
      console.warn('[SystemInfo] Failed to persist system snapshot:', error);
    }
  };

  return { write };
};
