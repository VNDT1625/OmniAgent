/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { detectStale } from '@/process/knowledge/realtime/staleDetector';
import { computeExpiresAt } from '@/process/knowledge/realtime/freshness';

const DAY = 24 * 60 * 60 * 1000;
const validAsOf = '2026-01-01T00:00:00.000Z';
const base = Date.parse(validAsOf);
const ttlMs = 10 * DAY;
const freshFact = { validAsOf, expiresAt: computeExpiresAt(validAsOf, ttlMs), ttlMs, status: 'active' as const };

describe('detectStale', () => {
  it('verifies when the chat contradicts the fact, even if fresh', () => {
    const v = detectStale(freshFact, { contradicted: true }, base + DAY);
    expect(v.shouldVerify).toBe(true);
  });

  it('verifies a fact already flagged needs_review', () => {
    const v = detectStale({ ...freshFact, status: 'needs_review' }, {}, base + DAY);
    expect(v.shouldVerify).toBe(true);
  });

  it('verifies an expired fact', () => {
    const v = detectStale(freshFact, {}, base + 99 * DAY);
    expect(v.shouldVerify).toBe(true);
    expect(v.reason).toMatch(/expired/);
  });

  it('verifies a stale fact only when the user doubts it', () => {
    const at = base + 8 * DAY; // stale window
    expect(detectStale(freshFact, {}, at).shouldVerify).toBe(false);
    expect(detectStale(freshFact, { userDoubt: true }, at).shouldVerify).toBe(true);
  });

  it('does not verify a fresh fact with no doubt signals', () => {
    expect(detectStale(freshFact, {}, base + DAY).shouldVerify).toBe(false);
  });
});
