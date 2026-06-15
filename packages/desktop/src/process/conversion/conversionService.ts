/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Facade / router for document conversion (Requirement 2a — Universal Editor,
 * criteria 2.5 / 2.10). It is the single place that decides *which* converter a
 * {@link ConversionRequest} maps onto and tracks each request as a
 * {@link ConversionJob} through its lifecycle, mirroring `mediaPipeline`'s
 * `MediaJob` so the routing unit test (Task 8.11) can assert both the branching
 * and the state transitions.
 *
 * Routing (see {@link decideConversionKind}):
 * - **Word source** → `word-to-pdf` (docx → layout-faithful PDF).
 * - **PDF source, text layer** → `pdf-to-word` (keeps text + most formatting).
 * - **PDF source, scanned** → `pdf-scan-to-word` (OCR → docx, needs review).
 *
 * ## Orchestration only
 *
 * This module owns no heavy code: the three converters and the lease coordinator
 * are injected. Each converter already wraps its heavy steps in
 * `requestLease`/`releaseLease` (criterion 2.10); the facade just routes and
 * records job state. Tests (Task 8.11) inject stub converters and assert routing.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { ConversionArtifact, ConversionInput, LeaseCoordinator } from './conversionTypes';
import type { PdfScanToWordConverter } from './pdfScanToWord';
import type { PdfToWordConverter } from './pdfToWord';
import type { WordToPdfConverter } from './wordToPdf';

// Re-export the converter contracts and shared IO types so consumers can import
// the whole conversion surface from this facade module.
export type { ConversionArtifact, ConversionInput, LeaseCoordinator } from './conversionTypes';
export type { OcrEngine, OcrPage, OcrResult, DocxAssembler, PdfScanToWordConverter } from './pdfScanToWord';
export type { PdfToWordEngine, PdfToWordConverter } from './pdfToWord';
export type { WordToPdfEngine, WordToPdfConverter } from './wordToPdf';

// ---------------------------------------------------------------------------
// Public data models
// ---------------------------------------------------------------------------

/** The document format of a conversion source. */
export type SourceFormat = 'pdf' | 'word';

/**
 * Which conversion pipeline a request maps onto.
 * - `pdf-to-word`      — text-based PDF → docx (keeps text + most formatting).
 * - `pdf-scan-to-word` — scanned PDF → docx via OCR (needs human review).
 * - `word-to-pdf`      — docx → layout-faithful PDF.
 */
export type ConversionKind = 'pdf-to-word' | 'pdf-scan-to-word' | 'word-to-pdf';

/**
 * A request to convert one document. The facade decides the {@link ConversionKind}
 * from `sourceFormat` + `isScanned` (see {@link decideConversionKind}) unless an
 * explicit `kind` is provided, which then takes precedence.
 */
export type ConversionRequest = {
  /** Filesystem path of the source document. */
  sourcePath: string;
  /** Desired filesystem path for the produced document. Converter picks one when omitted. */
  targetPath?: string;
  /** Format of the source document, used to route the request. */
  sourceFormat: SourceFormat;
  /**
   * Whether a PDF source is a scan/image (no real text layer). Only meaningful
   * when `sourceFormat === 'pdf'`; ignored for Word sources.
   */
  isScanned?: boolean;
  /** Explicit conversion kind. When set, overrides automatic routing. */
  kind?: ConversionKind;
};

/**
 * Lifecycle state of a {@link ConversionJob}.
 * - `queued`  — created, waiting for its converter to acquire a lease.
 * - `running` — the converter is in flight.
 * - `done`    — completed successfully.
 * - `failed`  — the converter threw; see {@link ConversionJob.error}.
 */
export type ConversionJobStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * A unit of conversion work tracked through its lifecycle. Exposed (via
 * {@link IConversionService.getJob}/{@link IConversionService.listJobs}) so the
 * routing unit test (Task 8.11) can assert branching and state transitions.
 */
export type ConversionJob = {
  /** Unique identifier for the job. */
  id: string;
  /** Which conversion pipeline this job runs. */
  kind: ConversionKind;
  /** Current lifecycle state. */
  status: ConversionJobStatus;
  /** Filesystem path of the source document. */
  sourcePath: string;
  /** Unix-ms timestamp when the job was created. */
  createdAt: number;
  /** Unix-ms timestamp of the most recent state change. */
  updatedAt: number;
  /** Filesystem path of the produced document, set when the job succeeds. */
  outputPath?: string;
  /** Human-readable failure message when `status === 'failed'`. */
  error?: string;
};

/** Result of a successful {@link IConversionService.convert} call. */
export type ConversionResult = {
  /** The job that produced this result. */
  jobId: string;
  /** Which conversion pipeline ran. */
  kind: ConversionKind;
  /** Filesystem path of the produced document. */
  outputPath: string;
  /** Whether the output needs human proofreading (always `true` for OCR — criterion 2.5). */
  needsReview: boolean;
  /** Engine-reported quality/confidence in `[0, 1]`, when available. */
  confidence?: number;
  /** Human-readable warnings (e.g. formatting that could not be preserved). */
  warnings?: string[];
};

/**
 * Public contract of the conversion service. Implementations route a
 * {@link ConversionRequest} to the right converter and track progress as
 * {@link ConversionJob}s.
 */
