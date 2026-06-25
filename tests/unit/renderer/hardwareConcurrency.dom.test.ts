/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the renderer hardware-aware concurrency helpers. Runs under the
 * jsdom project so `navigator.hardwareConcurrency` exists and can be stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLogicalCoreCount, recommendedConcurrency } from '@/renderer/utils/hardwareConcurrency';

/** Override `navigator.hardwareConcurrency` for one test. */
const stubCores = (value: number | undefined): void => {
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    configurable: true,
    get: () => value,
  });
};

afterEach(() => {
  vi.restoreAllMocks();
  stubCores(4);
});

describe('getLogicalCoreCount', () => {
  it('reads navigator.hardwareConcurrency', () => {
    stubCores(12);
    expect(getLogicalCoreCount()).toBe(12);
  });

  it('falls back to 4 when the value is missing or nonsensical', () => {
    stubCores(undefined);
    expect(getLogicalCoreCount()).toBe(4);
    stubCores(0);
    expect(getLogicalCoreCount()).toBe(4);
  });
});

describe('recommendedConcurrency', () => {
  it('scales with cores using the default half-of-cores fraction', () => {
    stubCores(4);
    expect(recommendedConcurrency()).toBe(2);
    stubCores(16);
    expect(recommendedConcurrency()).toBe(8); // capped at default max 8
  });

  it('honours min/max clamps', () => {
    stubCores(2);
    expect(recommendedConcurrency({ min: 2 })).toBe(2); // floor(1) → clamped up to 2
    stubCores(64);
    expect(recommendedConcurrency({ max: 6 })).toBe(6);
  });

  it('respects a custom fraction', () => {
    stubCores(8);
    expect(recommendedConcurrency({ fraction: 0.75, max: 8 })).toBe(6);
    expect(recommendedConcurrency({ fraction: 1, max: 16 })).toBe(8);
  });

  it('never returns below 1', () => {
    stubCores(1);
    expect(recommendedConcurrency({ fraction: 0.1 })).toBe(1);
  });
});
