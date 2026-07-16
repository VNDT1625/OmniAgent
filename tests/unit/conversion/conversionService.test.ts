/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit + integration tests for the document-conversion layer (Requirement 2a —
 * Universal Editor, criterion 2.5: "đổi PDF ⇄ Word"; criterion 2.10: heavy steps
 * go through the ResourceCoordinator). Two layers are exercised together:
 *
 *   - `conversionService` — the ROUTING facade. `decideConversionKind` (pure) and
 *     `convert` dispatch each request to the right converter and track it as a
 *     `ConversionJob` (queued → running → done / failed), mirroring `mediaPipeline`.
 *   - the three converters (`pdfToWord`, `pdfScanToWord`, `wordToPdf`) wired with
 *     in-memory stub engines and a fake `LeaseCoordinator`, so the lease balance
 *     and the two-lease scanned path (ocr → docConvert) are asserted end-to-end.
 *
 * Every heavy collaborator is injected. "Small fixtures" are tiny in-memory
 * inputs (e.g. `{ sourcePath: 'a.pdf' }`) — no real pdf-lib/mammoth/tesseract and
 * no disk is touched.
 *
 * Validates: Requirements 2.5
 */

import { describe, expect, it } from 'vitest';
import type {
  ConversionJobStatus,
  ConversionKind,
  ConversionRequest,
  IConversionService,
} from '@/process/conversion/conversionService';
import { createConversionService, decideConversionKind } from '@/process/conversion/conversionService';
import { createPdfToWord, type PdfToWordEngine } from '@/process/conversion/pdfToWord';
import {
  createPdfScanToWord,
  type DocxAssembler,
  type OcrEngine,
  type OcrResult,
} from '@/process/conversion/pdfScanToWord';
import { createWordToPdf, type WordToPdfEngine } from '@/process/conversion/wordToPdf';
import type { ConversionArtifact, ConversionInput } from '@/process/conversion/conversionTypes';
import type { Lease, LeaseRequest, TaskKind } from '@/process/resource/leaseTypes';

// ---------------------------------------------------------------------------
// Canned converter outputs (deterministic, no real work)
// ---------------------------------------------------------------------------

const TEXT_PDF: ConversionRequest = { sourcePath: 'text.pdf', sourceFormat: 'pdf', isScanned: false };
const SCAN_PDF: ConversionRequest = { sourcePath: 'scan.pdf', sourceFormat: 'pdf', isScanned: true };
const WORD_DOC: ConversionRequest = { sourcePath: 'letter.docx', sourceFormat: 'word' };

const PDF_TO_WORD_OUT = 'text.docx';
const WORD_TO_PDF_OUT = 'letter.pdf';
const SCAN_DOCX_OUT = 'scan.docx';

const OCR_RESULT: OcrResult = {
  pages: [
    { pageNumber: 1, text: 'page one', confidence: 0.8 },
    { pageNumber: 2, text: 'page two', confidence: 0.6 },
  ],
};

// ---------------------------------------------------------------------------
// Fake LeaseCoordinator with full grant/release accounting (mirrors
// tests/unit/browser/leaseAccounting.test.ts so conventions stay consistent).
// ---------------------------------------------------------------------------

/** One granted lease, remembered so releases can be matched back to grants. */
type GrantRecord = { id: string; kind: TaskKind };

/**
 * Grants instantly (budget gating is tested elsewhere) but records everything
 * needed to prove lease balance: every grant, every release, the set currently
 * held, plus any double-release or release-without-grant it observes.
 */
const createFakeCoordinator = () => {
  const grants: GrantRecord[] = [];
  const releases: string[] = [];
  const held = new Set<string>();
  const grantedIds = new Set<string>();
  const doubleReleases: string[] = [];
  const releasesWithoutGrant: string[] = [];
  let counter = 0;

  const requestLease = async (req: LeaseRequest): Promise<Lease> => {
    const id = `lease-${++counter}`;
    grants.push({ id, kind: req.kind });
    grantedIds.add(id);
    held.add(id);
    return { id, kind: req.kind, grantedAt: counter, estCostMB: req.estCostMB };
  };

  const releaseLease = (id: string): void => {
    releases.push(id);
    if (!grantedIds.has(id)) {
      releasesWithoutGrant.push(id);
    } else if (!held.has(id)) {
      doubleReleases.push(id);
    }
    held.delete(id);
  };

  return { coordinator: { requestLease, releaseLease }, grants, releases, held, doubleReleases, releasesWithoutGrant };
};

