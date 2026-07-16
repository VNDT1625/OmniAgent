/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createStaticProbe, parseGpuInfo } from '@process/system/staticInfoProbe';

describe('parseGpuInfo', () => {
  it('returns an empty list for null / non-object payloads', () => {
    expect(parseGpuInfo(null)).toEqual([]);
    expect(parseGpuInfo(undefined)).toEqual([]);
    expect(parseGpuInfo(42)).toEqual([]);
    expect(parseGpuInfo({})).toEqual([]);
  });

  it('maps known vendor ids to readable names and uses glRenderer for the active device', () => {
    const devices = parseGpuInfo({
      gpuDevice: [
        { active: true, vendorId: 0x10de, deviceId: 0x1234, driverVersion: '555.1' },
        { active: false, vendorId: 0x8086, deviceId: 0x4321 },
      ],
      auxAttributes: { glRenderer: 'NVIDIA GeForce RTX 4070' },
    });
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({
      vendor: 'NVIDIA',
      model: 'NVIDIA GeForce RTX 4070',
      driverVersion: '555.1',
      active: true,
    });
    expect(devices[1].vendor).toBe('Intel');
    expect(devices[1].active).toBe(false);
  });

  it('skips malformed device entries', () => {
    const devices = parseGpuInfo({ gpuDevice: [null, 'bad', { active: false, vendorId: 0x1002, deviceId: 0x1 }] });
    expect(devices).toHaveLength(1);
    expect(devices[0].vendor).toBe('AMD');
  });
});

describe('createStaticProbe', () => {
  it('assembles a static profile from injected reads', async () => {
    const probe = createStaticProbe({
      getGpuInfo: async () => ({
        gpuDevice: [{ active: true, vendorId: 0x106b, deviceId: 0x1 }],
        auxAttributes: { glRenderer: 'Apple M2' },
      }),
      getDiskInfo: async () => ({ totalBytes: 500 * 1024 * 1024, freeBytes: 250 * 1024 * 1024 }),
      getAppVersion: () => '9.9.9',
      diskProbePaths: () => ['/home/test'],
    });

    const info = await probe();

    expect(info.versions.app).toBe('9.9.9');
    expect(info.disks).toHaveLength(1);
    expect(info.disks[0]).toMatchObject({ mount: '/home/test', totalMB: 500, freeMB: 250 });
    expect(info.gpus[0].vendor).toBe('Apple');
    expect(info.cpu.logicalCores).toBeGreaterThan(0);
    expect(info.totalMemoryMB).toBeGreaterThan(0);
    expect(typeof info.os.platform).toBe('string');
    expect(info.probedAt).toBeGreaterThan(0);
  });

  it('degrades disk reads to zero without throwing', async () => {
    const probe = createStaticProbe({
      getGpuInfo: async () => null,
      getDiskInfo: async () => ({ totalBytes: 0, freeBytes: 0 }),
      getAppVersion: () => 'x',
      diskProbePaths: () => ['/nope'],
    });
    const info = await probe();
    expect(info.disks[0]).toMatchObject({ totalMB: 0, freeMB: 0 });
    expect(info.gpus).toEqual([]);
  });
});
