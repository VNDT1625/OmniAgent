/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `patchSandbox` — tries a proposed fix on an ISOLATED COPY of the app, never the
 * running one (Yêu cầu 6, criteria 6.4 & 6.8). The flow is:
 *
 *   1. Build an isolated copy of the app.
 *   2. Apply the proposed diff to the copy.
 *   3. Run a hidden Windows test session against it via the Yêu cầu 2b testing
 *      layer ({@link ITestOrchestrator}).
 *   4. Report pass/fail; the copy is always disposed afterwards.
 *
 * Building + testing a patch is heavy, so the whole sandbox run is gated by the
 * ResourceCoordinator under `TaskKind: 'patchBuild'` (criterion 6.8). The copy
 * builder + diff applier are injected so this module only orchestrates and stays
 * unit-testable without touching the real filesystem or building anything.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { Lease, LeaseRequest } from '../resource/leaseTypes';
import type { ITestOrchestrator } from '../testing/testOrchestrator';
import type { TestScenario } from '../testing/testingTypes';
import type { PatchProposal, SandboxResult } from './monitorTypes';

/** Minimal lease surface (the real ResourceCoordinator satisfies it). */
export type LeaseCoordinator = {
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  releaseLease: (id: string) => void;
};

/** A built, isolated copy of the app ready to be patched + tested. */
export type AppCopy = {
  /** Unique id of the copy. */
  id: string;
  /** Root directory of the isolated copy. */
  rootDir: string;
};

/** Builds + disposes isolated app copies (injected; real impl copies files). */
export type AppCopyBuilder = {
  /** Build a fresh isolated copy of the app. */
  build(): Promise<AppCopy>;
  /** Dispose a previously-built copy. */
  dispose(copy: AppCopy): Promise<void>;
};

/** Applies a unified diff to a directory (injected). */
export type DiffApplier = {
  /** Apply `diff` within `rootDir`; resolve `false` if it does not apply cleanly. */
  apply(rootDir: string, diff: string): Promise<boolean>;
};

/** Options for {@link createPatchSandbox}. */
export type PatchSandboxDeps = {
  /** Builds/disposes isolated app copies. */
  copyBuilder: AppCopyBuilder;
  /** Applies the proposed diff to a copy. */
  diffApplier: DiffApplier;
  /** The 2b testing orchestrator used to run the hidden Windows test. */
  testOrchestrator: ITestOrchestrator;
  /** Lease gate for the heavy build+test (criterion 6.8). */
  coordinator: LeaseCoordinator;
  /** Builds the test scenario to validate a patched copy. */
  buildScenario: (copy: AppCopy, proposal: PatchProposal) => TestScenario;
  /** Estimated RAM (MB) for a sandbox run. Defaults to 1536. */
  estCostMB?: number;
};

/** Public contract of the patch sandbox. */
export type IPatchSandbox = {
  /** Build a copy, apply the patch, run the hidden test, and report (criterion 6.4). */
  tryPatch(proposal: PatchProposal): Promise<SandboxResult>;
};

/** Default estimated RAM (MB) for a build+test sandbox run. */
const DEFAULT_EST_COST_MB = 1536;

/**
 * Create a {@link IPatchSandbox}.
 *
 * @param deps Copy builder, diff applier, test orchestrator, lease gate.
 * @returns A sandbox that validates a patch on an isolated copy.
 */
export const createPatchSandbox = (deps: PatchSandboxDeps): IPatchSandbox => {
  const estCostMB = deps.estCostMB ?? DEFAULT_EST_COST_MB;

  const tryPatch: IPatchSandbox['tryPatch'] = async (proposal) => {
    // Heavy build + test → lease under 'patchBuild' (criterion 6.8). Released in
    // finally so the budget always recovers.
    const lease = await deps.coordinator.requestLease({ kind: 'patchBuild', estCostMB });
    let copy: AppCopy | undefined;
    try {
      copy = await deps.copyBuilder.build();

      const applied = await deps.diffApplier.apply(copy.rootDir, proposal.diff);
      if (!applied) {
        return { proposalId: proposal.id, passed: false, detail: 'Patch did not apply cleanly to the isolated copy.' };
      }

      const scenario = deps.buildScenario(copy, proposal);
      const session = await deps.testOrchestrator.run(scenario, { visibility: 'hidden' });
      const passed = session.status === 'passed';
      return {
        proposalId: proposal.id,
        passed,
        reportPath: session.reportPath,
        detail: passed ? undefined : `Hidden test ${session.status}${session.error ? `: ${session.error}` : ''}`,
      };
    } catch (error) {
      return { proposalId: proposal.id, passed: false, detail: error instanceof Error ? error.message : String(error) };
    } finally {
      // The isolated copy is always disposed; the running app is never touched.
      if (copy) await deps.copyBuilder.dispose(copy).catch((): undefined => undefined);
      deps.coordinator.releaseLease(lease.id);
    }
  };

  return { tryPatch };
};