type Accounting = ReturnType<typeof createFakeCoordinator>;

/** The lease-balance invariant: every granted lease is released exactly once. */
const assertBalanced = (accounting: Accounting): void => {
  expect(accounting.held.size).toBe(0);
  expect(accounting.doubleReleases).toEqual([]);
  expect(accounting.releasesWithoutGrant).toEqual([]);
  expect([...accounting.releases].toSorted()).toEqual(accounting.grants.map((grant) => grant.id).toSorted());
};

// ---------------------------------------------------------------------------
// Test harness: real converters + recording stub engines + fake coordinator
// ---------------------------------------------------------------------------

/** Per-engine failure switches + an optional clock for lifecycle ordering. */
type HarnessOptions = {
  failPdfToWord?: boolean;
  failWordToPdf?: boolean;
  failOcr?: boolean;
  failAssemble?: boolean;
  /** Freeze the text-PDF engine until this promise resolves (for in-flight tests). */
  pdfToWordGate?: Promise<void>;
  now?: () => number;
};

/** Records of which engine ran, in what order, and with what input. */
type EngineCalls = {
  pdfToWord: ConversionInput[];
  wordToPdf: ConversionInput[];
  ocr: string[];
  assemble: { ocr: OcrResult; input: ConversionInput }[];
  /** Global call order across all engines, for asserting OCR-then-assemble. */
  order: string[];
};

const createHarness = (options: HarnessOptions = {}) => {
  const accounting = createFakeCoordinator();
  const { coordinator } = accounting;

  const calls: EngineCalls = { pdfToWord: [], wordToPdf: [], ocr: [], assemble: [], order: [] };

  const pdfToWordEngine: PdfToWordEngine = {
    convert: async (input): Promise<ConversionArtifact> => {
      calls.pdfToWord.push(input);
      calls.order.push('pdfToWord');
      if (options.pdfToWordGate) await options.pdfToWordGate;
      if (options.failPdfToWord) throw new Error('pdf-to-word engine failed');
      return { outputPath: PDF_TO_WORD_OUT, needsReview: false, confidence: 0.97, warnings: [] };
    },
  };

  const wordToPdfEngine: WordToPdfEngine = {
    convert: async (input): Promise<ConversionArtifact> => {
      calls.wordToPdf.push(input);
      calls.order.push('wordToPdf');
      if (options.failWordToPdf) throw new Error('word-to-pdf engine failed');
      return { outputPath: WORD_TO_PDF_OUT, needsReview: false };
    },
  };

  const ocrEngine: OcrEngine = {
    recognize: async (sourcePath): Promise<OcrResult> => {
      calls.ocr.push(sourcePath);
      calls.order.push('ocr');
      if (options.failOcr) throw new Error('ocr engine failed');
      return OCR_RESULT;
    },
  };

  const assembler: DocxAssembler = {
    assemble: async (ocr, input): Promise<string> => {
      calls.assemble.push({ ocr, input });
      calls.order.push('assemble');
      if (options.failAssemble) throw new Error('docx assembler failed');
      return SCAN_DOCX_OUT;
    },
  };

  const service: IConversionService = createConversionService({
    coordinator,
    pdfToWord: createPdfToWord({ coordinator, engine: pdfToWordEngine }),
    pdfScanToWord: createPdfScanToWord({ coordinator, ocrEngine, assembler }),
    wordToPdf: createWordToPdf({ coordinator, engine: wordToPdfEngine }),
    now: options.now,
  });

  return { service, accounting, calls };
};

