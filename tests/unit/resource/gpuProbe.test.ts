/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the discrete-GPU classification heuristic
 * (`hasDiscreteGpuFromDevices`). Pure function — no Electron, no real GPU.
 *
 * Vendor ids: NVIDIA 0x10DE, Intel 0x8086, AMD 0x1002.
 */

import { describe, expect, it } from 'vitest';
import { hasDiscreteGpuFromDevices } from '@/process/resource/gpuProbe';

const NVIDIA = 0x10de;
const INTEL = 0x8086;
const AMD = 0x1002;

describe('hasDiscreteGpuFromDevices', () => {
  it('returns false for no devices', () => {
    expect(hasDiscreteGpuFromDevices([])).toBe(false);
  });

  it('returns false for an Intel-only integrated GPU', () => {
    expect(hasDiscreteGpuFromDevices([{ vendorId: INTEL }])).toBe(false);
  });

  it('treats any NVIDIA device as discrete', () => {
    expect(hasDiscreteGpuFromDevices([{ vendorId: NVIDIA }])).toBe(true);
  });

  it('detects discrete when an Intel iGPU sits next to another vendor', () => {
    expect(hasDiscreteGpuFromDevices([{ vendorId: INTEL }, { vendorId: NVIDIA }])).toBe(true);
    expect(hasDiscreteGpuFromDevices([{ vendorId: INTEL }, { vendorId: AMD }])).toBe(true);
  });

  it('detects discrete when two distinct vendors are present', () => {
    expect(hasDiscreteGpuFromDevices([{ vendorId: AMD }, { vendorId: NVIDIA }])).toBe(true);
  });

  it('treats a lone AMD GPU as integrated (APU) — conservative', () => {
    expect(hasDiscreteGpuFromDevices([{ vendorId: AMD }])).toBe(false);
  });

  it('ignores devices with missing / zero vendor ids', () => {
    expect(hasDiscreteGpuFromDevices([{ vendorId: 0 }, { deviceId: 123 }])).toBe(false);
    // A real vendor mixed with junk entries still classifies on the real one.
    expect(hasDiscreteGpuFromDevices([{ vendorId: 0 }, { vendorId: NVIDIA }])).toBe(true);
  });

  it('does not flag duplicate entries of the same single vendor as discrete', () => {
    expect(hasDiscreteGpuFromDevices([{ vendorId: INTEL }, { vendorId: INTEL }])).toBe(false);
  });
});
