/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converter for **Word (.docx) → PDF** (Requirement 2a, criterion 2.5: "Word →
 * PDF, giữ bố cục tốt"). Used to render an edited docx back to a layout-faithful
 * PDF.
 *
 * ## Orchestration only
 *
 * This module contains **no** real `docx` / `pdf-lib` rendering code. The heavy
 * rendering work is injected as a {@link WordToPdfEngine}, so production wiring
 * supplies the real engine (worker child-process) while unit tests (Task 8.11)
 * inject a deterministic stub and assert the heavy call runs under a lease.
 *
 * TODO(task 15.x / production): wire the real worker child-process that renders
 * docx → PDF; keep {@link WordToPdfEngine} as its boundary.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { TaskKind } from '../resource/leaseTypes';
import {
  DEFAULT_CONVERSION_EST_COST_MB,
  runUnderLease,
  type ConversionArtifact,
  type ConversionInput,
  type LeaseCoordinator,
} from './conversionTypes';

/**
 * Heavy engine that renders a docx into a layout-faithful PDF. In production this
 * is backed by a worker child-process; here it is an interface so this module
 * only orchestrates.
 */
export type WordToPdfEngine = {
  /**
   * Convert a docx into a PDF artifact.
   *
   * @param input The source docx and optional target path.
   * @returns The produced PDF artifact.
   */
  convert(input: ConversionInput): Promise<ConversionArtifact>;
};

/**
 * Public contract of the Word → PDF converter. The facade depends on this type,
 * not the concrete factory, so the converter can be swapped or faked freely.
 */
export type WordToPdfConverter = {
  /**
   * Convert a docx to PDF, wrapping the heavy engine call in a `docConvert`
   * lease (criterion 2.10).
   */
  convert(input: ConversionInput): Promise<ConversionArtifact>;
};

/** Dependencies and tunables for {@link createWordToPdf}. */
export type WordToPdfDeps = {
  /** Lease gate; the heavy engine call runs only while a lease is held (criterion 2.10). */
  coordinator: LeaseCoordinator;
  /** The injected heavy engine that performs the real docx → PDF rendering. */
  engine: WordToPdfEngine;
  /** Estimated RAM cost (MB) charged while converting. Defaults to {@link DEFAULT_CONVERSION_EST_COST_MB}. */
  estCostMB?: number;
  /** Lease kind for the conversion. Defaults to `'docConvert'`. */
  leaseKind?: TaskKind;
};

/**
 * Create a {@link WordToPdfConverter} from an injected engine + lease coordinator.
 *
 * @param deps Injected collaborators and tunables. See {@link WordToPdfDeps}.
 * @returns A ready-to-use Word → PDF converter.
 */
export const createWordToPdf = (deps: WordToPdfDeps): WordToPdfConverter => {
  const { coordinator, engine } = deps;
  const estCostMB = deps.estCostMB ?? DEFAULT_CONVERSION_EST_COST_MB;
  const leaseKind: TaskKind = deps.leaseKind ?? 'docConvert';

  const convert = (input: ConversionInput): Promise<ConversionArtifact> =>
    runUnderLease(coordinator, leaseKind, estCostMB, () => engine.convert(input));

  return { convert };
};
