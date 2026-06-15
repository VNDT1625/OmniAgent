/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PURE in-chat stale detector (mechanism c).
 *
 * After RTK grounds a model with a fact, this decides whether the fact should be
 * re-verified before being relied upon — because its TTL lapsed, or because the
 * conversation surfaced evidence that contradicts it (or the user doubted it).
 * The decision is a pure function of the fact's freshness plus a few boolean
 * conversation signals, so it is deterministic and trivially testable. The
 * actual verification (network) is the caller's job.
 *
 * Policy: fresh contradicting evidence always triggers verification (new
 * evidence trumps a still-valid TTL); an expired fact always triggers it; a
 * merely stale fact triggers it only when something in the chat casts doubt.
 *
 * No I/O, no Node/DOM APIs.
 */

import { computeFreshness } from './freshness';
import type { KnowledgeFact } from './rtkTypes';

/** Conversation-derived signals about a grounded fact. */
export type ChatSignals = {
  /** The chat surfaced evidence that contradicts the fact's current value. */
  contradicted?: boolean;
  /** The user expressed doubt the value is current (e.g. "are you sure that's still true?"). */
  userDoubt?: boolean;
};

/** The detector's verdict. */
export type StaleVerdict = {
  /** Whether the fact should be verified before being trusted. */
  shouldVerify: boolean;
  /** Why (for logging / surfacing to the agent). */
  reason: string;
};

/**
 * Decide whether a grounded fact should be re-verified.
 *
 * @param fact The fact that was used to ground the model.
 * @param signals Conversation signals (contradiction / user doubt).
 * @param now Epoch ms "now" (injected for determinism).
 */
export const detectStale = (
  fact: Pick<KnowledgeFact, 'validAsOf' | 'expiresAt' | 'ttlMs' | 'status'>,
  signals: ChatSignals,
  now: number
): StaleVerdict => {
  if (signals.contradicted) {
    return { shouldVerify: true, reason: 'Conversation surfaced contradicting evidence.' };
  }
  if (fact.status === 'needs_review') {
    return { shouldVerify: true, reason: 'Fact is already flagged needs_review.' };
  }
  const freshness = computeFreshness(fact, now);
  if (freshness === 'expired' || freshness === 'unknown') {
    return { shouldVerify: true, reason: `Fact freshness is ${freshness}.` };
  }
  if (freshness === 'stale' && signals.userDoubt) {
    return { shouldVerify: true, reason: 'Fact is stale and the user doubted it.' };
  }
  return { shouldVerify: false, reason: `Fact freshness is ${freshness}; no doubt signals.` };
};
