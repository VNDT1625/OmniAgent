/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Periodic memory compaction for the agent-company model (Requirement 3 —
 * "Mô hình công ty tác nhân", criterion 3.5).
 *
 * Each high-level company agent accumulates experience in `memory.md` (managed
 * by {@link IMemoryStore}). Left unchecked that file grows without bound and
 * becomes expensive to load into a model's context. The compactor keeps it lean:
 *
 * 1. It periodically inspects an agent's `memory.md`.
 * 2. When the memory exceeds a configurable threshold (byte size *or* entry
 *    count), it **summarises the oldest portion** with a cheap model (the
 *    injected {@link Summarizer}) and **keeps the most recent entries verbatim**.
 * 3. The trimmed-away raw text is optionally handed to an injected
 *    {@link MemoryArchiver} so nothing is lost (e.g. written to a sibling
 *    `memory-archive.md`), then `memory.md` is rewritten via the store.
 *
 * ## Heavy work goes through the ResourceCoordinator (criterion 5.9)
 *
 * Summarisation is a model call — a heavy task — so it MUST be gated by the
 * ResourceCoordinator. The compactor wraps every summarisation in
 * `requestLease({ kind })` … `releaseLease(id)` inside a `try/finally`, so the
 * lease is always released even if the cheap model throws. Only the minimal
 * `{ requestLease, releaseLease }` surface is required, so the real
 * `IResourceCoordinator` can be passed directly while tests inject a fake.
 *
 * ## Testability
 *
 * Every side effect is injected (see {@link MemoryCompactorOptions}): the memory
 * store, the summariser, the lease coordinator, the optional archiver, the
 * timer scheduler, the clock, and even the entry splitter/joiner. The periodic
 * loop is optional and driven by an injectable scheduler, so unit tests
 * (Task 4.11) can drive {@link IMemoryCompactor.compactAgent} directly without
 * real timers, a real model, or real disk.
 *
 * Process boundary: this is a Main-process (Node.js) module — no DOM APIs. It
 * imports **types only** from its collaborators so it stays decoupled from their
 * concrete implementations.
 */

import type { IMemoryStore } from './memoryStore';
import type { Lease, LeaseRequest, TaskKind } from '../resource/leaseTypes';

/**
 * A cheap-model summarisation function: turns a (potentially large) block of
 * older memory text into a short summary. Injected so the compactor never
 * hardcodes a concrete model — production wiring supplies a real cheap-model
 * call, tests supply a deterministic stub.
 */
export type Summarizer = (text: string) => Promise<string>;

/**
 * Optional sink for the raw text trimmed out of `memory.md` during compaction.
 * Implementations might append it to a sibling `memory-archive.md`, upload it,
 * or drop it. Injected so the compactor itself performs no extra disk IO and
 * stays unit-testable.
 *
 * @param agentId      The agent whose memory was trimmed.
 * @param archivedText The raw (pre-summary) text removed from `memory.md`.
 */
export type MemoryArchiver = (agentId: string, archivedText: string) => Promise<void>;

/**
 * Minimal subset of the ResourceCoordinator used by the compactor. The real
 * `IResourceCoordinator` satisfies this structurally, so it can be passed
 * directly; tests inject a lightweight fake.
 */
export type LeaseCoordinator = {
  /** Request a lease for a heavy task; resolves when the budget allows. */
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  /** Release a previously granted lease by id. */
  releaseLease: (id: string) => void;
};

/** Opaque timer handle returned by {@link CompactorScheduler.setInterval}. */
export type CompactorTimerHandle = unknown;

/**
 * Timer abstraction so the periodic loop can be driven by a fake scheduler in
 * tests. Mirrors the subset of the Node timer API the compactor needs; the
 * default wraps the global timers.
 */
export type CompactorScheduler = {
  /** Schedule `handler` to run every `ms` milliseconds; returns a handle. */
  setInterval: (handler: () => void, ms: number) => CompactorTimerHandle;
  /** Cancel a previously scheduled interval. */
  clearInterval: (handle: CompactorTimerHandle) => void;
};

/**
 * Thresholds and trim policy for compaction. All fields have sensible defaults
 * (see {@link DEFAULT_COMPACTION_POLICY}); callers override only what they need.
 */
export type CompactionPolicy = {
  /** Compact when `memory.md` exceeds this many UTF-8 bytes. */
  maxBytes: number;
  /** Compact when `memory.md` holds more than this many entries. */
  maxEntries: number;
  /** Number of most-recent entries always kept verbatim (never summarised). */
  keepRecentEntries: number;
};

/** Default compaction policy — conservative thresholds that avoid bloat. */
export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  maxBytes: 16 * 1024,
  maxEntries: 200,
  keepRecentEntries: 50,
};

/** Default {@link TaskKind} used when leasing summarisation work. */
const DEFAULT_LEASE_KIND: TaskKind = 'agent';

/** Default estimated memory cost (MB) charged against the budget per summary. */
const DEFAULT_EST_COST_MB = 256;

