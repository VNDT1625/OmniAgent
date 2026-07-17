/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  analyzeVisualArtifact,
  createVisualBox,
  renderVisualArtifactMockUi,
  renderVisualArtifactSemanticText,
} from '../../../packages/desktop/src/process/visualArtifact';

describe('visual artifact analyzer', () => {
  it('extracts image metadata, palette, layout hints, and prompt projections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'visual-artifact-'));
    const imagePath = join(dir, 'sample.png');
    try {
      await sharp({
        create: {
          width: 320,
          height: 180,
          channels: 4,
          background: { r: 24, g: 80, b: 160, alpha: 1 },
        },
      })
        .png()
        .toFile(imagePath);

      const artifact = await analyzeVisualArtifact(imagePath, {
        mimeType: 'image/png',
        generatedAt: new Date('2026-01-02T03:04:05.000Z'),
      });

      expect(artifact.schemaVersion).toBe(1);
      expect(artifact.image).toMatchObject({ width: 320, height: 180, format: 'png' });
      expect(artifact.coordinateSystem.origin).toBe('top-left');
      expect(artifact.colors.palette.length).toBeGreaterThan(0);
      expect(artifact.regions.map((region) => region.id)).toContain('canvas');
      expect(artifact.textBlocks).toEqual([]);
      expect(artifact.provenance.limitations).toContain('ocr-unavailable');
      expect(renderVisualArtifactSemanticText(artifact)).toContain('Image: 320x180');
      expect(renderVisualArtifactMockUi(artifact)).toContain('[dominant-color]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses an injected text analyzer without pretending OCR exists by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'visual-artifact-'));
    const imagePath = join(dir, 'text.png');
    try {
      await sharp({
        create: {
          width: 100,
          height: 50,
          channels: 3,
          background: { r: 255, g: 255, b: 255 },
        },
      })
        .jpeg()
        .toFile(imagePath);

      const artifact = await analyzeVisualArtifact(imagePath, {
        textAnalyzer: async ({ width, height }) => [
          {
            id: 'ocr-1',
            text: 'Hello',
            box: createVisualBox(10, 5, 40, 12, width, height),
            confidence: 0.9,
            source: 'test-ocr',
          },
        ],
      });

      expect(artifact.textBlocks[0]?.text).toBe('Hello');
      expect(artifact.notes).toEqual([]);
      expect(artifact.provenance.capabilities).toContain('text-analyzer');
      expect(renderVisualArtifactSemanticText(artifact)).toContain('"Hello"');
      expect(renderVisualArtifactMockUi(artifact)).toContain('[text id="ocr-1"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

