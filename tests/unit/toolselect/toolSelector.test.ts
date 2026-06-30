/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the tool/skill self-selection layer (Yêu cầu 7):
 * - `keywordFilter` (Tier 1) ranking + thresholds (criterion 7.3).
 * - `semanticFilter` (Tier 2) cosine ranking + lease usage (criteria 7.4 / 7.8).
 * - `toolSelector` select → try → re-select loop within the round limit, and the
 *   selection-log recall fast path (criteria 7.6 / 7.7).
 *
 * In-memory fakes only — no model, no disk.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CatalogEntry } from '@/process/toolselect/catalogTypes';
import { keywordFilter } from '@/process/toolselect/keywordFilter';
import { createSemanticFilter, type Embedder } from '@/process/toolselect/semanticFilter';
import { createToolSelector, type AttemptFn } from '@/process/toolselect/toolSelector';
import type { ICatalog } from '@/process/toolselect/catalog';
import type { ISelectionLog, SelectionLogEntry } from '@/process/toolselect/selectionLog';
import type { Lease, LeaseRequest } from '@/process/resource/leaseTypes';

const ENTRIES: CatalogEntry[] = [
  {
    id: 'skill:pptx',
    source: 'skill',
    name: 'Create PowerPoint',
    description: 'Generate slide decks and presentations',
    keywords: ['ppt', 'slides', 'presentation'],
  },
  {
    id: 'skill:excel',
    source: 'skill',
    name: 'Edit Excel',
    description: 'Work with spreadsheets and tables',
    keywords: ['xlsx', 'spreadsheet'],
  },
  {
    id: 'mcp:browser_open',
    source: 'mcpTool',
    name: 'Open browser',
    description: 'Open a web page in a browser tab',
    keywords: ['web', 'url', 'navigate'],
    server: 'browser',
  },
  {
    id: 'mcp:transcribe',
    source: 'mcpTool',
    name: 'Transcribe media',
    description: 'Convert audio and video speech to text',
    keywords: ['audio', 'video', 'subtitle'],
  },
];

/** A catalog over a fixed entry list. */
const fakeCatalog = (entries: CatalogEntry[] = ENTRIES): ICatalog => ({
  refresh: async () => entries,
  list: async () => entries,
  get: async (id) => entries.find((e) => e.id === id),
});

/** A lease coordinator recording grant/release pairing. */
const fakeCoordinator = () => {
  const held = new Set<string>();
  let n = 0;
  const grants: LeaseRequest[] = [];
  return {
    coordinator: {
      requestLease: async (req: LeaseRequest): Promise<Lease> => {
        grants.push(req);
        const id = `l-${++n}`;
        held.add(id);
        return { id, kind: req.kind, grantedAt: n, estCostMB: req.estCostMB };
      },
      releaseLease: (id: string) => {
        held.delete(id);
      },
    },
    held,
    grants,
  };
};

/** A deterministic embedder: bag-of-chars vector over a small alphabet. */
const fakeEmbedder = (): Embedder => ({
  embed: async (texts) =>
    texts.map((text) => {
      const v = Array.from({ length: 26 }, () => 0);
      for (const ch of text.toLowerCase()) {
        const i = ch.charCodeAt(0) - 97;
        if (i >= 0 && i < 26) v[i] += 1;
      }
      return v;
    }),
});

/** An in-memory selection log. */
const fakeSelectionLog = (): ISelectionLog & { entries: SelectionLogEntry[] } => {
  const entries: SelectionLogEntry[] = [];
  return {
    entries,
    hashRequest: (r) => r.trim().toLowerCase(),
    record: async (request, chosen, succeeded) => {
      const entry: SelectionLogEntry = {
        requestHash: request.trim().toLowerCase(),
        requestSnippet: request,
        chosen,
        succeeded,
        at: Date.now(),
      };
      entries.unshift(entry);
      return entry;
    },
    recall: async (request) => entries.find((e) => e.requestHash === request.trim().toLowerCase() && e.succeeded),
    all: async () => entries,
  };
};

describe('keywordFilter (Tier 1)', () => {
  it('ranks entries whose name/keywords/description overlap the request', () => {
    const result = keywordFilter('make a presentation slide deck', ENTRIES);
    expect(result[0]?.entry.id).toBe('skill:pptx');
    expect(result[0]?.reason).toMatch(/keyword match/);
  });

  it('returns nothing for a request with no overlap', () => {
    expect(keywordFilter('xyzzy quux', ENTRIES)).toEqual([]);
  });

  it('honours the limit', () => {
    const result = keywordFilter('web spreadsheet presentation audio', ENTRIES, { limit: 2 });
    expect(result.length).toBeLessThanOrEqual(2);
  });
});

describe('semanticFilter (Tier 2)', () => {
  it('indexes + ranks under a semanticIndex lease, balanced', async () => {
    const { coordinator, held, grants } = fakeCoordinator();
    const filter = createSemanticFilter({ embedder: fakeEmbedder(), coordinator });

    await filter.index(ENTRIES);
    const ranked = await filter.rank('audio video transcription', 2);

    expect(ranked.length).toBe(2);
    expect(ranked[0]?.reason).toBe('semantic similarity');
    expect(grants.every((g) => g.kind === 'semanticIndex')).toBe(true);
    expect(held.size).toBe(0); // all leases released
  });

  it('returns empty when nothing is indexed', async () => {
    const { coordinator } = fakeCoordinator();
    const filter = createSemanticFilter({ embedder: fakeEmbedder(), coordinator });
    expect(await filter.rank('anything')).toEqual([]);
  });
});

describe('toolSelector select → try → re-select loop', () => {
  it('returns the first candidate that succeeds and logs it', async () => {
    const log = fakeSelectionLog();
    const selector = createToolSelector({ catalog: fakeCatalog(), selectionLog: log, topK: 3 });
    const attempt: AttemptFn = vi.fn(async (entry) => ({ ok: entry.id === 'skill:pptx' }));

    const result = await selector.select('build a presentation', attempt);

    expect(result.succeeded).toBe(true);
    expect(result.chosen?.id).toBe('skill:pptx');
    expect(log.entries[0]?.succeeded).toBe(true);
    expect(log.entries[0]?.chosen).toEqual(['skill:pptx']);
  });

  it('re-selects on failure and respects the round limit', async () => {
    const log = fakeSelectionLog();
    // All attempts fail → loop exhausts maxRounds and records a failure.
    const selector = createToolSelector({ catalog: fakeCatalog(), selectionLog: log, topK: 4, maxRounds: 2 });
    const attempt: AttemptFn = vi.fn(async () => ({ ok: false }));

    const result = await selector.select('web spreadsheet presentation audio', attempt);

    expect(result.succeeded).toBe(false);
    expect(result.tried.length).toBeLessThanOrEqual(2); // round limit
    expect(attempt).toHaveBeenCalledTimes(result.tried.length);
    expect(log.entries[0]?.succeeded).toBe(false);
  });

  it('uses the recall fast path when a prior successful choice exists', async () => {
    const log = fakeSelectionLog();
    await log.record('open a website', ['mcp:browser_open'], true);
    const selector = createToolSelector({ catalog: fakeCatalog(), selectionLog: log, topK: 3 });
    const attempt: AttemptFn = vi.fn(async () => ({ ok: true }));

    const result = await selector.select('open a website', attempt);

    expect(result.fromRecall).toBe(true);
    expect(result.chosen?.id).toBe('mcp:browser_open');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
