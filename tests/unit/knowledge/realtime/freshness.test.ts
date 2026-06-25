/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  computeExpiresAt,
  computeFreshness,
  needsRefresh,
  resolveTtlMs,
} from '@/process/knowledge/realtime/freshness';
import { DEFAULT_TTL_BY_CLASS } from '@/process/knowledge/realtime/rtkTypes';

const DAY = 24 * 60 * 60 * 1000;

describe('resolveTtlMs', () => {
  it('uses the class default when no override', () => {
    expect(resolveTtlMs('price')).toBe(DEFAULT_TTL_BY_CLASS.price);
  });

  it('honours a positive override', () => {
    expect(resolveTtlMs('price', 1234)).toBe(1234);
  });

  it('ignores a non-positive or non-finite override', () => {
    expect(resolveTtlMs('version', 0)).toBe(DEFAULT_TTL_BY_CLASS.version);
    expect(resolveTtlMs('version', -5)).toBe(DEFAULT_TTL_BY_CLASS.version);
    expect(resolveTtlMs('version', Number.NaN)).toBe(DEFAULT_TTL_BY_CLASS.version);
  });
});

describe('computeExpiresAt', () => {
  it('adds the ttl to validAsOf', () => {
    const validAsOf = '2026-01-01T00:00:00.000Z';
    expect(computeExpiresAt(validAsOf, DAY)).toBe('2026-01-02T00:00:00.000Z');
  });

  it('expires immediately on an unparseable validAsOf', () => {
    expect(computeExpiresAt('not-a-date', DAY)).toBe(new Date(0).toISOString());
  });
});

describe('computeFreshness', () => {
  const validAsOf = '2026-01-01T00:00:00.000Z';
  const base = Date.parse(validAsOf);
  const ttlMs = 10 * DAY;
  const expiresAt = computeExpiresAt(validAsOf, ttlMs);
  const fact = { validAsOf, expiresAt, ttlMs };

  it('is fresh well within the ttl', () => {
    expect(computeFreshness(fact, base + 1 * DAY)).toBe('fresh');
  });

  it('is stale past the 75% threshold', () => {
    expect(computeFreshness(fact, base + 8 * DAY)).toBe('stale');
  });

  it('is expired at/after expiresAt', () => {
    expect(computeFreshness(fact, base + 10 * DAY)).toBe('expired');
    expect(computeFreshness(fact, base + 11 * DAY)).toBe('expired');
  });

  it('is unknown for bad timestamps', () => {
    expect(computeFreshness({ validAsOf: 'x', expiresAt: 'y', ttlMs }, base)).toBe('unknown');
  });
});

describe('needsRefresh', () => {
  const validAsOf = '2026-01-01T00:00:00.000Z';
  const base = Date.parse(validAsOf);
  const ttlMs = 10 * DAY;
  const fact = { validAsOf, expiresAt: computeExpiresAt(validAsOf, ttlMs), ttlMs };

  it('false while fresh', () => {
    expect(needsRefresh(fact, base + 1 * DAY)).toBe(false);
  });

  it('true once stale or expired', () => {
    expect(needsRefresh(fact, base + 8 * DAY)).toBe(true);
    expect(needsRefresh(fact, base + 99 * DAY)).toBe(true);
  });
});
