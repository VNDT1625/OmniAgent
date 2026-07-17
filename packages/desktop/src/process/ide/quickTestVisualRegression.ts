/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A decoded screenshot with one red, green, blue and alpha byte per pixel. */
export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

/** A rectangular image area excluded from visual comparison. */
export type VisualIgnoreRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
};

export type VisualCaptureMode = 'viewport' | 'full-page' | 'multi-page';

/** Serializable metadata stored beside a Quick Test screenshot. */
export type VisualCheckpoint = {
  id: string;
  name: string;
  screenshotPath: string;
  captureMode: VisualCaptureMode;
  capturedAt: number;
  image: { width: number; height: number };
  viewport: { width: number; height: number; deviceScaleFactor?: number };
  url?: string;
  traceId?: string;
};

export type VisualComparisonOptions = {
  /** Maximum absolute RGBA channel difference (0-255) considered unchanged. */
  pixelThreshold?: number;
  /** Maximum changed-pixel ratio (0-1) that still passes. */
  maxChangedPixelRatio?: number;
  ignoredRegions?: VisualIgnoreRegion[];
};

/** Persistable baseline configuration for one checkpoint. */
export type VisualBaseline = {
  version: 1;
  checkpoint: VisualCheckpoint;
  comparison: Required<Pick<VisualComparisonOptions, 'pixelThreshold' | 'maxChangedPixelRatio'>> & {
    ignoredRegions: VisualIgnoreRegion[];
  };
};

export type VisualChangedBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type VisualComparisonResult = {
  status: 'passed' | 'failed' | 'dimension-mismatch';
  passed: boolean;
  baselineSize: { width: number; height: number };
  actualSize: { width: number; height: number };
  pixelThreshold: number;
  maxChangedPixelRatio: number;
  changedPixels: number;
  comparedPixels: number;
  ignoredPixels: number;
  changedPixelRatio: number;
  changedBounds: VisualChangedBounds | null;
};

const DEFAULT_PIXEL_THRESHOLD = 16;
const DEFAULT_MAX_CHANGED_PIXEL_RATIO = 0.001;

const assertFiniteInteger = (value: number, name: string, allowZero = false): void => {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
};

const validateImage = (image: RgbaImage, name: string): void => {
  assertFiniteInteger(image.width, `${name}.width`);
  assertFiniteInteger(image.height, `${name}.height`);
  const expectedLength = image.width * image.height * 4;
  if (image.data.length !== expectedLength) {
    throw new RangeError(`${name}.data must contain exactly ${expectedLength} RGBA bytes.`);
  }
};

const normalizeOptions = (options: VisualComparisonOptions = {}): VisualBaseline['comparison'] => {
  const pixelThreshold = options.pixelThreshold ?? DEFAULT_PIXEL_THRESHOLD;
  const maxChangedPixelRatio = options.maxChangedPixelRatio ?? DEFAULT_MAX_CHANGED_PIXEL_RATIO;
  if (!Number.isFinite(pixelThreshold) || pixelThreshold < 0 || pixelThreshold > 255) {
    throw new RangeError('pixelThreshold must be between 0 and 255.');
  }
  if (!Number.isFinite(maxChangedPixelRatio) || maxChangedPixelRatio < 0 || maxChangedPixelRatio > 1) {
    throw new RangeError('maxChangedPixelRatio must be between 0 and 1.');
  }
  const ignoredRegions = (options.ignoredRegions ?? []).map((region) => ({
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    label: region.label,
  }));
  for (const region of ignoredRegions) {
    if (
      !Number.isFinite(region.x) ||
      !Number.isFinite(region.y) ||
      !Number.isFinite(region.width) ||
      !Number.isFinite(region.height) ||
      region.width < 0 ||
      region.height < 0
    ) {
      throw new RangeError('Ignored regions must have finite coordinates and non-negative dimensions.');
    }
  }
  return { pixelThreshold, maxChangedPixelRatio, ignoredRegions };
};

const createIgnoreMask = (width: number, height: number, regions: VisualIgnoreRegion[]): Uint8Array => {
  const mask = new Uint8Array(width * height);
  for (const region of regions) {
    const startX = Math.max(0, Math.floor(region.x));
    const startY = Math.max(0, Math.floor(region.y));
    const endX = Math.min(width, Math.ceil(region.x + region.width));
    const endY = Math.min(height, Math.ceil(region.y + region.height));
    for (let y = startY; y < endY; y += 1) {
      mask.fill(1, y * width + startX, y * width + endX);
    }
  }
  return mask;
};

