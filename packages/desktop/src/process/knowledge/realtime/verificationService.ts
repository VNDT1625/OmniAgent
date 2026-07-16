/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verification guardrail for Realtime Knowledge writes (FR7).
 *
 * Before any value is overwritten, the candidate must clear an evidence bar:
 * enough independent sources, agreement between them, and (when the value
 * actually changes) corroboration that the new value is the one the sources
 * support. The decision is PURE — it scores already-gathered evidence and
 * returns `accept` / `reject` / `review` — so the policy is deterministic and
 * unit-testable. Actually applying the decision (writing the fact + history) is
 * the caller's job.
 *
 * The rule is deliberately conservative: a model "thinking" a value changed is
 * NOT evidence; only fetched sources count.
 */

import type { FactSource } from './rtkTypes';

/** A value the refresh/verify step proposes for a fact, with its evidence. */
export type VerificationCandidate = {
  /** The currently-stored value (empty string when the fact is new). */
  currentValue: string;
  /** The value the sources appear to support. */
  proposedValue: string;
  /** The sources gathered for the proposed value. */
  sources: FactSource[];
  /**
   * Optional per-source agreement signal: for each source, whether the
   * extracted/observed value matches `proposedValue`. When omitted, agreement is
   * inferred from `sources.length` alone (weaker).
   */
  agreement?: boolean[];
};

/** The outcome of a verification. */
export type VerificationDecision = {
  /** What to do with the candidate. */
  action: 'accept' | 'reject' | 'review';
  /** A confidence in [0, 1] derived from the evidence strength. */
  confidence: number;
  /** Whether the proposed value differs from the current one. */
  changed: boolean;
  /** Human-readable reasons (for logging / `needs_review` notes). */
  reasons: string[];
};

/** Tunable thresholds for {@link createVerificationService}. */
export type VerificationPolicy = {
  /** Minimum independent sources required to ACCEPT a value change. Default 2. */
  minSourcesForChange: number;
  /** Minimum independent sources to ACCEPT re-confirming an unchanged value. Default 1. */
  minSourcesForConfirm: number;
  /** Minimum agreement ratio among sources to accept. Default 0.6. */
  minAgreementRatio: number;
};

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  minSourcesForChange: 2,
  minSourcesForConfirm: 1,
  minAgreementRatio: 0.6,
};

/** Count sources from distinct hosts, so 3 pages on one domain count as 1. */
const distinctHostCount = (sources: FactSource[]): number => {
  const hosts = new Set<string>();
  for (const source of sources) {
    try {
      hosts.add(new URL(source.url).hostname.replace(/^www\./, ''));
    } catch {
      if (source.url.trim().length > 0) hosts.add(source.url.trim());
    }
  }
  return hosts.size;
};

/** A normalised comparison so trivial formatting differences are not "changes". */
const normalizeValue = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

/** The verification service. */
export type IVerificationService = {
  verify(candidate: VerificationCandidate): VerificationDecision;
};

/**
 * Create a {@link IVerificationService} from a policy.
 *
 * @param policy Evidence thresholds. Defaults to {@link DEFAULT_VERIFICATION_POLICY}.
 */
export const createVerificationService = (
  policy: VerificationPolicy = DEFAULT_VERIFICATION_POLICY
): IVerificationService => {
  const verify = (candidate: VerificationCandidate): VerificationDecision => {
    const reasons: string[] = [];
    const proposed = candidate.proposedValue.trim();
    const changed = normalizeValue(candidate.currentValue) !== normalizeValue(proposed);

    if (proposed.length === 0) {
      return { action: 'reject', confidence: 0, changed: false, reasons: ['Proposed value is empty.'] };
    }

    const independent = distinctHostCount(candidate.sources);
    if (independent === 0) {
      return {
        action: 'reject',
        confidence: 0,
        changed,
        reasons: ['No sources backing the proposed value (a model guess is not evidence).'],
      };
    }

    const agreementRatio =
      candidate.agreement && candidate.agreement.length > 0
        ? candidate.agreement.filter(Boolean).length / candidate.agreement.length
        : Math.min(1, independent / Math.max(1, candidate.sources.length));

    reasons.push(`${independent} independent source(s); agreement ${(agreementRatio * 100).toFixed(0)}%.`);

    const required = changed ? policy.minSourcesForChange : policy.minSourcesForConfirm;
    const enoughSources = independent >= required;
    const enoughAgreement = agreementRatio >= policy.minAgreementRatio;

    // Confidence blends source breadth (capped at 3) and agreement.
    const breadthScore = Math.min(1, independent / 3);
    const confidence = Number((0.5 * breadthScore + 0.5 * agreementRatio).toFixed(3));

    if (enoughSources && enoughAgreement) {
      reasons.push(changed ? 'Value change is sufficiently corroborated.' : 'Existing value re-confirmed.');
      return { action: 'accept', confidence, changed, reasons };
    }

    if (!enoughSources) {
      reasons.push(`Needs ${required} independent source(s) for a ${changed ? 'change' : 'confirmation'}.`);
    }
    if (!enoughAgreement) {
      reasons.push(`Sources disagree (agreement below ${(policy.minAgreementRatio * 100).toFixed(0)}%).`);
    }
    // A contested change is held for review; weak confirmation just rejects (keep old value).
    return { action: changed ? 'review' : 'reject', confidence, changed, reasons };
  };

  return { verify };
};
