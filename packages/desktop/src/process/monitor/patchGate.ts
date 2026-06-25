/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `patchGate` — the approval gate before a fix touches the main app (Yêu cầu 6,
 * criteria 6.5 / 6.6 / 6.7). Invariants enforced here (validated by Property 8):
 *
 * - A patch is applied to the main app ONLY IF the sandbox run passed AND it has
 *   cleared review (criterion 6.5). A failed sandbox → the copy is discarded and
 *   the main app stays untouched.
 * - Review is REQUIRED by default; it may be configured to auto-apply only for
 *   low-risk fixes (criterion 6.6).
 * - A rollback point (the previous version) is ALWAYS captured before applying,
 *   so the change can be reverted (criterion 6.7).
 *
 * The actual "apply to main app" + "snapshot for rollback" + "restore" are
 * injected so this module only enforces the policy/state-machine and stays
 * unit-testable. Process boundary: Main-process (Node.js) module — no DOM.
 */

import type { PatchGateStatus, PatchProposal, SandboxResult } from './monitorTypes';

/** Performs the irreversible side effects of applying/reverting a patch (injected). */
export type PatchApplier = {
  /** Snapshot the current main app so it can be restored later (criterion 6.7). */
  snapshot(proposal: PatchProposal): Promise<{ rollbackId: string }>;
  /** Apply the patch to the main app. */
  apply(proposal: PatchProposal): Promise<void>;
  /** Restore a previously-captured snapshot (rollback). */
  restore(rollbackId: string): Promise<void>;
};

/** Approval policy (criterion 6.6). */
export type GatePolicy = {
  /**
   * Auto-apply without human review for fixes at or below this risk level.
   * `'none'` (default) → always require review. `'low'` → auto-apply low-risk.
   */
  autoApplyMaxRisk?: 'none' | 'low' | 'medium';
};

/** A patch tracked through the gate. */
export type GatedPatch = {
  /** The proposal under consideration. */
  proposal: PatchProposal;
  /** The sandbox result that qualified it. */
  sandbox: SandboxResult;
  /** Current gate status. */
  status: PatchGateStatus;
  /** Rollback id captured at apply time (criterion 6.7). */
  rollbackId?: string;
  /** Why it was rejected, when applicable. */
  rejectedReason?: string;
};

/** Options for {@link createPatchGate}. */
export type PatchGateDeps = {
  /** Applies/snapshots/restores the main app. */
  applier: PatchApplier;
  /** Approval policy. Defaults to always-require-review. */
  policy?: GatePolicy;
};

/** Public contract of the patch gate. */
export type IPatchGate = {
  /**
   * Submit a sandbox-validated proposal to the gate. If the sandbox FAILED the
   * patch is rejected outright (never applied). If it passed, the patch is either
   * auto-applied (when policy permits its risk) or left `pending-review`.
   */
  submit(proposal: PatchProposal, sandbox: SandboxResult): Promise<GatedPatch>;
  /** Approve a pending patch and apply it to the main app (snapshots first). */
  approve(proposalId: string): Promise<GatedPatch>;
  /** Reject a pending patch; the main app is never touched. */
  reject(proposalId: string, reason: string): Promise<GatedPatch>;
  /** Roll back a previously-applied patch (criterion 6.7). */
  rollback(proposalId: string): Promise<GatedPatch>;
  /** Look up a tracked patch by proposal id. */
  get(proposalId: string): GatedPatch | undefined;
};

/** Risk ordering for the auto-apply policy comparison. */
const RISK_ORDER: Record<'none' | 'low' | 'medium' | 'high', number> = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * Create a {@link IPatchGate} enforcing the safe-before-auto policy.
 *
 * @param deps Applier + policy. See {@link PatchGateDeps}.
 * @returns A patch gate enforcing review/rollback invariants.
 */
export const createPatchGate = (deps: PatchGateDeps): IPatchGate => {
  const autoApplyMaxRisk = deps.policy?.autoApplyMaxRisk ?? 'none';
  const patches = new Map<string, GatedPatch>();

  /** Snapshot the main app, then apply the patch — the only path that mutates main. */
  const applyToMain = async (gated: GatedPatch): Promise<void> => {
    const { rollbackId } = await deps.applier.snapshot(gated.proposal); // rollback point FIRST (6.7)
    gated.rollbackId = rollbackId;
    await deps.applier.apply(gated.proposal);
    gated.status = 'applied';
  };

  const submit: IPatchGate['submit'] = async (proposal, sandbox) => {
    const gated: GatedPatch = { proposal, sandbox, status: 'pending-review' };
    patches.set(proposal.id, gated);

    // INVARIANT (Property 8): a failed sandbox can NEVER be applied to main.
    if (!sandbox.passed) {
      gated.status = 'rejected';
      gated.rejectedReason = sandbox.detail ?? 'Sandbox run did not pass.';
      return { ...gated };
    }

    // Sandbox passed → auto-apply only if policy permits this risk; else review.
    if (autoApplyMaxRisk !== 'none' && RISK_ORDER[proposal.risk] <= RISK_ORDER[autoApplyMaxRisk]) {
      gated.status = 'approved';
      await applyToMain(gated);
    }
    return { ...gated };
  };

  const approve: IPatchGate['approve'] = async (proposalId) => {
    const gated = patches.get(proposalId);
    if (!gated) throw new Error(`[PatchGate] Unknown proposal: ${proposalId}`);
    // Guard the core invariant even on the manual path: only apply if it passed.
    if (!gated.sandbox.passed) {
      throw new Error('[PatchGate] Cannot approve a patch whose sandbox run did not pass.');
    }
    if (gated.status === 'applied') return { ...gated };
    gated.status = 'approved';
    await applyToMain(gated);
    return { ...gated };
  };

  const reject: IPatchGate['reject'] = async (proposalId, reason) => {
    const gated = patches.get(proposalId);
    if (!gated) throw new Error(`[PatchGate] Unknown proposal: ${proposalId}`);
    gated.status = 'rejected';
    gated.rejectedReason = reason;
    return { ...gated };
  };

  const rollback: IPatchGate['rollback'] = async (proposalId) => {
    const gated = patches.get(proposalId);
    if (!gated) throw new Error(`[PatchGate] Unknown proposal: ${proposalId}`);
    if (gated.status !== 'applied' || !gated.rollbackId) {
      throw new Error('[PatchGate] Only an applied patch with a rollback point can be rolled back.');
    }
    await deps.applier.restore(gated.rollbackId);
    gated.status = 'rolled-back';
    return { ...gated };
  };

  const get: IPatchGate['get'] = (proposalId) => {
    const gated = patches.get(proposalId);
    return gated ? { ...gated } : undefined;
  };

  return { submit, approve, reject, rollback, get };
};
