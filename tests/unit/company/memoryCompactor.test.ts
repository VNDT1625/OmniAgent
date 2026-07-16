/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/company/memoryCompactor — periodic compaction of a
 * high-level company agent's `memory.md` (Requirement 3, criterion 3.5: "dọn
 * gọn trí nhớ định kỳ — gom, tóm tắt phần cũ, cất phần ít dùng"). The compactor
 * summarises the oldest portion, keeps the most recent entries verbatim,
 * optionally archives the raw trimmed text, and gates the heavy summarisation
 * call behind a ResourceCoordinator lease (criterion 5.9).
 *
 * Every collaborator is a deterministic in-memory fake: a map-backed
 * IMemoryStore, a fixed-string Summarizer, a call-recording LeaseCoordinator, a
 * fake CompactorScheduler (no real timers), and an injected `now`. The
 * division-context injection side of this task (criterion 3.8) is already
 * covered by contextLayering.test.ts and is intentionally not duplicated here.
 *
 * Validates: Requirements 3.5
 */

import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  CompactorScheduler,
  CompactorTimerHandle,
  LeaseCoordinator,
  MemoryArchiver,
  MemoryCompactorOptions,
  Summarizer,
} from '@/process/company/memoryCompactor';
import { createMemoryCompactor } from '@/process/company/memoryCompactor';
import type { IMemoryStore } from '@/process/company/memoryStore';
import type { LeaseRequest, TaskKind } from '@/process/resource/leaseTypes';

// --- Fakes -----------------------------------------------------------------

/**
 * In-memory {@link IMemoryStore}. Only `readMemory`/`writeMemory` matter to the
 * compactor; the rest are faithful map-backed stubs so the full interface is
 * satisfied under TS strict. `readMemory` can be told to throw for a given agent
 * to exercise per-agent error isolation.
 */
const createFakeStore = (
  seed: Record<string, string> = {}
): { store: IMemoryStore; memory: Map<string, string>; failReadFor: Set<string> } => {
  const memory = new Map<string, string>(Object.entries(seed));
  const soul = new Map<string, string>();
  const failReadFor = new Set<string>();

  const store: IMemoryStore = {
    getAgentDir: async (agentId) => path.join('fake-root', agentId),
    ensureAgent: async (agentId) => {
      if (!memory.has(agentId)) memory.set(agentId, '');
    },
    readSoul: async (agentId) => soul.get(agentId) ?? '',
    writeSoul: async (agentId, content) => {
      soul.set(agentId, content);
    },
    readMemory: async (agentId) => {
      if (failReadFor.has(agentId)) throw new Error(`readMemory boom for "${agentId}"`);
      return memory.get(agentId) ?? '';
    },
    appendMemory: async (agentId, entry) => {
      const existing = memory.get(agentId) ?? '';
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      const suffix = entry.endsWith('\n') ? '' : '\n';
      memory.set(agentId, `${existing}${separator}${entry}${suffix}`);
    },
    writeMemory: async (agentId, content) => {
      memory.set(agentId, content);
    },
    readAll: async (agentId) => ({ agentId, soul: soul.get(agentId) ?? '', memory: memory.get(agentId) ?? '' }),
  };

  return { store, memory, failReadFor };
};

/** Deterministic summariser: collapses any text into a length-stamped marker. */
const fixedSummarizer: Summarizer = async (text) => `SUMMARY(${text.length} chars)`;

/**
 * Records the lifecycle of every lease so tests can assert that summarisation
 * acquires a lease before running and releases it after (criterion 5.9). The
 * `events` log preserves ordering across request/release/summarize.
 */
const createFakeCoordinator = (): {
  coordinator: LeaseCoordinator;
  requests: LeaseRequest[];
  released: string[];
  events: string[];
} => {
  const requests: LeaseRequest[] = [];
  const released: string[] = [];
  const events: string[] = [];
  let counter = 0;

  const coordinator: LeaseCoordinator = {
    requestLease: async (req) => {
      requests.push(req);
      events.push('request');
      counter += 1;
      return { id: `lease-${counter}`, kind: req.kind, grantedAt: 0, estCostMB: req.estCostMB };
    },
    releaseLease: (id) => {
      released.push(id);
      events.push('release');
    },
  };

  return { coordinator, requests, released, events };
};

