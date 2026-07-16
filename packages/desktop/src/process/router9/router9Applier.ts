/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main-process applier for the 9Router distribution layer.
 *
 * The renderer panel computes a {@link ConnectorPlan} with the pure engine and
 * can show it for copy-paste; this module performs the actual, higher-risk side
 * effects when the user clicks "Apply":
 *
 *  - `configFile` targets → write/deep-merge each {@link ConfigFilePlan} to disk
 *    (backing up any existing file first, never clobbering unrelated keys).
 *  - `env` targets → environment variables cannot be persisted for another
 *    process from here, so we DON'T fake it: we return them as `notes` so the UI
 *    can tell the user to export them (the copy block already does this).
 *
 * Every write is atomic (tmp file + rename) and creates a timestamped `.bak`
 * of any file it overwrites, so applying is reversible.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildConnectorPlan, expandHome, mergeConfigContent, type Router9Endpoint } from '@/common/router9';

/** What happened to a single config file during apply. */
export type AppliedFile = {
  /** The path that was written (absolute, home-expanded). */
  path: string;
  /** `written` = created/merged, `skipped` = createIfMissing on an existing file. */
  status: 'written' | 'skipped';
  /** Absolute path of the backup created before overwriting, if any. */
  backupPath?: string;
};

/** Result of applying a connector plan to disk. */
export type ApplyResult = {
  targetId: string;
  files: AppliedFile[];
  /** Human-facing notes (e.g. env vars the user must export themselves). */
  notes: string[];
};

/** Injectable filesystem seams so the applier is unit-testable without real I/O. */
export type Router9ApplierDeps = {
  readFile: (p: string) => Promise<string | undefined>;
  writeFileAtomic: (p: string, content: string) => Promise<void>;
  backup: (p: string) => Promise<string | undefined>;
  homeDir: () => string;
};

/** Read a file, resolving `undefined` when it does not exist (ENOENT). */
const defaultReadFile = async (p: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
};

/** Write `content` to `p` atomically (tmp + rename), creating parent dirs. */
const defaultWriteFileAtomic = async (p: string, content: string): Promise<void> => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, p);
};

/** Copy an existing file to a timestamped `.bak`; no-op (returns undefined) if absent. */
const defaultBackup = async (p: string): Promise<string | undefined> => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${p}.${stamp}.bak`;
    await fs.copyFile(p, backupPath);
    return backupPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
};

const defaultDeps: Router9ApplierDeps = {
  readFile: defaultReadFile,
  writeFileAtomic: defaultWriteFileAtomic,
  backup: defaultBackup,
  homeDir: () => os.homedir(),
};

/**
 * Apply the connector plan for `targetId` + `endpoint` to disk.
 *
 * Recomputes the plan in the Main process (never trusts a plan shipped from the
 * renderer) and writes its config files. Throws if the endpoint is invalid or a
 * target's existing config is corrupt — the bridge wraps this in an
 * always-resolve envelope.
 */
export const applyConnectorPlan = async (
  targetId: string,
  endpoint: Router9Endpoint,
  deps: Partial<Router9ApplierDeps> = {}
): Promise<ApplyResult> => {
  const d: Router9ApplierDeps = { ...defaultDeps, ...deps };
  const plan = buildConnectorPlan(targetId, endpoint);

  const result: ApplyResult = { targetId, files: [], notes: [] };

  for (const file of plan.files) {
    const absPath = path.normalize(expandHome(file.path, d.homeDir()));
    const existingRaw = await d.readFile(absPath);
    const finalContent = mergeConfigContent({
      format: file.format,
      mergeStrategy: file.mergeStrategy,
      incomingContent: file.content,
      existingRaw,
    });
    if (finalContent === null) {
      result.files.push({ path: absPath, status: 'skipped' });
      continue;
    }
    const backupPath = existingRaw !== undefined ? await d.backup(absPath) : undefined;
    await d.writeFileAtomic(absPath, finalContent);
    result.files.push({ path: absPath, status: 'written', backupPath });
  }

  // Env-mechanism targets cannot have their variables persisted for a separate
  // process from here — surface them as notes instead of silently doing nothing.
  if (plan.env.length > 0) {
    for (const e of plan.env) {
      result.notes.push(`${e.key}=${e.value}`);
    }
  }

  return result;
};
