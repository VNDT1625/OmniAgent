/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared low-level primitives for the document-conversion orchestration layer
 * (Requirement 2a — Universal Editor, criteria 2.5 / 2.10). Kept in one place so
 * the three converters (`pdfToWord`, `pdfScanToWord`, `wordToPdf`) and the
 * facade (`conversionService`) reuse the same lease abstraction and IO shapes
 * without duplicating logic or creating a circular dependency on the service.
 *
 * Process boundary: this is a Main-process (Node.js) module — no DOM APIs. It
 * imports **types only** from the ResourceCoordinator so it stays decoupled from
 * the coordinator's concrete implementation.
 */

import type { Lease, LeaseRequest, TaskKind } from '../resource/leaseTypes';

/**
 * Minimal subset of the ResourceCoordinator the conversion layer depends on. The
 * real `IResourceCoordinator` satisfies this structurally, so it can be passed
 * directly; tests inject a lightweight fake.
 */
export type LeaseCoordinator = {
  /** Request a lease for a heavy task; resolves when the budget allows. */
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  /** Release a previously granted lease by id. */
  releaseLease: (id: string) => void;
};

/**
 * A document to convert. `sourcePath` is the file on disk; `targetPath` is the
 * desired output location. When `targetPath` is omitted, the injected engine (or
 * docx assembler) is free to derive one next to the source.
 */
export type ConversionInput = {
  /** Filesystem path of the source document to convert. */
  sourcePath: string;
  /** Desired filesystem path for the produced document. Engine picks one when omitted. */
  targetPath?: string;
};

/**
 * Result of a single converter run. Returned by every converter so the facade
 * can build a uniform {@link import('./conversionService').ConversionResult}.
 */
export type ConversionArtifact = {
  /** Filesystem path of the produced document. */
  outputPath: string;
  /**
   * Whether the output needs human proofreading before it can be trusted. Always
   * `true` for OCR (scanned-PDF) output — criterion 2.5 ("cần người dò lại").
   */
  needsReview: boolean;
  /** Engine-reported quality/confidence in `[0, 1]`, when available. */
  confidence?: number;
  /** Human-readable warnings (e.g. formatting that could not be preserved). */
  warnings?: string[];
};

/**
 * Fallback estimated RAM cost (MB) charged against the budget for a heavy
 * conversion step that does not specify its own override.
 */
export const DEFAULT_CONVERSION_EST_COST_MB = 256;

/**
 * Run one heavy step under a resource lease (criterion 2.10). The lease is
 * requested first and **always** released in `finally`, so the budget is freed
 * even when `work` throws or is cancelled. This is the single chokepoint every
 * converter funnels its heavy engine calls through.
 *
 * @typeParam T The value produced by the heavy step.
 * @param coordinator The lease gate (ResourceCoordinator or a test fake).
 * @param kind        The {@link TaskKind} to lease the step under.
 * @param estCostMB   Estimated RAM cost (MB) charged while the lease is held.
 * @param work        The heavy operation to run while holding the lease.
 * @returns Whatever `work` resolves to.
 */
export const runUnderLease = async <T>(
  coordinator: LeaseCoordinator,
  kind: TaskKind,
  estCostMB: number,
  work: () => Promise<T>
): Promise<T> => {
  const lease = await coordinator.requestLease({ kind, estCostMB });
  try {
    return await work();
  } finally {
    coordinator.releaseLease(lease.id);
  }
};
