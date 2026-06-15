/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `patchApplier` — the real, reversible {@link PatchApplier} for the patch gate
 * (Yêu cầu 6, criteria 6.5 / 6.7). It applies an APPROVED, sandbox-validated
 * unified diff to the app source tree and always captures a rollback snapshot
 * FIRST so the change can be reverted.
 *
 * SAFETY SCOPE — by design this does NOT hot-swap the running, packaged binary
 * (that needs a build/repackage step which is out of scope and unsafe to do
 * live). Instead it operates on a configured writable `targetRoot` (the app
 * source dir in development; a staged copy in production) and, before touching
 * any file, copies the original bytes of every file the diff edits into a
 * per-proposal snapshot dir under `snapshotRoot`. `restore` copies those bytes
 * back. The patch gate guarantees `apply` is only ever reached for a proposal
 * whose sandbox run PASSED and that cleared review (Property 8), so the file the
 * user accepted is exactly what was tested.
 *
 * The unified diff is applied with the `diff` package (already a dependency).
 * All fs access is injected so this module is unit-testable without real disk.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { applyPatch, parsePatch } from 'diff';
import type { PatchApplier } from './patchGate';
import type { PatchProposal } from './monitorTypes';

/** Minimal fs surface used by the applier (injectable for tests). */
export type PatchApplierFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, encoding: 'utf-8'): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  rm(target: string, options: { recursive: true; force: true }): Promise<void>;
  access(filePath: string): Promise<void>;
};

const defaultFs: PatchApplierFs = {
  readFile: (p, enc) => nodeFs.promises.readFile(p, enc),
  writeFile: (p, data, enc) => nodeFs.promises.writeFile(p, data, enc),
  mkdir: (p, opts) => nodeFs.promises.mkdir(p, opts),
  rm: (p, opts) => nodeFs.promises.rm(p, opts),
  access: (p) => nodeFs.promises.access(p),
};

/** Options for {@link createPatchApplier}. */
export type PatchApplierOptions = {
  /** Writable root the diff is applied within (app source dir / staged copy). */
  targetRoot: string;
  /** Root under which per-proposal rollback snapshots are stored. */
  snapshotRoot: string;
  /** fs implementation. Defaults to `fs/promises`. */
  fs?: PatchApplierFs;
};

/** A file the diff touches: its repo-relative path. */
type DiffFile = { relPath: string };

/** Strip a leading `a/` or `b/` prefix git adds to diff headers. */
const stripPrefix = (p: string): string => p.replace(/^[ab]\//, '');

/** Resolve a diff path and confirm it stays inside the target root. */
const resolveWithinRoot = (root: string, rel: string): string => {
  const normalisedRoot = path.resolve(root);
  const resolved = path.resolve(normalisedRoot, rel);
  const relCheck = path.relative(normalisedRoot, resolved);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`[Monitor] Refusing to patch a path outside the target root: ${rel}`);
  }
  return resolved;
};

/** Extract the set of files a unified diff edits (from its `+++ b/...` headers). */
export const filesInDiff = (diff: string): DiffFile[] => {
  const patches = parsePatch(diff);
  const files: DiffFile[] = [];
  const seen = new Set<string>();
  for (const p of patches) {
    // Prefer the new-file header; fall back to the old-file header.
    const raw = p.newFileName ?? p.oldFileName;
    if (!raw) continue;
    const rel = stripPrefix(raw).trim();
    if (!rel || rel === '/dev/null' || seen.has(rel)) continue;
    seen.add(rel);
    files.push({ relPath: rel });
  }
  return files;
};

/**
 * Create a real {@link PatchApplier} that applies diffs reversibly within
 * `targetRoot`, snapshotting originals under `snapshotRoot/<proposalId>`.
 *
 * @param options Target/snapshot roots + injectable fs.
 * @returns A reversible patch applier for the gate.
 */
export const createPatchApplier = (options: PatchApplierOptions): PatchApplier => {
  const fs = options.fs ?? defaultFs;
  const targetRoot = path.resolve(options.targetRoot);
  const snapshotRoot = path.resolve(options.snapshotRoot);

  /** Manifest path recording which relative files a snapshot captured. */
  const manifestPath = (rollbackId: string): string => path.join(snapshotRoot, rollbackId, 'manifest.json');

  /** Snapshot file path mirroring a relative source path inside the snapshot dir. */
  const snapshotFilePath = (rollbackId: string, rel: string): string =>
    path.join(snapshotRoot, rollbackId, 'files', rel);

  const snapshot: PatchApplier['snapshot'] = async (proposal: PatchProposal) => {
    const rollbackId = `${proposal.id}-${Date.now()}`;
    const files = filesInDiff(proposal.diff);
    const captured: string[] = [];

    for (const { relPath } of files) {
      const abs = resolveWithinRoot(targetRoot, relPath);
      let original: string | undefined;
      try {
        original = await fs.readFile(abs, 'utf-8');
      } catch {
        // New file (does not exist yet) — record it so restore deletes it.
        original = undefined;
      }
      const snapPath = snapshotFilePath(rollbackId, relPath);
      await fs.mkdir(path.dirname(snapPath), { recursive: true });
      // Sentinel: a null-byte-free marker file means "did not exist; delete on restore".
      await fs.writeFile(snapPath, original ?? '\u0000__MONITOR_ABSENT__', 'utf-8');
      captured.push(relPath);
    }

    await fs.mkdir(path.dirname(manifestPath(rollbackId)), { recursive: true });
    await fs.writeFile(
      manifestPath(rollbackId),
      JSON.stringify({ proposalId: proposal.id, files: captured }, null, 2),
      'utf-8'
    );
    return { rollbackId };
  };

  const apply: PatchApplier['apply'] = async (proposal: PatchProposal) => {
    const patches = parsePatch(proposal.diff);
    for (const p of patches) {
      const raw = p.newFileName ?? p.oldFileName;
      if (!raw) continue;
      const rel = stripPrefix(raw).trim();
      if (!rel || rel === '/dev/null') continue;
      const abs = resolveWithinRoot(targetRoot, rel);

      let current = '';
      try {
        current = await fs.readFile(abs, 'utf-8');
      } catch {
        current = ''; // new file
      }
      const next = applyPatch(current, p);
      if (next === false) {
        throw new Error(`[Monitor] Patch did not apply cleanly to ${rel}; aborting (run is reversible via snapshot).`);
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, next, 'utf-8');
    }
  };

  const restore: PatchApplier['restore'] = async (rollbackId: string) => {
    let manifest: { files: string[] };
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath(rollbackId), 'utf-8')) as { files: string[] };
    } catch {
      throw new Error(`[Monitor] No rollback snapshot found for "${rollbackId}".`);
    }
    for (const rel of manifest.files) {
      const abs = resolveWithinRoot(targetRoot, rel);
      const snapped = await fs.readFile(snapshotFilePath(rollbackId, rel), 'utf-8');
      if (snapped === '\u0000__MONITOR_ABSENT__') {
        // File did not exist before the patch → remove it on rollback.
        await fs.rm(abs, { recursive: true, force: true });
      } else {
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, snapped, 'utf-8');
      }
    }
  };

  return { snapshot, apply, restore };
};
