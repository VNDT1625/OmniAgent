/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Approval gate — the boss's authority over the pipeline (Requirement 4).
 *
 * When a role's workflow asks to have a milestone approved (e.g. an architecture
 * document before work fans out) or to perform a sensitive action, the pipeline
 * pauses that branch and waits for a human/President decision. This module is a
 * small promise registry: `request(...)` returns a promise that stays pending
 * until `resolve(requestId, ...)` is called, which mirrors how the existing
 * `companyConversation` permission gate works — generalised to both
 * stage-approvals (with an artifact) and sensitive-action permissions.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import type { ApprovalDecision } from './pipelineTypes';

/** Public contract of the approval gate. */
export type IApprovalGate = {
  /**
   * Register a pending approval and return a promise that resolves when the boss
   * answers (or the gate is cancelled). The `requestId` must be unique.
   */
  request: (requestId: string) => Promise<ApprovalDecision>;
  /** Resolve a pending request. Returns `false` if the id is unknown/stale. */
  resolve: (decision: ApprovalDecision) => boolean;
  /** Cancel every pending request (e.g. on Stop) as denied. */
  cancelAll: (note?: string) => void;
  /** Number of currently pending requests. */
  pendingCount: () => number;
};

/** Create an in-memory approval gate. */
export const createApprovalGate = (): IApprovalGate => {
  const pending = new Map<string, (decision: ApprovalDecision) => void>();

  const request = (requestId: string): Promise<ApprovalDecision> =>
    new Promise<ApprovalDecision>((resolve) => {
      pending.set(requestId, (decision) => {
        pending.delete(requestId);
        resolve(decision);
      });
    });

  const resolve = (decision: ApprovalDecision): boolean => {
    const resolver = pending.get(decision.requestId);
    if (!resolver) return false;
    resolver(decision);
    return true;
  };

  const cancelAll = (note?: string): void => {
    for (const [requestId, resolver] of Array.from(pending.entries())) {
      resolver({ requestId, approved: false, note: note ?? 'cancelled' });
    }
    pending.clear();
  };

  return { request, resolve, cancelAll, pendingCount: () => pending.size };
};
