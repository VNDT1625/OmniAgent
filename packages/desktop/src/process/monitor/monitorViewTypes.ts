/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe view types for the monitor surface (Yêu cầu 6). These are the
 * shapes the IPC bridge sends to the renderer; kept separate from the internal
 * `monitorTypes` so the renderer can `import type` them without pulling in any
 * Node-only module.
 */

export type { BugReport } from './monitorTypes';

/** A patch as presented to the renderer (no internal diff/rollback details). */
export type GatedPatchView = {
  /** Proposal id. */
  proposalId: string;
  /** Risk level (`low` | `medium` | `high`). */
  risk: string;
  /** Human-readable explanation of the fix. */
  explanation: string;
  /** Current gate status. */
  status: string;
  /** Why it was rejected, when applicable. */
  rejectedReason?: string;
};

/**
 * A persisted patch proposal as presented to the renderer. Carries the analysis
 * (root cause + explanation + risk) and the current gate `status`. The raw diff
 * is intentionally omitted from the list view; the gate actions reference it by
 * `proposalId`. `status` is `'proposed'` until the proposal reaches the gate.
 */
export type ProposalView = {
  /** Proposal id (used by approve/reject/rollback). */
  proposalId: string;
  /** The report this proposal addresses. */
  reportId: string;
  /** The error signature it targets. */
  signature: string;
  /** Plain-language root cause. */
  rootCause: string;
  /** Human-readable explanation of the fix. */
  explanation: string;
  /** Risk level (`low` | `medium` | `high`). */
  risk: string;
  /** Unix-ms timestamp the proposal was created. */
  createdAt: number;
  /** Gate status (`proposed` before it reaches the gate, then the gate status). */
  status: string;
  /** Why it was rejected, when applicable. */
  rejectedReason?: string;
};