/** A manually-resolvable promise, used to freeze a job mid heavy step. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** Flush the macrotask + microtask queues so suspended async work advances. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// decideConversionKind — pure routing (criterion 2.5)
// ---------------------------------------------------------------------------

describe('decideConversionKind', () => {
  it('routes a Word source to word-to-pdf regardless of the scanned flag', () => {
    expect(decideConversionKind({ sourceFormat: 'word' })).toBe('word-to-pdf');
    // isScanned is meaningless for Word and must be ignored.
    expect(decideConversionKind({ sourceFormat: 'word', isScanned: true })).toBe('word-to-pdf');
  });

  it('routes a scanned PDF to the OCR pipeline (pdf-scan-to-word)', () => {
    expect(decideConversionKind({ sourceFormat: 'pdf', isScanned: true })).toBe('pdf-scan-to-word');
  });

  it('routes a text-layer PDF to pdf-to-word', () => {
    expect(decideConversionKind({ sourceFormat: 'pdf', isScanned: false })).toBe('pdf-to-word');
  });

  it('treats a PDF with no scanned flag as a text PDF (pdf-to-word)', () => {
    expect(decideConversionKind({ sourceFormat: 'pdf' })).toBe('pdf-to-word');
  });
});

// ---------------------------------------------------------------------------
// convert — dispatch to the correct converter per kind (criterion 2.5)
// ---------------------------------------------------------------------------

describe('createConversionService.convert dispatch', () => {
  it('dispatches a text PDF to the PdfToWordEngine only', async () => {
    const harness = createHarness();

    const result = await harness.service.convert(TEXT_PDF);

    expect(result.kind).toBe('pdf-to-word');
    expect(result.outputPath).toBe(PDF_TO_WORD_OUT);
    expect(result.needsReview).toBe(false);
    // Only the text engine ran; OCR / assembler / word-to-pdf stayed untouched.
    expect(harness.calls.pdfToWord).toEqual([{ sourcePath: 'text.pdf', targetPath: undefined }]);
    expect(harness.calls.ocr).toEqual([]);
    expect(harness.calls.wordToPdf).toEqual([]);
  });

  it('dispatches a Word source to the WordToPdfEngine only', async () => {
    const harness = createHarness();

    const result = await harness.service.convert(WORD_DOC);

    expect(result.kind).toBe('word-to-pdf');
    expect(result.outputPath).toBe(WORD_TO_PDF_OUT);
    expect(harness.calls.wordToPdf).toEqual([{ sourcePath: 'letter.docx', targetPath: undefined }]);
    expect(harness.calls.pdfToWord).toEqual([]);
  });

  it('dispatches a scanned PDF through OCR then the DocxAssembler, in that order', async () => {
    const harness = createHarness();

    const result = await harness.service.convert(SCAN_PDF);

    expect(result.kind).toBe('pdf-scan-to-word');
    expect(result.outputPath).toBe(SCAN_DOCX_OUT);
    // OCR must run BEFORE assembly, and the assembler must receive the OCR result.
    expect(harness.calls.order).toEqual(['ocr', 'assemble']);
    expect(harness.calls.ocr).toEqual(['scan.pdf']);
    expect(harness.calls.assemble[0]?.ocr).toBe(OCR_RESULT);
  });

  it('flags scanned-PDF output as needing human review (criterion 2.5)', async () => {
    const harness = createHarness();

    const result = await harness.service.convert(SCAN_PDF);

    expect(result.needsReview).toBe(true);
    // Average of the per-page OCR confidences (0.8 + 0.6) / 2.
    expect(result.confidence).toBeCloseTo(0.7, 5);
  });

  it('honours an explicit request.kind over the automatic routing', async () => {
    const harness = createHarness();

    // A scanned PDF, but the caller forces the text pipeline.
    const result = await harness.service.convert({ ...SCAN_PDF, kind: 'pdf-to-word' });

    expect(result.kind).toBe('pdf-to-word');
    expect(harness.calls.pdfToWord.length).toBe(1);
    // The OCR pipeline must NOT have run despite isScanned being true.
    expect(harness.calls.ocr).toEqual([]);
    expect(harness.calls.assemble).toEqual([]);
  });

  it('forwards the targetPath to the chosen engine when provided', async () => {
    const harness = createHarness();

    await harness.service.convert({ ...TEXT_PDF, targetPath: 'custom.docx' });

    expect(harness.calls.pdfToWord[0]?.targetPath).toBe('custom.docx');
  });
});

// ---------------------------------------------------------------------------
// ConversionJob lifecycle — queued → running → done / failed
// ---------------------------------------------------------------------------

describe('createConversionService job lifecycle', () => {
  it('exposes created jobs through getJob and listJobs', async () => {
    const harness = createHarness();

    const result = await harness.service.convert(TEXT_PDF);

    const job = harness.service.getJob(result.jobId);
    expect(job?.kind).toBe('pdf-to-word');
    expect(job?.status).toBe('done');
    expect(job?.outputPath).toBe(PDF_TO_WORD_OUT);
    expect(harness.service.listJobs().map((entry) => entry.id)).toEqual([result.jobId]);
    expect(harness.service.getJob('does-not-exist')).toBeUndefined();
  });

  it('drives a job through queued → running → done in order', async () => {
    // `now()` is invoked by each state transition *before* the new status is
    // applied, so snapshotting the latest job at every tick reveals the ordered
    // lifecycle the service documents (mirrors mediaPipeline's lifecycle test).
    const holder: { service?: IConversionService } = {};
    const observed: ConversionJobStatus[] = [];
    let clock = 0;
    const harness = createHarness({
      now: () => {
        const last = holder.service?.listJobs().at(-1);
        if (last) observed.push(last.status);
        return ++clock;
      },
    });
    holder.service = harness.service;

    const result = await harness.service.convert(TEXT_PDF);
    const finalStatus = harness.service.getJob(result.jobId)?.status;

    expect([...observed, finalStatus]).toEqual(['queued', 'running', 'done']);
  });

  it('keeps a job running while a heavy step is in flight, then marks it done', async () => {
    const gate = deferred();
    const harness = createHarness({ pdfToWordGate: gate.promise });

    const pending = harness.service.convert(TEXT_PDF);
    await tick();

    const jobId = harness.service.listJobs()[0]?.id ?? '';
    expect(harness.service.getJob(jobId)?.status).toBe('running');

    gate.resolve();
    await pending;
    expect(harness.service.getJob(jobId)?.status).toBe('done');
  });

  it('marks a job failed with the engine error message when the text engine throws', async () => {
    const harness = createHarness({ failPdfToWord: true });

    await expect(harness.service.convert(TEXT_PDF)).rejects.toThrow('pdf-to-word engine failed');

    const job = harness.service.listJobs()[0];
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('pdf-to-word engine failed');
    expect(job?.outputPath).toBeUndefined();
  });

  it('marks a scanned job failed when the OCR engine throws', async () => {
    const harness = createHarness({ failOcr: true });

    await expect(harness.service.convert(SCAN_PDF)).rejects.toThrow('ocr engine failed');

    const job = harness.service.listJobs()[0];
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('ocr engine failed');
    // The assembler must not run once OCR has failed.
    expect(harness.calls.assemble).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lease accounting — every heavy step acquires AND releases a lease
// (integration with runUnderLease; criterion 2.10 / Requirement 5)
// ---------------------------------------------------------------------------

describe('createConversionService lease accounting', () => {
  it('leases a text PDF conversion under a single docConvert lease', async () => {
    const harness = createHarness();

    await harness.service.convert(TEXT_PDF);

    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['docConvert']);
    assertBalanced(harness.accounting);
  });

  it('leases a Word conversion under a single docConvert lease', async () => {
    const harness = createHarness();

    await harness.service.convert(WORD_DOC);

    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['docConvert']);
    assertBalanced(harness.accounting);
  });

  it('leases the scanned path under ocr then docConvert (two balanced leases)', async () => {
    const harness = createHarness();

    await harness.service.convert(SCAN_PDF);

    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['ocr', 'docConvert']);
    assertBalanced(harness.accounting);
  });

  it('releases the docConvert lease even when the text engine throws', async () => {
    const harness = createHarness({ failPdfToWord: true });

    await expect(harness.service.convert(TEXT_PDF)).rejects.toThrow('pdf-to-word engine failed');

    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['docConvert']);
    assertBalanced(harness.accounting);
  });

  it('releases only the ocr lease when OCR throws (assembly never leased)', async () => {
    const harness = createHarness({ failOcr: true });

    await expect(harness.service.convert(SCAN_PDF)).rejects.toThrow('ocr engine failed');

    // OCR lease taken + released via finally; the assembler step never ran.
    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['ocr']);
    assertBalanced(harness.accounting);
  });

  it('releases both scanned-path leases when the assembler throws', async () => {
    const harness = createHarness({ failAssemble: true });

    await expect(harness.service.convert(SCAN_PDF)).rejects.toThrow('docx assembler failed');

    // OCR leased + released, then docConvert leased + released before the throw.
    expect(harness.accounting.grants.map((grant) => grant.kind)).toEqual(['ocr', 'docConvert']);
    assertBalanced(harness.accounting);
  });
});

// ---------------------------------------------------------------------------
// Property: lease balance holds after ANY conversion, with random failure
// injection. fast-check is not a dependency, so a deterministic seeded PRNG
// (mulberry32) drives randomized request sequences (mirrors leaseAccounting).
//
// Validates: Requirements 2.5
// ---------------------------------------------------------------------------

/** Number of randomized cases for the lease-balance property. */
const PROPERTY_RUNS = 200;