/** Fake scheduler that records setInterval/clearInterval calls instead of using real timers. */
const createFakeScheduler = (): {
  scheduler: CompactorScheduler;
  setCalls: Array<{ handler: () => void; ms: number }>;
  clearCalls: CompactorTimerHandle[];
} => {
  const setCalls: Array<{ handler: () => void; ms: number }> = [];
  const clearCalls: CompactorTimerHandle[] = [];
  let handleCounter = 0;

  const scheduler: CompactorScheduler = {
    setInterval: (handler, ms) => {
      setCalls.push({ handler, ms });
      handleCounter += 1;
      return `timer-${handleCounter}`;
    },
    clearInterval: (handle) => {
      clearCalls.push(handle);
    },
  };

  return { scheduler, setCalls, clearCalls };
};

/** A fixed clock so the summary timestamp is reproducible. */
const FIXED_NOW = 1_700_000_000_000;

/** Build N simple, distinct single-line entries: `entry-0`, `entry-1`, … */
const makeEntries = (count: number): string[] => Array.from({ length: count }, (_, i) => `entry-${i}`);

/** Compose entries into a `memory.md` body the default splitter understands. */
const toMemory = (entries: string[]): string => entries.join('\n');

/**
 * Convenience factory that wires the standard fakes and lets each test override
 * just the pieces it cares about.
 */
const makeCompactor = (overrides: Partial<MemoryCompactorOptions> & Pick<MemoryCompactorOptions, 'store'>) => {
  const options: MemoryCompactorOptions = {
    summarizer: fixedSummarizer,
    coordinator: createFakeCoordinator().coordinator,
    now: () => FIXED_NOW,
    ...overrides,
  };
  return createMemoryCompactor(options);
};

// --- Tests -----------------------------------------------------------------

