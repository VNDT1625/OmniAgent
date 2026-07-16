/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `patchValidationSandbox` — a real, achievable {@link IPatchSandbox} that
 * validates a proposed fix on an ISOLATED COPY of only the files the diff
 * touches, never the running app (Yêu cầu 6, criteria 6.4 / 6.5 / 6.8).
 *
 * Why not the full virtual-display Windows UI test from `patchSandbox.ts`? That
 * path needs the Testing-2b display/driver backends (Xvfb/CreateDesktop +
 * Playwright/nut.js) which are not implemented yet. This sandbox instead does
 * the validation that is both meaningful for a code patch and achievable today:
 *
 *   1. Copy the affected files (parsed from the diff) into an isolated temp dir.
 *   2. Apply the unified diff there; a patch that does not apply cleanly FAILS.
 *   3. Optionally run an injected validation command (e.g. typecheck) on the
 *      copy; a non-zero exit FAILS.
 *   4. Always dispose the copy. The running app is never touched.
 *
 * The whole run is gated by the ResourceCoordinator under `patchBuild`
 * (criterion 6.8) and the lease is released in `finally`. fs + command runner +
 * id/clock are injected so this is unit-testable without real disk or builds.
 *
 * NOTE: "applies cleanly" is a conservative pass — it does not by itself prove
 * runtime correctness, so the {@link IPatchGate} still REQUIRES human review by
 * default (criterion 6.6). A reviewer sees the diff + explanation before any
 * change reaches the main app, and a rollback point is always kept (6.7).
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { applyPatch, parsePatch } from 'diff';
import type { Lease, LeaseRequest } from '../resource/leaseTypes';
import type { IPatchSandbox } from './patchSandbox';
import type { PatchProposal, SandboxResult } from './monitorTypes';

/** Minimal lease surface (the real ResourceCoordinator satisfies it). */
export type LeaseCoordinator = {
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  releaseLease: (id: string) => void;
};

/** Minimal fs surface used by the sandbox (injectable for tests). */
export type ValidationSandboxFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, encoding: 'utf-8'): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  rm(target: string, options: { recursive: true; force: true }): Promise<void>;
};

const defaultFs: ValidationSandboxFs = {
  readFile: (p, enc) => nodeFs.promises.readFile(p, enc),
  writeFile: (p, data, enc) => nodeFs.promises.writeFile(p, data, enc),
  mkdir: (p, opts) => nodeFs.promises.mkdir(p, opts),
  rm: (p, opts) => nodeFs.promises.rm(p, opts),
};

/** Runs an optional validation command inside the isolated copy. */
export type ValidationCommandRunner = {
  /** Run validation in `copyDir`; resolve ok=false (with detail) on failure. */
  run(copyDir: string): Promise<{ ok: boolean; detail?: string }>;
};

/** Options for {@link createPatchValidationSandbox}. */
export type PatchValidationSandboxDeps = {
  /** Writable root the affected files are read from (app source dir). */
  sourceRoot: string;
  /** Root under which isolated copies are created (e.g. a temp dir). */
  sandboxRoot: string;
  /** Lease gate for the heavy validation (criterion 6.8). */
  coordinator: LeaseCoordinator;
  /** fs implementation. Defaults to `fs/promises`. */
  fs?: ValidationSandboxFs;
  /** Optional command validation (typecheck/tests). Omit → clean-apply only. */
  commandRunner?: ValidationCommandRunner;
  /** Estimated RAM (MB) for a validation run. Defaults to 768. */
  estCostMB?: number;
  /** Unique id generator. Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
};

/** Default estimated RAM (MB) for a patch validation run. */
const DEFAULT_EST_COST_MB = 768;

/** Strip a leading `a/` or `b/` prefix git adds to diff headers. */
const stripPrefix = (p: string): string => p.replace(/^[ab]\//, '');

/** Resolve a relative path within a root, rejecting escapes. */
const resolveWithin = (root: string, rel: string): string => {
  const normalisedRoot = path.resolve(root);
  const resolved = path.resolve(normalisedRoot, rel);
  const relCheck = path.relative(normalisedRoot, resolved);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`[Monitor] Diff path escapes the source root: ${rel}`);
  }
  return resolved;
};

/**
 * Create a {@link IPatchSandbox} that validates a patch on an isolated copy of
 * the affected files.
 *
 * @param deps Source/sandbox roots, lease coordinator, optional command runner.
 * @returns A sandbox that validates a patch without touching the running app.
 */
export const createPatchValidationSandbox = (deps: PatchValidationSandboxDeps): IPatchSandbox => {
  const fs = deps.fs ?? defaultFs;
  const estCostMB = deps.estCostMB ?? DEFAULT_EST_COST_MB;
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  const sourceRoot = path.resolve(deps.sourceRoot);
  const sandboxRoot = path.resolve(deps.sandboxRoot);

  const tryPatch: IPatchSandbox['tryPatch'] = async (proposal: PatchProposal): Promise<SandboxResult> => {
    const lease = await deps.coordinator.requestLease({ kind: 'patchBuild', estCostMB });
    const copyDir = path.join(sandboxRoot, generateId());
    try {
      const patches = parsePatch(proposal.diff);
      if (patches.length === 0) {
        return { proposalId: proposal.id, passed: false, detail: 'The proposal contains no applicable diff.' };
      }

      // 1) Copy affected files into the isolated copy + 2) apply the diff there.
      for (const p of patches) {
        const raw = p.newFileName ?? p.oldFileName;
        if (!raw) continue;
        const rel = stripPrefix(raw).trim();
        if (!rel || rel === '/dev/null') continue;

        const srcAbs = resolveWithin(sourceRoot, rel);
        let current = '';
        try {
          current = await fs.readFile(srcAbs, 'utf-8');
        } catch {
          current = ''; // new file introduced by the patch
        }

        const next = applyPatch(current, p);
        if (next === false) {
          return { proposalId: proposal.id, passed: false, detail: `Patch did not apply cleanly to ${rel}.` };
        }

        const destAbs = path.join(copyDir, rel);
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
        await fs.writeFile(destAbs, next, 'utf-8');
      }

      // 3) Optional command validation (typecheck/tests) on the isolated copy.
      if (deps.commandRunner) {
        const result = await deps.commandRunner.run(copyDir);
        if (!result.ok) {
          return { proposalId: proposal.id, passed: false, detail: result.detail ?? 'Validation command failed.' };
        }
      }

      return { proposalId: proposal.id, passed: true };
    } catch (error) {
      return { proposalId: proposal.id, passed: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      // 4) Always dispose the isolated copy; release the lease.
      await fs.rm(copyDir, { recursive: true, force: true }).catch((): undefined => undefined);
      deps.coordinator.releaseLease(lease.id);
    }
  };

  return { tryPatch };
};