/** mulberry32 — a small, fast, deterministic PRNG seeded by a single integer. */
const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const randInt = (rng: () => number, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

/** Run an async `check` over many deterministic seeds, reporting the failing seed. */
const forAllSeedsAsync = async (
  runs: number,
  check: (rng: () => number, run: number) => Promise<void>
): Promise<void> => {
  for (let run = 0; run < runs; run++) {
    const seed = ((run + 1) * 0x9e3779b1) >>> 0;
    try {
      await check(makeRng(seed), run);
    } catch (error) {
      throw new Error(`Property failed on run ${run} (seed ${seed}): ${(error as Error).message}`, { cause: error });
    }
  }
};

/** All routable kinds, used to occasionally force an explicit `kind` override. */
const KINDS: ConversionKind[] = ['pdf-to-word', 'pdf-scan-to-word', 'word-to-pdf'];

/** Generate a random conversion request across all routing branches. */
const genRequest = (rng: () => number): ConversionRequest => {
  switch (randInt(rng, 0, 3)) {
    case 0:
      return { sourcePath: 'a.docx', sourceFormat: 'word' };
    case 1:
      return { sourcePath: 'a.pdf', sourceFormat: 'pdf', isScanned: false };
    case 2:
      return { sourcePath: 'a.pdf', sourceFormat: 'pdf', isScanned: true };
    default:
      // Explicit override on an arbitrary source — routing must obey `kind`.
      return {
        sourcePath: 'a.pdf',
        sourceFormat: 'pdf',
        isScanned: rng() < 0.5,
        kind: KINDS[randInt(rng, 0, KINDS.length - 1)],
      };
  }
};

/** Pick a random per-engine failure switch (or none). */
const genFailures = (rng: () => number): HarnessOptions => {
  switch (randInt(rng, 0, 4)) {
    case 0:
      return {};
    case 1:
      return { failPdfToWord: true };
    case 2:
      return { failWordToPdf: true };
    case 3:
      return { failOcr: true };
    default:
      return { failAssemble: true };
  }
};

describe('Property: conversion leases stay balanced after any op (Requirements 2.5)', () => {
  it('keeps leases balanced after every conversion in a randomized sequence with failure injection', async () => {
    await forAllSeedsAsync(PROPERTY_RUNS, async (rng) => {
      const harness = createHarness(genFailures(rng));

      const opCount = randInt(rng, 1, 8);
      for (let i = 0; i < opCount; i++) {
        try {
          await harness.service.convert(genRequest(rng));
        } catch {
          // Injected failures are expected; the invariant, not the outcome, matters.
        }
        // After EVERY op (success or throw) nothing may still be held.
        assertBalanced(harness.accounting);
      }
    });
  });

  it('never leaves a job stuck in queued or running after settling', async () => {
    await forAllSeedsAsync(PROPERTY_RUNS, async (rng) => {
      const harness = createHarness(genFailures(rng));

      const opCount = randInt(rng, 1, 8);
      for (let i = 0; i < opCount; i++) {
        await harness.service.convert(genRequest(rng)).catch(() => undefined);
      }

      // Every settled job is terminal — no orphaned queued/running state.
      for (const job of harness.service.listJobs()) {
        expect(job.status === 'done' || job.status === 'failed').toBe(true);
      }
    });
  });
});
