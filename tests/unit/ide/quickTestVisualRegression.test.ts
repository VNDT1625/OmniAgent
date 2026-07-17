/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  compareRgbaImages,
  createVisualBaseline,
  createVisualCheckpoint,
  type RgbaImage,
  type VisualCheckpoint,
} from '@/process/ide/quickTestVisualRegression';

const image = (width: number, height: number, pixels: number[][]): RgbaImage => ({
  width,
  height,
  data: new Uint8Array(pixels.flat()),
});

const blackPixel = [0, 0, 0, 255];

const checkpoint: VisualCheckpoint = {
  id: ' home ',
  name: ' Home page ',
  screenshotPath: ' artifacts/home.png ',
  captureMode: 'viewport',
  capturedAt: 100,
  image: { width: 1280, height: 720 },
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  url: 'http://localhost:3000/',
};

describe('compareRgbaImages', () => {
  it('passes identical images without a changed bounding box', () => {
    const baseline = image(2, 1, [blackPixel, blackPixel]);
    const result = compareRgbaImages(baseline, baseline);
    expect(result.passed).toBe(true);
    expect(result.changedPixels).toBe(0);
    expect(result.changedBounds).toBeNull();
  });

  it('uses a strict per-channel pixel threshold', () => {
    const baseline = image(1, 1, [blackPixel]);
    const within = image(1, 1, [[16, 0, 0, 255]]);
    const outside = image(1, 1, [[17, 0, 0, 255]]);
    expect(compareRgbaImages(baseline, within, { pixelThreshold: 16 }).changedPixels).toBe(0);
    expect(compareRgbaImages(baseline, outside, { pixelThreshold: 16 }).changedPixels).toBe(1);
  });

  it('reports the smallest bounds containing all changed pixels', () => {
    const baseline = image(
      3,
      2,
      Array.from({ length: 6 }, () => blackPixel)
    );
    const actual = image(3, 2, [blackPixel, [255, 0, 0, 255], blackPixel, blackPixel, blackPixel, [0, 255, 0, 255]]);
    const result = compareRgbaImages(baseline, actual, { pixelThreshold: 0 });
    expect(result.changedPixels).toBe(2);
    expect(result.changedBounds).toEqual({ x: 1, y: 0, width: 2, height: 2 });
  });

  it('clips and combines ignored regions before calculating the changed ratio', () => {
    const baseline = image(3, 1, [blackPixel, blackPixel, blackPixel]);
    const actual = image(3, 1, [[255, 0, 0, 255], [255, 0, 0, 255], blackPixel]);
    const result = compareRgbaImages(baseline, actual, {
      pixelThreshold: 0,
      maxChangedPixelRatio: 0,
      ignoredRegions: [{ x: -1, y: 0, width: 3, height: 1 }],
    });
    expect(result).toMatchObject({ passed: true, changedPixels: 0, comparedPixels: 1, ignoredPixels: 2 });
  });

  it('passes when the changed ratio equals the configured maximum', () => {
    const baseline = image(2, 1, [blackPixel, blackPixel]);
    const actual = image(2, 1, [[255, 255, 255, 255], blackPixel]);
    const result = compareRgbaImages(baseline, actual, { pixelThreshold: 0, maxChangedPixelRatio: 0.5 });
    expect(result.passed).toBe(true);
    expect(result.changedPixelRatio).toBe(0.5);
  });

  it('fails explicitly when screenshot dimensions differ', () => {
    const baseline = image(1, 1, [blackPixel]);
    const actual = image(2, 1, [blackPixel, blackPixel]);
    expect(compareRgbaImages(baseline, actual)).toMatchObject({
      status: 'dimension-mismatch',
      passed: false,
      changedPixelRatio: 1,
    });
  });

  it('rejects malformed RGBA buffers and invalid thresholds', () => {
    const malformed: RgbaImage = { width: 1, height: 1, data: new Uint8Array(3) };
    expect(() => compareRgbaImages(malformed, malformed)).toThrow(/exactly 4 RGBA bytes/);
    const valid = image(1, 1, [blackPixel]);
    expect(() => compareRgbaImages(valid, valid, { pixelThreshold: 256 })).toThrow(/between 0 and 255/);
  });
});

describe('visual checkpoint metadata', () => {
  it('normalizes checkpoint strings without mutating the input', () => {
    const normalized = createVisualCheckpoint(checkpoint);
    expect(normalized).toMatchObject({ id: 'home', name: 'Home page', screenshotPath: 'artifacts/home.png' });
    expect(checkpoint.id).toBe(' home ');
  });

  it('creates a versioned baseline with isolated comparison metadata', () => {
    const ignoredRegions = [{ x: 0, y: 0, width: 10, height: 10, label: 'clock' }];
    const baseline = createVisualBaseline(checkpoint, {
      pixelThreshold: 8,
      maxChangedPixelRatio: 0.02,
      ignoredRegions,
    });
    ignoredRegions[0].width = 99;
    expect(baseline.version).toBe(1);
    expect(baseline.comparison).toEqual({
      pixelThreshold: 8,
      maxChangedPixelRatio: 0.02,
      ignoredRegions: [{ x: 0, y: 0, width: 10, height: 10, label: 'clock' }],
    });
  });

  it('rejects incomplete checkpoint metadata', () => {
    expect(() => createVisualCheckpoint({ ...checkpoint, screenshotPath: ' ' })).toThrow(/required/);
  });
});
