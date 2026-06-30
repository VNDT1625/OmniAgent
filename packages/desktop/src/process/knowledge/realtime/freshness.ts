/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PURE freshness math for Realtime Knowledge facts.
 *
 * Given a fact's `validAsOf` and TTL, these helpers derive when it expires and
 * whether — relative to an injected "now" — it is still `fresh`, getting `stale`
 * (past {@link STALE_THRESHOLD_RATIO} of its TTL), or `expired`. The clock is a
 * parameter so the logic is deterministic and unit-testable.
 *
 * No I/O, no Node/DOM APIs.
 */

import {
  DEFAULT_TTL_BY_CLASS,
  STALE_THRESHOLD_RATIO,
  type Freshness,
  type KnowledgeFact,
  type VolatilityClass,
} from './rtkTypes';

/** Resolve the TTL for a volatility class, honouring an explicit override. */
export const resolveTtlMs = (volatilityClass: VolatilityClass, override?: number): number => {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  return DEFAULT_TTL_BY_CLASS[volatilityClass] ?? DEFAULT_TTL_BY_CLASS.other;
};

/** Parse an ISO timestamp to epoch ms, or `null` when invalid. */
const parseTime = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** Compute the ISO `expiresAt` from a `validAsOf` timestamp and a TTL. */
export const computeExpiresAt = (validAsOf: string, ttlMs: number): string => {
  const base = parseTime(validAsOf);
  const safeTtl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_TTL_BY_CLASS.other;
  if (base === null) {
    // Unknown base — expire immediately so it gets refreshed.
    return new Date(0).toISOString();
  }
  return new Date(base + safeTtl).toISOString();
};

/**
 * Derive a fact's freshness relative to `now`.
 *
 * - `unknown` when timestamps are unparseable.
 * - `expired` once `now >= expiresAt`.
 * - `stale` once elapsed time exceeds {@link STALE_THRESHOLD_RATIO} of the TTL.
 * - `fresh` otherwise.
 */
export const computeFreshness = (
  fact: Pick<KnowledgeFact, 'validAsOf' | 'expiresAt' | 'ttlMs'>,
  now: number
): Freshness => {
  const validAsOf = parseTime(fact.validAsOf);
  const expiresAt = parseTime(fact.expiresAt);
  if (validAsOf === null || expiresAt === null) {
    return 'unknown';
  }
  if (now >= expiresAt) {
    return 'expired';
  }
  const ttl = fact.ttlMs > 0 ? fact.ttlMs : expiresAt - validAsOf;
  if (ttl <= 0) {
    return 'expired';
  }
  const elapsedRatio = (now - validAsOf) / ttl;
  return elapsedRatio >= STALE_THRESHOLD_RATIO ? 'stale' : 'fresh';
};

/** Whether a fact should be considered for a refresh (stale or expired). */
export const needsRefresh = (fact: Pick<KnowledgeFact, 'validAsOf' | 'expiresAt' | 'ttlMs'>, now: number): boolean => {
  const freshness = computeFreshness(fact, now);
  return freshness === 'stale' || freshness === 'expired' || freshness === 'unknown';
};
