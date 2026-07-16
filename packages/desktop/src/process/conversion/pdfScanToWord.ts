/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converter for **scanned PDF → Word (.docx) via OCR** (Requirement 2a,
 * criterion 2.5: "PDF bản quét → Word qua nhận dạng chữ (OCR, cần người dò
 * lại)"). Used when the source PDF has no real text layer (it is a scan/image),
 * so its pages must be run through OCR before a docx can be assembled.
 *
 * ## Two heavy steps, each under its own lease
 *
 * 1. **OCR** the scanned pages → recognised text. Leased under `'ocr'`.
 * 2. **Assemble** the recognised text into a docx. Leased under `'docConvert'`.
 *
 * Both steps go through {@link runUnderLease} (criterion 2.10). The result is
 * **always** flagged `needsReview: true` because OCR output is imperfect and
 * requires human proofreading (criterion 2.5).
 *
 * ## Orchestration only
 *
 * This module contains **no** real tesseract / docx code. The OCR engine and the
 * docx assembler are injected, so production wiring supplies a real OCR worker
 * child-process while unit tests (Task 8.11) inject deterministic stubs and
 * assert the OCR-then-assemble routing and the `needsReview` flag.
 *
 * TODO(task 15.x / production): provide the real OCR worker child-process behind
 * {@link OcrEngine}. The worker requires tesseract (or an external engine) and is
 * intentionally NOT implemented here — only its interface is defined so the
 * orchestration stays fully injected and testable.
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

/** Recognised text for a single scanned page, produced by an {@link OcrEngine}. */
export type OcrPage = {
  /** 1-based page number within the source PDF. */
  pageNumber: number;
  /** Recognised text for the page. */
  text: string;
  /** OCR confidence for the page in `[0, 1]`, when the engine reports it. */
  confidence?: number;
};

/** Full OCR result over a scanned document. */
export type OcrResult = {
  /** Recognised pages, ordered by `pageNumber`. */
  pages: OcrPage[];
};

/**
 * Optical-character-recognition engine. In production this is backed by an OCR
 * worker child-process (tesseract or an external engine); here it is an interface
 * so this module only orchestrates.
 */
export type OcrEngine = {
  /**
   * Recognise text in every page of a scanned PDF.
   *
   * @param sourcePath Filesystem path of the scanned PDF.
   * @returns The recognised pages.
   */
  recognize(sourcePath: string): Promise<OcrResult>;
};

/**
 * Assembles recognised OCR text into a docx artifact. Injected so the converter
 * never embeds a concrete `docx` writer.
 */
export type DocxAssembler = {
  /**
   * Build a docx from recognised OCR pages.
   *
   * @param ocr   The recognised pages to lay into the document.
   * @param input The original conversion request (for the target path).
   * @returns The filesystem path of the produced docx.
   */
  assemble(ocr: OcrResult, input: ConversionInput): Promise<string>;
};

/**
 * Public contract of the scanned-PDF → Word converter. The facade depends on
 * this type so the converter can be swapped or faked freely.
 */
export type PdfScanToWordConverter = {
  /**
   * Convert a scanned PDF to docx via OCR. Runs OCR then assembly, each under a
   * lease, and always flags the result as needing human review (criterion 2.5).
   */
  convert(input: ConversionInput): Promise<ConversionArtifact>;
};

/** Per-step estimated RAM costs (MB) for the scanned-PDF conversion. */
export type PdfScanLeaseCosts = {
  /** Cost charged while OCR runs. */
  ocr?: number;
  /** Cost charged while the docx is assembled. */
  assemble?: number;
};

/** The {@link TaskKind} each heavy step is leased under. */
export type PdfScanLeaseKinds = {
  /** Lease kind for OCR. Defaults to `'ocr'`. */
  ocr?: TaskKind;
  /** Lease kind for docx assembly. Defaults to `'docConvert'`. */
  assemble?: TaskKind;
};

/** Dependencies and tunables for {@link createPdfScanToWord}. */
export type PdfScanToWordDeps = {
  /** Lease gate; both heavy steps run only while a lease is held (criterion 2.10). */
  coordinator: LeaseCoordinator;
  /** The injected OCR engine (real worker in production). */
  ocrEngine: OcrEngine;
  /** The injected docx assembler that lays recognised text into a document. */
  assembler: DocxAssembler;
  /** Per-step estimated memory costs (MB). */
  estCostMB?: PdfScanLeaseCosts;
  /** Per-step lease kinds. */
  leaseKinds?: PdfScanLeaseKinds;
};

/** Default lease kinds per step: OCR under `'ocr'`, assembly under `'docConvert'`. */
const DEFAULT_LEASE_KINDS: Required<PdfScanLeaseKinds> = {
  ocr: 'ocr',
  assemble: 'docConvert',
};

/**
 * Average OCR page confidence in `[0, 1]`, or `undefined` when no page reported
 * one. Used to surface an overall confidence on the artifact.
 */
const averageConfidence = (pages: OcrPage[]): number | undefined => {
  const scored = pages.filter((page): page is OcrPage & { confidence: number } => typeof page.confidence === 'number');
  if (scored.length === 0) return undefined;
  return scored.reduce((sum, page) => sum + page.confidence, 0) / scored.length;
};

/**
 * Create a {@link PdfScanToWordConverter} from an injected OCR engine, docx
 * assembler, and lease coordinator.
 *
 * @param deps Injected collaborators and tunables. See {@link PdfScanToWordDeps}.
 * @returns A ready-to-use scanned-PDF → Word converter.
 */
export const createPdfScanToWord = (deps: PdfScanToWordDeps): PdfScanToWordConverter => {
  const { coordinator, ocrEngine, assembler } = deps;
  const leaseKinds: Required<PdfScanLeaseKinds> = { ...DEFAULT_LEASE_KINDS, ...deps.leaseKinds };
  const costs = deps.estCostMB ?? {};
  const costOf = (step: keyof PdfScanLeaseCosts): number => costs[step] ?? DEFAULT_CONVERSION_EST_COST_MB;

  const convert = async (input: ConversionInput): Promise<ConversionArtifact> => {
    // Step 1 — OCR the scanned pages (heavy; leased under 'ocr').
    const ocr = await runUnderLease(coordinator, leaseKinds.ocr, costOf('ocr'), () =>
      ocrEngine.recognize(input.sourcePath)
    );
    // Step 2 — assemble the recognised text into a docx (heavy; leased under 'docConvert').
    const outputPath = await runUnderLease(coordinator, leaseKinds.assemble, costOf('assemble'), () =>
      assembler.assemble(ocr, input)
    );
    return {
      outputPath,
      // OCR output is never trusted blindly — always needs human proofreading (criterion 2.5).
      needsReview: true,
      confidence: averageConfidence(ocr.pages),
      warnings: ['OCR output may contain recognition errors; please proofread before use.'],
    };
  };

  return { convert };
};
