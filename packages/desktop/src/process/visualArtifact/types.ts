/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

export type VisualArtifactCoordinateSystem = {
  kind: 'pixel-and-normalized';
  origin: 'top-left';
  units: 'px';
  normalizedRange: [0, 1];
};

export type VisualArtifactBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  normalized: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type VisualArtifactColor = {
  hex: string;
  rgb: [number, number, number];
  coverage: number;
};

export type VisualArtifactTextBlock = {
  id: string;
  text: string;
  box?: VisualArtifactBox;
  confidence: number;
  source: string;
};

export type VisualArtifactRegion = {
  id: string;
  role: 'canvas' | 'header' | 'footer' | 'sidebar' | 'content' | 'unknown';
  label: string;
  box: VisualArtifactBox;
  confidence: number;
  source: string;
  children?: VisualArtifactRegion[];
};

export type VisualArtifact = {
  schemaVersion: 1;
  source: {
    path?: string;
    mimeType?: string;
    byteSize?: number;
    hash?: string;
  };
  image: {
    width: number;
    height: number;
    channels?: number;
    format?: string;
    hasAlpha?: boolean;
  };
  coordinateSystem: VisualArtifactCoordinateSystem;
  colors: {
    dominant?: VisualArtifactColor;
    palette: VisualArtifactColor[];
  };
  regions: VisualArtifactRegion[];
  textBlocks: VisualArtifactTextBlock[];
  notes: string[];
  provenance: {
    analyzer: string;
    generatedAt: string;
    capabilities: string[];
    limitations: string[];
  };
};

export type VisualArtifactTextAnalyzerInput = {
  imagePath: string;
  width: number;
  height: number;
};

export type VisualArtifactTextAnalyzer = (
  input: VisualArtifactTextAnalyzerInput
) => Promise<VisualArtifactTextBlock[]>;

export type AnalyzeVisualArtifactOptions = {
  mimeType?: string;
  textAnalyzer?: VisualArtifactTextAnalyzer;
  generatedAt?: Date;
};

