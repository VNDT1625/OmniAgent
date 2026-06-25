/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for `suggestPreset` (Tier A preset suggestion, criterion 5.3),
 * focused on the new "high-end without a discrete GPU" path and the existing
 * saver/balanced/performance boundaries. Pure function — no machine probe.
 */

import { describe, expect, it } from 'vitest';
import { suggestPreset } from '@/process/resource/balancePolicy';
import type { MachineProfile } from '@/process/resource/leaseTypes';

const machine = (over: Partial<MachineProfile>): MachineProfile => ({
  totalMemMB: 16 * 1024,
  cpuCores: 8,
  hasDiscreteGPU: false,
  freeDiskMB: 100 * 1024,
  ...over,
});

describe('suggestPreset', () => {
  it('suggests saver on low RAM', () => {
    expect(suggestPreset(machine({ totalMemMB: 6 * 1024 }))).toBe('saver');
  });

  it('suggests saver on few cores', () => {
    expect(suggestPreset(machine({ cpuCores: 2 }))).toBe('saver');
  });

  it('suggests performance for high RAM + many cores + discrete GPU', () => {
    expect(suggestPreset(machine({ totalMemMB: 16 * 1024, cpuCores: 8, hasDiscreteGPU: true }))).toBe('performance');
  });

  it('suggests balanced for a mid machine with only an integrated GPU', () => {
    expect(suggestPreset(machine({ totalMemMB: 16 * 1024, cpuCores: 8, hasDiscreteGPU: false }))).toBe('balanced');
  });

  it('suggests performance for a very high-end machine even without a discrete GPU', () => {
    // 32GB + 12 cores, integrated GPU only → should NOT be held back to balanced.
    expect(suggestPreset(machine({ totalMemMB: 32 * 1024, cpuCores: 16, hasDiscreteGPU: false }))).toBe('performance');
  });

  it('stays balanced just below the no-GPU performance thresholds', () => {
    expect(suggestPreset(machine({ totalMemMB: 32 * 1024, cpuCores: 10, hasDiscreteGPU: false }))).toBe('balanced');
    expect(suggestPreset(machine({ totalMemMB: 24 * 1024, cpuCores: 16, hasDiscreteGPU: false }))).toBe('balanced');
  });
});