export type IConversionService = {
  /** Convert a document, routing by kind and recording a {@link ConversionJob}. */
  convert(request: ConversionRequest): Promise<ConversionResult>;
  /** Look up a job by id (for progress UIs and tests). */
  getJob(jobId: string): ConversionJob | undefined;
  /** Snapshot of all jobs created by this service, oldest first. */
  listJobs(): ConversionJob[];
};

/** Dependencies and tunables for {@link createConversionService}. */
export type ConversionServiceDeps = {
  /** Lease gate, passed through to the converters that gate their heavy steps. */
  coordinator: LeaseCoordinator;
  /** Converter for text-based PDF → Word. */
  pdfToWord: PdfToWordConverter;
  /** Converter for scanned PDF → Word (via OCR). */
  pdfScanToWord: PdfScanToWordConverter;
  /** Converter for Word → PDF. */
  wordToPdf: WordToPdfConverter;
  /** Unique job-id generator. Defaults to a monotonic counter (`conversion-<n>`). */
  generateId?: () => string;
  /** Wall-clock source (Unix ms). Defaults to `Date.now`. */
  now?: () => number;
};

// ---------------------------------------------------------------------------
// Routing decision (pure, exported for unit testing)
// ---------------------------------------------------------------------------

/** Inputs needed to decide which {@link ConversionKind} a request maps onto. */
export type ConversionRouteInput = {
  /** Format of the source document. */
  sourceFormat: SourceFormat;
  /** Whether a PDF source is a scan/image (no real text layer). */
  isScanned?: boolean;
};

/**
 * Decide which {@link ConversionKind} applies for a source. Pure and side-effect
 * free so it can be unit-tested directly (Task 8.11):
 * - `word` → `word-to-pdf`.
 * - `pdf` + scanned → `pdf-scan-to-word`.
 * - `pdf` + text layer → `pdf-to-word`.
 *
 * @param input The source format + scanned flag.
 * @returns The conversion kind to run.
 */
export const decideConversionKind = (input: ConversionRouteInput): ConversionKind => {
  if (input.sourceFormat === 'word') return 'word-to-pdf';
  return input.isScanned ? 'pdf-scan-to-word' : 'pdf-to-word';
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default job-id prefix, mirroring `mediaPipeline`'s `media-<n>` scheme. */
const JOB_ID_PREFIX = 'conversion';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link IConversionService} from injected converters + lease coordinator.
 *
 * The returned service owns an in-memory job registry; each `convert` call
 * resolves the {@link ConversionKind} (explicit or via {@link decideConversionKind}),
 * creates one {@link ConversionJob}, drives it through `queued → running → done`
 * (or `failed`), and delegates the heavy work to the matching converter (which
 * gates its own steps behind the ResourceCoordinator — criterion 2.10).
 *
 * @param deps Injected collaborators and tunables. See {@link ConversionServiceDeps}.
 * @returns A ready-to-use conversion service.
 */
export const createConversionService = (deps: ConversionServiceDeps): IConversionService => {
  const { pdfToWord, pdfScanToWord, wordToPdf } = deps;
  const now = deps.now ?? (() => Date.now());

  let counter = 0;
  const generateId = deps.generateId ?? (() => `${JOB_ID_PREFIX}-${++counter}`);

  /** In-memory job registry, keyed by job id and preserving insertion order. */
  const jobs = new Map<string, ConversionJob>();

  /** Resolve the converter for a kind. */
  const converterFor = (kind: ConversionKind): { convert(input: ConversionInput): Promise<ConversionArtifact> } => {
    switch (kind) {
      case 'pdf-to-word':
        return pdfToWord;
      case 'pdf-scan-to-word':
        return pdfScanToWord;
      case 'word-to-pdf':
        return wordToPdf;
    }
  };

  /** Create a fresh job in the `queued` state and register it. */
  const createJob = (kind: ConversionKind, sourcePath: string): ConversionJob => {
    const ts = now();
    const job: ConversionJob = { id: generateId(), kind, status: 'queued', sourcePath, createdAt: ts, updatedAt: ts };
    jobs.set(job.id, job);
    return job;
  };

  /** Apply a state transition to a job, stamping `updatedAt`. */
  const transition = (job: ConversionJob, patch: Partial<Omit<ConversionJob, 'id'>>): void => {
    Object.assign(job, patch, { updatedAt: now() });
  };

  const convert = async (request: ConversionRequest): Promise<ConversionResult> => {
    const kind = request.kind ?? decideConversionKind(request);
    const job = createJob(kind, request.sourcePath);
    const input: ConversionInput = { sourcePath: request.sourcePath, targetPath: request.targetPath };
    transition(job, { status: 'running' });
    try {
      const artifact = await converterFor(kind).convert(input);
      transition(job, { status: 'done', outputPath: artifact.outputPath });
      return {
        jobId: job.id,
        kind,
        outputPath: artifact.outputPath,
        needsReview: artifact.needsReview,
        confidence: artifact.confidence,
        warnings: artifact.warnings,
      };
    } catch (error) {
      transition(job, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };

  const getJob = (jobId: string): ConversionJob | undefined => {
    const job = jobs.get(jobId);
    return job ? { ...job } : undefined;
  };

  const listJobs = (): ConversionJob[] => [...jobs.values()].map((job) => ({ ...job }));

  return { convert, getJob, listJobs };
};