/** Build normalized, serializable metadata for a captured Quick Test checkpoint. */
export const createVisualCheckpoint = (checkpoint: VisualCheckpoint): VisualCheckpoint => {
  if (!checkpoint.id.trim() || !checkpoint.name.trim() || !checkpoint.screenshotPath.trim()) {
    throw new Error('Checkpoint id, name and screenshotPath are required.');
  }
  assertFiniteInteger(checkpoint.capturedAt, 'checkpoint.capturedAt', true);
  assertFiniteInteger(checkpoint.image.width, 'checkpoint.image.width');
  assertFiniteInteger(checkpoint.image.height, 'checkpoint.image.height');
  assertFiniteInteger(checkpoint.viewport.width, 'checkpoint.viewport.width');
  assertFiniteInteger(checkpoint.viewport.height, 'checkpoint.viewport.height');
  if (
    checkpoint.viewport.deviceScaleFactor !== undefined &&
    (!Number.isFinite(checkpoint.viewport.deviceScaleFactor) || checkpoint.viewport.deviceScaleFactor <= 0)
  ) {
    throw new RangeError('checkpoint.viewport.deviceScaleFactor must be greater than zero.');
  }
  return {
    ...checkpoint,
    id: checkpoint.id.trim(),
    name: checkpoint.name.trim(),
    screenshotPath: checkpoint.screenshotPath.trim(),
    image: { ...checkpoint.image },
    viewport: { ...checkpoint.viewport },
  };
};

/** Create the versioned object persisted when a checkpoint becomes a baseline. */
export const createVisualBaseline = (
  checkpoint: VisualCheckpoint,
  options: VisualComparisonOptions = {}
): VisualBaseline => ({
  version: 1,
  checkpoint: createVisualCheckpoint(checkpoint),
  comparison: normalizeOptions(options),
});

/** Compare two decoded screenshots without platform-dependent image processing. */
export const compareRgbaImages = (
  baseline: RgbaImage,
  actual: RgbaImage,
  options: VisualComparisonOptions = {}
): VisualComparisonResult => {
  validateImage(baseline, 'baseline');
  validateImage(actual, 'actual');
  const normalized = normalizeOptions(options);
  const common = {
    baselineSize: { width: baseline.width, height: baseline.height },
    actualSize: { width: actual.width, height: actual.height },
    pixelThreshold: normalized.pixelThreshold,
    maxChangedPixelRatio: normalized.maxChangedPixelRatio,
  };

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      ...common,
      status: 'dimension-mismatch',
      passed: false,
      changedPixels: 0,
      comparedPixels: 0,
      ignoredPixels: 0,
      changedPixelRatio: 1,
      changedBounds: null,
    };
  }

  const mask = createIgnoreMask(baseline.width, baseline.height, normalized.ignoredRegions);
  let changedPixels = 0;
  let ignoredPixels = 0;
  let minX = baseline.width;
  let minY = baseline.height;
  let maxX = -1;
  let maxY = -1;

  for (let pixel = 0; pixel < baseline.width * baseline.height; pixel += 1) {
    if (mask[pixel] === 1) {
      ignoredPixels += 1;
      continue;
    }
    const offset = pixel * 4;
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      if (Math.abs(baseline.data[offset + channel] - actual.data[offset + channel]) > normalized.pixelThreshold) {
        changed = true;
        break;
      }
    }
    if (!changed) continue;
    changedPixels += 1;
    const x = pixel % baseline.width;
    const y = Math.floor(pixel / baseline.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const comparedPixels = baseline.width * baseline.height - ignoredPixels;
  const changedPixelRatio = comparedPixels === 0 ? 0 : changedPixels / comparedPixels;
  const passed = changedPixelRatio <= normalized.maxChangedPixelRatio;
  return {
    ...common,
    status: passed ? 'passed' : 'failed',
    passed,
    changedPixels,
    comparedPixels,
    ignoredPixels,
    changedPixelRatio,
    changedBounds: changedPixels === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
};
