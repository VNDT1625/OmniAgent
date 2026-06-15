/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converter for **text-based PDF → Word (.docx)** (Requirement 2a, criterion
 * 2.5: "PDF chữ thật → Word, giữ chữ + phần lớn định dạng"). Used when the source
 * PDF already contains a real text layer, so its content can be extracted and
 * re-laid into a docx that preserves most of the original formatting.
 *
 * ## Orchestration only
 *
 * This module contains **no** real `pdf-lib` / `mammoth` / `docx` code. The heavy
 * extraction-and-assembly work is injected as a {@link PdfToWordEngine}, so
 * production wiring supplies the real engine while unit tests (Task 8.11) inject
 * a deterministic stub and assert that the heavy call runs under a lease.
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
 * Heavy engine that turns a text-based PDF into a docx. In production this is
 * backed by a worker child-process using `pdf` text extraction + the `docx`
 * writer; here it is an interface so this module only orchestrates.
 *
 * TODO(task 15.x / production): wire the real worker child-process that performs
 * `pdf` text extraction and `docx` assembly; keep this interface as its boundary.
 */
export type PdfToWordEngine = {
  /**
   * Convert a text-based PDF into a docx artifact.
   *
   * @param input The source PDF and optional target path.
   * @returns The produced docx artifact.
   */
  convert(input: ConversionInput): Promise<ConversionArtifact>;
};

/**
 * Public contract of the text-PDF → Word converter. The facade
 * (`conversionService`) depends on this type, not the concrete factory, so the
 * converter can be swapped or faked freely.
 */
export type PdfToWordConverter = {
  /**
   * Convert a text-based PDF to docx, wrapping the heavy engine call in a
   * `docConvert` lease (criterion 2.10).
   */
  convert(input: ConversionInput): Promise<ConversionArtifact>;
};

/** Dependencies and tunables for {@link createPdfToWord}. */
export type PdfToWordDeps = {
  /** Lease gate; the heavy engine call runs only while a lease is held (criterion 2.10). */
  coordinator: LeaseCoordinator;
  /** The injected heavy engine that performs the real extraction + docx assembly. */
  engine: PdfToWordEngine;
  /** Estimated RAM cost (MB) charged while converting. Defaults to {@link DEFAULT_CONVERSION_EST_COST_MB}. */
  estCostMB?: number;
  /** Lease kind for the conversion. Defaults to `'docConvert'`. */
  leaseKind?: TaskKind;
};

/**
 * Create a {@link PdfToWordConverter} from an injected engine + lease coordinator.
 *
 * @param deps Injected collaborators and tunables. See {@link PdfToWordDeps}.
 * @returns A ready-to-use text-PDF → Word converter.
 */
export const createPdfToWord = (deps: PdfToWordDeps): PdfToWordConverter => {
  const { coordinator, engine } = deps;
  const estCostMB = deps.estCostMB ?? DEFAULT_CONVERSION_EST_COST_MB;
  const leaseKind: TaskKind = deps.leaseKind ?? 'docConvert';

  const convert = (input: ConversionInput): Promise<ConversionArtifact> =>
    runUnderLease(coordinator, leaseKind, estCostMB, () => engine.convert(input));

  return { convert };
};
