/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import type {
  AnalyzeVisualArtifactOptions,
  VisualArtifact,
  VisualArtifactBox,
  VisualArtifactColor,
  VisualArtifactRegion,
  VisualArtifactTextBlock,
} from './types';

const PALETTE_SIZE = 6;
const SAMPLE_SIZE = 96;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

export const createVisualBox = (
  x: number,
  y: number,
  width: number,
  height: number,
  imageWidth: number,
  imageHeight: number
): VisualArtifactBox => ({
  x,
  y,
  width,
  height,
  normalized: {
    x: clamp01(imageWidth > 0 ? x / imageWidth : 0),
    y: clamp01(imageHeight > 0 ? y / imageHeight : 0),
    width: clamp01(imageWidth > 0 ? width / imageWidth : 0),
    height: clamp01(imageHeight > 0 ? height / imageHeight : 0),
  },
});

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;

const colorBucket = (r: number, g: number, b: number): string => {
  const bucket = (value: number): number => Math.max(0, Math.min(255, Math.round(value / 32) * 32));
  return `${bucket(r)},${bucket(g)},${bucket(b)}`;
};

const extractPalette = async (imagePath: string): Promise<VisualArtifactColor[]> => {
  const { data, info } = await sharp(imagePath)
    .resize({ width: SAMPLE_SIZE, height: SAMPLE_SIZE, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const counts = new Map<string, { rgb: [number, number, number]; count: number }>();
  for (let index = 0; index + 2 < data.length; index += info.channels) {
    const r = data[index] ?? 0;
    const g = data[index + 1] ?? 0;
    const b = data[index + 2] ?? 0;
    const key = colorBucket(r, g, b);
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { rgb: [r, g, b], count: 1 });
    }
  }
  const total = Math.max(1, Math.floor(data.length / info.channels));
  return [...counts.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, PALETTE_SIZE)
    .map((item) => ({
      hex: toHex(...item.rgb),
      rgb: item.rgb,
      coverage: Number((item.count / total).toFixed(4)),
    }));
};

const inferLayoutRegions = (width: number, height: number): VisualArtifactRegion[] => {
  const regions: VisualArtifactRegion[] = [
    {
      id: 'canvas',
      role: 'canvas',
      label: 'Full image canvas',
      box: createVisualBox(0, 0, width, height, width, height),
      confidence: 1,
      source: 'geometry',
    },
  ];
  if (height >= 240) {
    regions.push({
      id: 'top-band',
      role: 'header',
      label: 'Top band candidate',
      box: createVisualBox(0, 0, width, Math.round(height * 0.16), width, height),
      confidence: 0.34,
      source: 'geometry',
    });
  }
  if (width >= 640) {
    regions.push({
      id: 'left-band',
      role: 'sidebar',
      label: 'Left sidebar candidate',
      box: createVisualBox(0, 0, Math.round(width * 0.22), height, width, height),
      confidence: 0.28,
      source: 'geometry',
    });
  }
  regions.push({
    id: 'content-area',
    role: 'content',
    label: 'Main content candidate',
    box: createVisualBox(
      width >= 640 ? Math.round(width * 0.22) : 0,
      height >= 240 ? Math.round(height * 0.16) : 0,
      width >= 640 ? Math.round(width * 0.78) : width,
      height >= 240 ? Math.round(height * 0.84) : height,
      width,
      height
    ),
    confidence: 0.3,
    source: 'geometry',
  });
  return regions;
};

const hashBuffer = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

export const analyzeVisualArtifact = async (
  imagePath: string,
  options: AnalyzeVisualArtifactOptions = {}
): Promise<VisualArtifact> => {
  const [metadata, fileStat, bytes] = await Promise.all([
    sharp(imagePath).metadata(),
    stat(imagePath),
    readFile(imagePath),
  ]);
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) throw new Error('Image dimensions could not be read.');
  const palette = await extractPalette(imagePath);
  const textBlocks = options.textAnalyzer
    ? await options.textAnalyzer({ imagePath, width, height })
    : ([] as VisualArtifactTextBlock[]);
  return {
    schemaVersion: 1,
    source: {
      path: imagePath,
      mimeType: options.mimeType,
      byteSize: fileStat.size,
      hash: hashBuffer(bytes),
    },
    image: {
      width,
      height,
      channels: metadata.channels,
      format: metadata.format,
      hasAlpha: metadata.hasAlpha,
    },
    coordinateSystem: {
      kind: 'pixel-and-normalized',
      origin: 'top-left',
      units: 'px',
      normalizedRange: [0, 1],
    },
    colors: {
      dominant: palette[0],
      palette,
    },
    regions: inferLayoutRegions(width, height),
    textBlocks,
    notes:
      textBlocks.length > 0
        ? []
        : ['No OCR engine is configured, so this artifact contains visual metadata and layout hints only.'],
    provenance: {
      analyzer: 'visualArtifact.sharp.v1',
      generatedAt: (options.generatedAt ?? new Date()).toISOString(),
      capabilities: ['metadata', 'palette', 'geometry-layout', ...(options.textAnalyzer ? ['text-analyzer'] : [])],
      limitations: options.textAnalyzer ? [] : ['ocr-unavailable', 'object-detection-unavailable'],
    },
  };
};

const renderBox = (box: VisualArtifactBox): string => {
  const normalized = [
    box.normalized.x.toFixed(3),
    box.normalized.y.toFixed(3),
    box.normalized.width.toFixed(3),
    box.normalized.height.toFixed(3),
  ].join(', ');
  return `x=${box.x}, y=${box.y}, w=${box.width}, h=${box.height}; n=(${normalized})`;
};

export const renderVisualArtifactSemanticText = (artifact: VisualArtifact): string => {
  const lines = [
    `Image: ${artifact.image.width}x${artifact.image.height}, format=${artifact.image.format ?? 'unknown'}, alpha=${artifact.image.hasAlpha === true ? 'yes' : 'no'}`,
    `Coordinate system: origin=${artifact.coordinateSystem.origin}, pixels plus normalized 0..1 boxes.`,
  ];
  if (artifact.colors.palette.length > 0) {
    lines.push(
      `Palette: ${artifact.colors.palette.map((color) => `${color.hex} ${(color.coverage * 100).toFixed(1)}%`).join(', ')}`
    );
  }
  lines.push('Regions:');
  for (const region of artifact.regions) {
    lines.push(
      `- ${region.id} [${region.role}] ${region.label}; ${renderBox(region.box)}; confidence=${region.confidence}`
    );
  }
  lines.push('Text blocks:');
  if (artifact.textBlocks.length === 0) lines.push('- none detected');
  for (const block of artifact.textBlocks) {
    lines.push(
      `- ${block.id}: ${JSON.stringify(block.text)}${block.box ? `; ${renderBox(block.box)}` : ''}; confidence=${block.confidence}; source=${block.source}`
    );
  }
  for (const note of artifact.notes) lines.push(`Note: ${note}`);
  return lines.join('\n');
};

export const renderVisualArtifactMockUi = (artifact: VisualArtifact): string => {
  const lines = ['[image]'];
  for (const region of artifact.regions) {
    lines.push(`  [region id="${region.id}" role="${region.role}" box="${renderBox(region.box)}"]`);
  }
  for (const text of artifact.textBlocks) {
    lines.push(`  [text id="${text.id}"${text.box ? ` box="${renderBox(text.box)}"` : ''}] ${text.text}`);
  }
  if (artifact.colors.dominant) lines.push(`  [dominant-color] ${artifact.colors.dominant.hex}`);
  lines.push('[/image]');
  return lines.join('\n');
};