describe('createMemoryCompactor — compactAgent', () => {
  it('leaves below-threshold memory untouched and never requests a lease', async () => {
    const { store, memory } = createFakeStore();
    const original = toMemory(makeEntries(3));
    memory.set('president', original);
    const { coordinator, requests } = createFakeCoordinator();
    const summarizer = vi.fn(fixedSummarizer);

    const compactor = makeCompactor({
      store,
      coordinator,
      summarizer,
      policy: { maxBytes: 1000, maxEntries: 5, keepRecentEntries: 2 },
    });
    const result = await compactor.compactAgent('president');

    expect(result.outcome).toBe('below-threshold');
    expect(result.compacted).toBe(false);
    expect(result.summarizedEntries).toBe(0);
    // Store content is byte-for-byte unchanged and no heavy work was leased.
    expect(memory.get('president')).toBe(original);
    expect(requests).toHaveLength(0);
    expect(summarizer).not.toHaveBeenCalled();
  });

  it('summarises the oldest entries and keeps the most recent N verbatim when over the entry-count threshold', async () => {
    const { store, memory } = createFakeStore();
    memory.set('president', toMemory(makeEntries(8)));

    const compactor = makeCompactor({ store, policy: { maxBytes: 100_000, maxEntries: 5, keepRecentEntries: 2 } });
    const result = await compactor.compactAgent('president');

    expect(result.outcome).toBe('compacted');
    expect(result.compacted).toBe(true);
    // 8 entries, keepRecent 2 → oldest 6 folded into one summary, 2 kept verbatim.
    expect(result.summarizedEntries).toBe(6);
    expect(result.entriesBefore).toBe(8);
    expect(result.entriesAfter).toBe(3); // 1 summary block + 2 recent

    const rewritten = memory.get('president') ?? '';
    expect(rewritten).toContain('## Summary of 6 older memory entries');
    // The two most recent entries survive verbatim…
    expect(rewritten).toContain('entry-6');
    expect(rewritten).toContain('entry-7');
    // …while the oldest entries are folded away (no longer present verbatim).
    expect(rewritten).not.toContain('entry-0');
    expect(rewritten).not.toContain('entry-5');
  });

  it('still makes progress when a few huge entries blow the byte-size threshold', async () => {
    const { store, memory } = createFakeStore();
    const huge = [`A:${'x'.repeat(300)}`, `B:${'y'.repeat(300)}`];
    memory.set('president', toMemory(huge));

    // Entry count (2) is well under maxEntries; only the byte size is over.
    const compactor = makeCompactor({ store, policy: { maxBytes: 100, maxEntries: 500, keepRecentEntries: 50 } });
    const result = await compactor.compactAgent('president');

    expect(result.outcome).toBe('compacted');
    expect(result.compacted).toBe(true);
    expect(result.summarizedEntries).toBe(1); // forced to trim the oldest of the two
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);

    const rewritten = memory.get('president') ?? '';
    expect(rewritten).toContain('## Summary of 1 older memory entries');
    expect(rewritten).toContain(`B:${'y'.repeat(300)}`); // newest huge entry preserved
  });

  it('returns nothing-to-archive (and writes nothing) when a single giant entry cannot be trimmed', async () => {
    const { store, memory } = createFakeStore();
    const original = 'Z'.repeat(500);
    memory.set('president', original);
    const { coordinator, requests } = createFakeCoordinator();

    const compactor = makeCompactor({
      store,
      coordinator,
      policy: { maxBytes: 100, maxEntries: 500, keepRecentEntries: 50 },
    });
    const result = await compactor.compactAgent('president');

    expect(result.outcome).toBe('nothing-to-archive');
    expect(result.compacted).toBe(false);
    expect(memory.get('president')).toBe(original);
    expect(requests).toHaveLength(0);
  });

  it('hands the raw trimmed text to the archiver BEFORE the store is rewritten', async () => {
    const { store, memory } = createFakeStore();
    const entries = makeEntries(8);
    const originalMemory = toMemory(entries);
    memory.set('president', originalMemory);

    let archivedText: string | undefined;
    let storeSnapshotAtArchiveTime: string | undefined;
    const archive: MemoryArchiver = async (_agentId, text) => {
      archivedText = text;
      // Capture what the store holds at the moment the archiver runs.
      storeSnapshotAtArchiveTime = memory.get('president');
    };

    const compactor = makeCompactor({
      store,
      archive,
      policy: { maxBytes: 100_000, maxEntries: 5, keepRecentEntries: 2 },
    });
    await compactor.compactAgent('president');

    // Archiver received the raw (pre-summary) oldest 6 entries, joined verbatim.
    expect(archivedText).toBe(toMemory(entries.slice(0, 6)));
    // And it saw the ORIGINAL memory — the rewrite had not happened yet.
    expect(storeSnapshotAtArchiveTime).toBe(originalMemory);
    // The rewrite did eventually happen.
    expect(memory.get('president')).not.toBe(originalMemory);
  });
});