/** Default interval (ms) of the periodic compaction loop — 30 minutes. */
const DEFAULT_INTERVAL_MS = 30 * 60_000;

/** Dependencies and tunables for {@link createMemoryCompactor}. */
export type MemoryCompactorOptions = {
  /** The memory store this compactor operates on (scoped to one company). */
  store: IMemoryStore;
  /** Cheap-model summarisation function for the trimmed-away older text. */
  summarizer: Summarizer;
  /** Lease gate; summarisation runs only while a lease is held (criterion 5.9). */
  coordinator: LeaseCoordinator;
  /** Optional sink for the raw trimmed text. Omit to discard it after summary. */
  archive?: MemoryArchiver;
  /** Threshold/trim policy overrides. Merged over {@link DEFAULT_COMPACTION_POLICY}. */
  policy?: Partial<CompactionPolicy>;
  /** {@link TaskKind} to lease summarisation under. Defaults to `'agent'`. */
  leaseKind?: TaskKind;
  /** Estimated RAM (MB) charged per summarisation lease. Defaults to 256. */
  estCostMB?: number;
  /** Timer scheduler for the periodic loop. Defaults to the global timers. */
  scheduler?: CompactorScheduler;
  /** Interval (ms) of the periodic loop. Defaults to 30 minutes. */
  intervalMs?: number;
  /**
   * Lists the agent ids the periodic loop should compact. Required only for
   * {@link IMemoryCompactor.start}/{@link IMemoryCompactor.compactAllAgents};
   * {@link IMemoryCompactor.compactAgent} works without it.
   */
  listAgents?: () => string[] | Promise<string[]>;
  /**
   * Splits raw `memory.md` content into discrete entries. The default treats
   * each non-empty line as one entry, matching `IMemoryStore.appendMemory`
   * (which appends newline-terminated blocks). Override for multi-line entries.
   */
  splitEntries?: (memory: string) => string[];
  /** Joins entries back into `memory.md` content. Default joins with newlines. */
  joinEntries?: (entries: string[]) => string;
  /** Wall-clock source (Unix ms) used to stamp the summary header. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Why a {@link CompactionResult} did or did not perform work.
 * - `'compacted'`        — older entries were summarised and `memory.md` rewritten.
 * - `'below-threshold'`  — memory was under both thresholds; nothing to do.
 * - `'nothing-to-archive'` — threshold exceeded but too few entries to trim.
 */
export type CompactionOutcome = 'compacted' | 'below-threshold' | 'nothing-to-archive';

/** Outcome of compacting a single agent's memory. */
export type CompactionResult = {
  /** The agent whose memory was inspected. */
  agentId: string;
  /** Whether `memory.md` was actually rewritten. */
  compacted: boolean;
  /** Reason for the outcome (useful for logging/metrics/tests). */
  outcome: CompactionOutcome;
  /** Entry count before compaction. */
  entriesBefore: number;
  /** Entry count after compaction (`entriesBefore` when not compacted). */
  entriesAfter: number;
  /** UTF-8 byte size before compaction. */
  bytesBefore: number;
  /** UTF-8 byte size after compaction (`bytesBefore` when not compacted). */
  bytesAfter: number;
  /** Number of older entries folded into the summary (0 when not compacted). */
  summarizedEntries: number;
};

/** Public contract of the memory compactor. */
export type IMemoryCompactor = {
  /** Inspect and, if over threshold, compact a single agent's `memory.md`. */
  compactAgent(agentId: string): Promise<CompactionResult>;
  /** Compact every agent returned by `listAgents` (errors are isolated per agent). */
  compactAllAgents(): Promise<CompactionResult[]>;
  /** Start the periodic compaction loop (no-op if already running). */
  start(): void;
  /** Stop the periodic compaction loop (no-op if not running). */
  stop(): void;
};

/** Default scheduler backed by the global Node timers. */
const defaultScheduler: CompactorScheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/**
 * Default entry splitter: one entry per non-empty line. Trailing/leading blank
 * lines (e.g. the newline `appendMemory` adds) are dropped so they never count
 * as entries or accumulate over repeated compactions.
 */
const defaultSplitEntries = (memory: string): string[] => memory.split('\n').filter((line) => line.trim().length > 0);

/** Default entry joiner: newline-separated, mirroring the default splitter. */
const defaultJoinEntries = (entries: string[]): string => entries.join('\n');

/**
 * Create a {@link IMemoryCompactor} from the given dependencies.
 *
 * The returned compactor is stateless apart from the periodic-loop handle, so a
 * single instance can compact many agents. Prefer driving
 * {@link IMemoryCompactor.compactAgent} directly in tests.
 *
 * @param options Injected collaborators and tunables. See {@link MemoryCompactorOptions}.
 * @returns A memory compactor ready to use.
 */
export const createMemoryCompactor = (options: MemoryCompactorOptions): IMemoryCompactor => {
  const { store, summarizer, coordinator, archive, listAgents } = options;
  const policy: CompactionPolicy = { ...DEFAULT_COMPACTION_POLICY, ...options.policy };
  const leaseKind = options.leaseKind ?? DEFAULT_LEASE_KIND;
  const estCostMB = options.estCostMB ?? DEFAULT_EST_COST_MB;
  const scheduler = options.scheduler ?? defaultScheduler;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const splitEntries = options.splitEntries ?? defaultSplitEntries;
  const joinEntries = options.joinEntries ?? defaultJoinEntries;
  const now = options.now ?? (() => Date.now());

  /** UTF-8 byte length of a string (the cost metric the threshold guards). */
  const byteLength = (text: string): number => Buffer.byteLength(text, 'utf-8');

  /** Whether memory is large enough (by size or count) to warrant compaction. */
  const isOverThreshold = (bytes: number, entryCount: number): boolean =>
    bytes > policy.maxBytes || entryCount > policy.maxEntries;

  /**
   * Run heavy summarisation under a resource lease. The lease is requested
   * first and always released in `finally`, so the budget is freed even when
   * the cheap model throws (criterion 5.9).
   */
  const summarizeUnderLease = async (text: string): Promise<string> => {
    const lease = await coordinator.requestLease({ kind: leaseKind, estCostMB });
    try {
      return await summarizer(text);
    } finally {
      coordinator.releaseLease(lease.id);
    }
  };

  /** Render the summary as a single labelled, timestamped entry block. */
  const renderSummaryEntry = (summary: string, summarizedCount: number): string => {
    const stamp = new Date(now()).toISOString();
    return `## Summary of ${summarizedCount} older memory entries (compacted ${stamp})\n${summary}`;
  };

  const compactAgent = async (agentId: string): Promise<CompactionResult> => {
    const memory = await store.readMemory(agentId);
    const entries = splitEntries(memory);
    const bytesBefore = byteLength(memory);
    const entriesBefore = entries.length;

    const unchanged = (outcome: CompactionOutcome): CompactionResult => ({
      agentId,
      compacted: false,
      outcome,
      entriesBefore,
      entriesAfter: entriesBefore,
      bytesBefore,
      bytesAfter: bytesBefore,
      summarizedEntries: 0,
    });

    if (!isOverThreshold(bytesBefore, entriesBefore)) {
      return unchanged('below-threshold');
    }

    // Keep the most recent entries verbatim; everything older is summarised.
    const keep = Math.max(0, policy.keepRecentEntries);
    let splitIndex = Math.max(0, entriesBefore - keep);
    // Size-driven case: few entries but huge ones. Force trimming the oldest so
    // compaction still makes progress — unless a single entry is all there is.
    if (splitIndex === 0 && entriesBefore > 1) splitIndex = 1;

    const older = entries.slice(0, splitIndex);
    const recent = entries.slice(splitIndex);
    if (older.length === 0) {
      // Threshold exceeded but nothing can be trimmed (e.g. one giant entry).
      return unchanged('nothing-to-archive');
    }

    const archivedText = joinEntries(older);
    const summary = await summarizeUnderLease(archivedText);

    // Preserve the raw trimmed text (if an archiver is wired) before rewriting.
    if (archive) await archive(agentId, archivedText);

    const summaryEntry = renderSummaryEntry(summary, older.length);
    const newMemory = joinEntries([summaryEntry, ...recent]);
    await store.writeMemory(agentId, newMemory);

    return {
      agentId,
      compacted: true,
      outcome: 'compacted',
      entriesBefore,
      entriesAfter: 1 + recent.length,
      bytesBefore,
      bytesAfter: byteLength(newMemory),
      summarizedEntries: older.length,
    };
  };

  const compactAllAgents = async (): Promise<CompactionResult[]> => {
    if (!listAgents) {
      console.warn('[Company] memoryCompactor.compactAllAgents called without a `listAgents` provider; nothing to do.');
      return [];
    }
    const agentIds = await listAgents();
    const results: CompactionResult[] = [];
    for (const agentId of agentIds) {
      try {
        results.push(await compactAgent(agentId));
      } catch (error) {
        // Isolate failures so one bad agent cannot stall the whole sweep.
        console.warn(`[Company] memoryCompactor failed to compact agent "${agentId}":`, error);
      }
    }
    return results;
  };

  // -------------------------------------------------------------------------
  // Optional periodic loop (test-friendly via the injected scheduler)
  // -------------------------------------------------------------------------

  let timer: CompactorTimerHandle | undefined;
  let ticking = false;

  /** One periodic tick: sweep all agents, skipping if a sweep is still running. */
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      await compactAllAgents();
    } catch (error) {
      console.warn('[Company] memoryCompactor periodic tick failed:', error);
    } finally {
      ticking = false;
    }
  };

  const start = (): void => {
    if (timer !== undefined) return;
    timer = scheduler.setInterval(() => {
      void tick();
    }, intervalMs);
  };

  const stop = (): void => {
    if (timer === undefined) return;
    scheduler.clearInterval(timer);
    timer = undefined;
  };

  return { compactAgent, compactAllAgents, start, stop };
};