describe('createMemoryCompactor — lease lifecycle (criterion 5.9)', () => {
  it('acquires exactly one lease of the configured kind before summarising and releases it after', async () => {
    const { store, memory } = createFakeStore();
    memory.set('president', toMemory(makeEntries(8)));
    const { coordinator, requests, released, events } = createFakeCoordinator();

    const leaseKind: TaskKind = 'agent';
    const compactor = makeCompactor({
      store,
      coordinator,
      leaseKind,
      estCostMB: 128,
      policy: { maxBytes: 100_000, maxEntries: 5, keepRecentEntries: 2 },
    });
    await compactor.compactAgent('president');

    expect(requests).toHaveLength(1);
    expect(requests[0].kind).toBe(leaseKind);
    expect(requests[0].estCostMB).toBe(128);
    expect(released).toEqual(['lease-1']);
    // The lease is held across the summarise call: request → release in order.
    expect(events).toEqual(['request', 'release']);
  });

  it('always releases the lease even when the summarizer throws (try/finally)', async () => {
    const { store, memory } = createFakeStore();
    const original = toMemory(makeEntries(8));
    memory.set('president', original);
    const { coordinator, requests, released } = createFakeCoordinator();
    const throwingSummarizer: Summarizer = async () => {
      throw new Error('cheap model exploded');
    };

    const compactor = makeCompactor({
      store,
      coordinator,
      summarizer: throwingSummarizer,
      policy: { maxBytes: 100_000, maxEntries: 5, keepRecentEntries: 2 },
    });

    await expect(compactor.compactAgent('president')).rejects.toThrow('cheap model exploded');
    // Lease was requested and still released despite the throw.
    expect(requests).toHaveLength(1);
    expect(released).toEqual(['lease-1']);
    // The store was never rewritten because summarisation failed.
    expect(memory.get('president')).toBe(original);
  });
});

describe('createMemoryCompactor — compactAllAgents', () => {
  it('isolates a failing agent so the rest of the sweep still completes', async () => {
    const { store, memory, failReadFor } = createFakeStore();
    memory.set('good-1', toMemory(makeEntries(8)));
    memory.set('bad', toMemory(makeEntries(8)));
    memory.set('good-2', toMemory(makeEntries(8)));
    failReadFor.add('bad'); // readMemory throws for this agent

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const compactor = makeCompactor({
      store,
      listAgents: () => ['good-1', 'bad', 'good-2'],
      policy: { maxBytes: 100_000, maxEntries: 5, keepRecentEntries: 2 },
    });

    const results = await compactor.compactAllAgents();

    // Only the two healthy agents produced results; the failing one was skipped.
    expect(results.map((r) => r.agentId)).toEqual(['good-1', 'good-2']);
    expect(results.every((r) => r.compacted)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns an empty result set (and warns) when no listAgents provider is configured', async () => {
    const { store } = createFakeStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const compactor = makeCompactor({ store });
    const results = await compactor.compactAllAgents();

    expect(results).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('createMemoryCompactor — periodic loop uses the injected scheduler', () => {
  it('start() schedules a single interval at the configured period and stop() clears it', async () => {
    const { store } = createFakeStore();
    const { scheduler, setCalls, clearCalls } = createFakeScheduler();

    const compactor = makeCompactor({ store, scheduler, intervalMs: 1000, listAgents: () => [] });

    compactor.start();
    compactor.start(); // idempotent — must not schedule a second interval

    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].ms).toBe(1000);

    compactor.stop();
    compactor.stop(); // idempotent — must not clear when nothing is running

    expect(clearCalls).toHaveLength(1);
  });

  it('does not clear an interval when stop() is called before start()', () => {
    const { store } = createFakeStore();
    const { scheduler, setCalls, clearCalls } = createFakeScheduler();

    const compactor = makeCompactor({ store, scheduler, intervalMs: 1000, listAgents: () => [] });
    compactor.stop();

    expect(setCalls).toHaveLength(0);
    expect(clearCalls).toHaveLength(0);
  });

  it('drives a real sweep when the scheduled tick fires', async () => {
    const { store, memory } = createFakeStore();
    memory.set('president', toMemory(makeEntries(8)));
    const { scheduler, setCalls } = createFakeScheduler();

    const compactor = makeCompactor({
      store,
      scheduler,
      intervalMs: 1000,
      listAgents: () => ['president'],
      policy: { maxBytes: 100_000, maxEntries: 5, keepRecentEntries: 2 },
    });

    compactor.start();
    // Invoke the captured handler exactly as the scheduler would on each interval.
    setCalls[0].handler();
    // The tick runs asynchronously; let the microtask queue drain.
    await vi.waitFor(() => {
      expect(memory.get('president')).toContain('## Summary of 6 older memory entries');
    });
  });
});
