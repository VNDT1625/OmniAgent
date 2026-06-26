/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for process/ide/memory/sessionMemoryStore — the EPHEMERAL, per-IDE
 * session super-memory. Every collaborator is injected (summariser, clock, token
 * estimator) so the forced-compaction policy is fully deterministic: no model,
 * no real time, no disk. Covers:
 *  - remember / recall round-trip + ordering;
 *  - FORCED compaction when the token budget is crossed (oldest folded, pinned +
 *    recent kept verbatim, a single summary note produced);
 *  - secrets are session-only, never surfaced in snapshots;
 *  - clearSession wipes everything (the "close the tab → memory gone" contract).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createSessionMemoryStore,
  heuristicSummarizer,
  type SuperMemoryItem,
} from '@/process/ide/memory/sessionMemoryStore';
import { createLocalEmbedder } from '@/process/ide/memory/embedding';

/** A deterministic summariser that records what it was asked to fold. */
const fakeSummarizer = () => {
  const calls: SuperMemoryItem[][] = [];
  const fn = vi.fn(async (items: SuperMemoryItem[]) => {
    calls.push(items);
    return `SUMMARY(${items.length})`;
  });
  return { fn, calls };
};

describe('createSessionMemoryStore — remember / recall', () => {
  it('remembers a note and recalls it for the same session', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    const { item } = await store.remember('s1', { text: 'remember me', kind: 'fact' });
    expect(item.id).toBe('m1');
    expect(item.kind).toBe('fact');

    const recall = store.recall('s1');
    expect(recall.recent.map((r) => r.text)).toEqual(['remember me']);
  });

  it('isolates sessions from one another', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    await store.remember('a', { text: 'in a' });
    await store.remember('b', { text: 'in b' });
    expect(store.recall('a').recent.map((r) => r.text)).toEqual(['in a']);
    expect(store.recall('b').recent.map((r) => r.text)).toEqual(['in b']);
  });

  it('filters recent notes by a case-insensitive query', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    await store.remember('s1', { text: 'login flow uses cookies' });
    await store.remember('s1', { text: 'payments use stripe' });
    const recall = store.recall('s1', { query: 'STRIPE' });
    expect(recall.recent.map((r) => r.text)).toEqual(['payments use stripe']);
  });

  it('rejects empty text', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    await expect(store.remember('s1', { text: '   ' })).rejects.toThrow(/empty/);
  });

  it('requires a sessionId', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    await expect(store.remember('', { text: 'x' })).rejects.toThrow(/sessionId/);
  });
});

describe('createSessionMemoryStore — forced compaction', () => {
  it('folds the oldest notes into one summary when the token budget is crossed', async () => {
    const { fn, calls } = fakeSummarizer();
    // Tiny budget + keepRecent so a few notes trip compaction deterministically.
    const store = createSessionMemoryStore({
      summarizer: fn,
      policy: { tokenBudget: 10, keepRecent: 2 },
      estimateTokens: () => 4, // each note costs 4 tokens
    });

    await store.remember('s1', { text: 'one' });
    await store.remember('s1', { text: 'two' });
    const third = await store.remember('s1', { text: 'three' }); // 12 > 10 → compact

    expect(third.compacted).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    // Only the oldest beyond keepRecent (=2) is folded → just "one".
    expect(calls[0].map((i) => i.text)).toEqual(['one']);

    const snap = store.snapshot('s1');
    const summaries = snap.items.filter((i) => i.kind === 'summary');
    expect(summaries).toHaveLength(1);
    expect(summaries[0].text).toBe('SUMMARY(1)');
    // The two most-recent notes are kept verbatim.
    expect(snap.items.filter((i) => i.kind !== 'summary').map((i) => i.text)).toEqual(['two', 'three']);
  });

  it('never folds pinned notes', async () => {
    const { fn } = fakeSummarizer();
    const store = createSessionMemoryStore({
      summarizer: fn,
      policy: { tokenBudget: 8, keepRecent: 0 },
      estimateTokens: () => 4,
    });

    await store.remember('s1', { text: 'critical', pinned: true });
    await store.remember('s1', { text: 'filler 1' });
    await store.remember('s1', { text: 'filler 2' });

    const snap = store.snapshot('s1');
    // The pinned note must still be present verbatim after compaction.
    expect(snap.items.some((i) => i.pinned && i.text === 'critical')).toBe(true);
  });

  it('does not compact while under budget', async () => {
    const { fn } = fakeSummarizer();
    const store = createSessionMemoryStore({ summarizer: fn, policy: { tokenBudget: 1000 } });
    const res = await store.remember('s1', { text: 'small note' });
    expect(res.compacted).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('createSessionMemoryStore — secrets (session-only)', () => {
  it('round-trips a secret value but never exposes it in a snapshot', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    store.setSecret('s1', 'API_KEY', 'super-secret');
    expect(store.getSecret('s1', 'API_KEY')).toBe('super-secret');

    const snap = store.snapshot('s1');
    expect(snap.secretKeys).toEqual(['API_KEY']);
    expect(JSON.stringify(snap)).not.toContain('super-secret');
  });

  it('deletes a secret', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    store.setSecret('s1', 'K', 'v');
    expect(store.deleteSecret('s1', 'K')).toBe(true);
    expect(store.getSecret('s1', 'K')).toBeUndefined();
  });
});

describe('createSessionMemoryStore — ephemeral lifecycle', () => {
  it('clearSession wipes notes + secrets (close the tab → memory gone)', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    await store.remember('s1', { text: 'note' });
    store.setSecret('s1', 'K', 'v');
    expect(store.listSessions()).toContain('s1');

    store.clearSession('s1');

    expect(store.listSessions()).not.toContain('s1');
    expect(store.recall('s1').recent).toEqual([]);
    expect(store.getSecret('s1', 'K')).toBeUndefined();
    const snap = store.snapshot('s1');
    expect(snap.items).toEqual([]);
    expect(snap.tokensUsed).toBe(0);
  });

  it('forget removes a single note by id', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    const { item } = await store.remember('s1', { text: 'gone soon' });
    expect(store.forget('s1', item.id)).toBe(true);
    expect(store.forget('s1', item.id)).toBe(false);
    expect(store.recall('s1').recent).toEqual([]);
  });
});

describe('createSessionMemoryStore — semantic recall (local embedder)', () => {
  it('recalls a sub-word-related note that pure substring search would miss', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x', embedder: createLocalEmbedder() });
    await store.remember('s1', { text: 'the auth module lives in src/auth.ts' });
    await store.remember('s1', { text: 'payment processing uses stripe' });

    // Query word "authentication" is NOT a substring of any note, yet the
    // semantic embedder RANKS the "auth" note above the unrelated payment one.
    const recall = store.recall('s1', { query: 'authentication flow' });
    expect(recall.recent.length).toBeGreaterThan(0);
    expect(recall.recent[0].text).toContain('auth module');
    const authIdx = recall.recent.findIndex((r) => r.text.includes('auth module'));
    const stripeIdx = recall.recent.findIndex((r) => r.text.includes('stripe'));
    if (stripeIdx >= 0) expect(authIdx).toBeLessThan(stripeIdx);
  });

  it('falls back to lexical recall when no embedder is configured', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    await store.remember('s1', { text: 'login uses cookies' });
    await store.remember('s1', { text: 'payments use stripe' });
    const recall = store.recall('s1', { query: 'stripe' });
    expect(recall.recent.map((r) => r.text)).toEqual(['payments use stripe']);
  });

  it('keeps the embedding index in sync after forget', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x', embedder: createLocalEmbedder() });
    const { item } = await store.remember('s1', { text: 'auth token rotation policy' });
    store.forget('s1', item.id);
    // After forgetting the only note, a related query returns nothing.
    expect(store.recall('s1', { query: 'authentication' }).recent).toEqual([]);
  });
});

describe('createSessionMemoryStore — hybrid recall (semantic + lexical + phrase)', () => {
  it('ranks the note containing the exact query phrase first', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x', embedder: createLocalEmbedder() });
    await store.remember('s1', { text: 'database connection pooling settings' }); // exact phrase
    await store.remember('s1', { text: 'pooling of connections and database tuning' }); // related, no exact phrase

    const recall = store.recall('s1', { query: 'connection pooling' });
    expect(recall.recent[0].text).toBe('database connection pooling settings');
  });
});

describe('createSessionMemoryStore — meta-summary keeps long sessions bounded', () => {
  it('collapses old summaries so token usage does not grow without bound', async () => {
    const store = createSessionMemoryStore({
      summarizer: async (items) => `S${items.length}`,
      policy: { tokenBudget: 25, keepRecent: 0, maxNoteTokens: 1000 },
      estimateTokens: () => 10,
    });
    for (let i = 0; i < 40; i++) await store.remember('s1', { text: `distinct note number ${i} tagx${i}` });

    const snap = store.snapshot('s1');
    const summaries = snap.items.filter((i) => i.kind === 'summary');
    // Without meta-summary, 40 notes → many summaries; with it, summaries stay tiny.
    expect(summaries.length).toBeLessThanOrEqual(4);
    expect(snap.tokensUsed).toBeLessThanOrEqual(40);
  });
});

describe('createSessionMemoryStore — pinned cap (avoids budget lock)', () => {
  it('auto-unpins the oldest pinned notes beyond the cap', async () => {
    const store = createSessionMemoryStore({
      summarizer: async () => 'x',
      policy: { maxPinned: 3, tokenBudget: 100000 },
    });
    for (let i = 0; i < 5; i++)
      await store.remember('s1', { text: `critical pinned fact number ${i} uniq${i}`, pinned: true });

    const snap = store.snapshot('s1');
    expect(snap.items.filter((i) => i.pinned)).toHaveLength(3);
    expect(snap.items).toHaveLength(5); // unpinned ones are still present, just foldable now
  });
});

describe('heuristicSummarizer', () => {
  it('condenses notes into a labelled block without a model', async () => {
    const summarize = heuristicSummarizer();
    const text = await summarize([
      {
        id: 'm1',
        text: 'First fact. Extra detail.',
        kind: 'fact',
        pinned: false,
        createdAt: 1,
        tokens: 5,
        accessCount: 0,
        lastAccessedAt: 1,
      },
      {
        id: 'm2',
        text: 'Second note',
        kind: 'note',
        pinned: false,
        createdAt: 2,
        tokens: 3,
        accessCount: 0,
        lastAccessedAt: 2,
      },
    ]);
    expect(text).toContain('Summary of 2 earlier note(s):');
    expect(text).toContain('[fact] First fact.');
    expect(text).toContain('[note] Second note');
  });
});

describe('createSessionMemoryStore — de-duplication (consolidate on write)', () => {
  it('merges a near-identical note instead of appending a duplicate', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    const first = await store.remember('s1', { text: 'Auth lives in src/auth.ts' });
    const dup = await store.remember('s1', { text: 'auth lives in src/auth.ts' }); // case-only diff

    expect(dup.deduped).toBe(true);
    expect(dup.item.id).toBe(first.item.id); // same note refreshed, not a new id
    const snap = store.snapshot('s1');
    expect(snap.items.filter((i) => i.kind !== 'summary')).toHaveLength(1);
    expect(snap.deduped).toBe(1);
  });

  it('keeps the richer (longer) text when a duplicate carries more detail', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    await store.remember('s1', { text: 'cache uses redis' });
    await store.remember('s1', { text: 'cache uses redis with a 60s TTL' });
    const texts = store.snapshot('s1').items.map((i) => i.text);
    expect(texts).toContain('cache uses redis with a 60s TTL');
    expect(texts).not.toContain('cache uses redis');
  });

  it('does not merge unrelated notes', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    await store.remember('s1', { text: 'login uses cookies' });
    const second = await store.remember('s1', { text: 'payments use stripe webhooks' });
    expect(second.deduped).toBe(false);
    expect(store.snapshot('s1').items.filter((i) => i.kind !== 'summary')).toHaveLength(2);
  });
});

describe('createSessionMemoryStore — salience-based eviction', () => {
  it('folds the LEAST-accessed note first, keeping frequently-recalled ones', async () => {
    const { fn, calls } = fakeSummarizer();
    const store = createSessionMemoryStore({
      summarizer: fn,
      policy: { tokenBudget: 12, keepRecent: 2 },
      estimateTokens: () => 4,
    });

    await store.remember('s1', { text: 'alpha note' });
    await store.remember('s1', { text: 'beta note' });
    // Recall "alpha" many times so it gains salience over beta despite being older.
    for (let i = 0; i < 5; i++) store.recall('s1', { query: 'alpha' });
    await store.remember('s1', { text: 'gamma note' }); // 12 tokens for 3 → over budget? 12>12 false
    await store.remember('s1', { text: 'delta note' }); // now 4 notes → over budget → fold

    // The frequently-recalled "alpha" must survive verbatim.
    const surviving = store
      .snapshot('s1')
      .items.filter((i) => i.kind !== 'summary')
      .map((i) => i.text);
    expect(surviving).toContain('alpha note');
    // The folded batch must NOT include alpha.
    const folded = calls.flat().map((i) => i.text);
    expect(folded).not.toContain('alpha note');
  });
});

describe('createSessionMemoryStore — token-bounded recall', () => {
  it('caps the recall payload to the recall token budget', async () => {
    const store = createSessionMemoryStore({
      summarizer: async () => 'x',
      policy: { recallTokenBudget: 20, recallRecent: 100, tokenBudget: 100000 },
      estimateTokens: () => 8, // each note costs 8 tokens → at most 2 fit in 20
    });
    for (let i = 0; i < 10; i++) await store.remember('s1', { text: `note number ${i} alpha` });
    const recall = store.recall('s1');
    expect(recall.recent.length).toBeLessThanOrEqual(3);
    expect(recall.tokens).toBeLessThanOrEqual(24); // budget + one boundary note
  });

  it('reports the token size of the returned block', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x', estimateTokens: () => 5 });
    await store.remember('s1', { text: 'one' });
    const recall = store.recall('s1');
    expect(recall.tokens).toBe(5);
  });
});

describe('defaultEstimateTokens (via store, no override)', () => {
  it('counts CJK and code more realistically than chars/4', async () => {
    const store = createSessionMemoryStore({ summarizer: async () => 'x' });
    const res = await store.remember('s1', { text: 'const x = 1;' });
    // chars/4 would be 3; the word/punct counter yields a higher, safer estimate.
    expect(res.item.tokens).toBeGreaterThan(3);
  });
});

describe('createSessionMemoryStore — oversized note clamp', () => {
  it('truncates a note that exceeds the per-note token cap', async () => {
    const store = createSessionMemoryStore({
      summarizer: async () => 'x',
      policy: { maxNoteTokens: 10 },
      estimateTokens: (t) => t.length, // 1 token per char for an easy threshold
    });
    const res = await store.remember('s1', { text: 'x'.repeat(100) });
    expect(res.truncated).toBe(true);
    expect(res.item.text).toContain('…[truncated]');
    expect(res.item.tokens).toBeLessThanOrEqual(25);
  });
});

describe('createSessionMemoryStore — concurrency safety (no lost writes)', () => {
  it('serialises concurrent remember() so no note is lost during compaction', async () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const foldedIds = new Set<string>();
    // A SLOW async summariser maximises the interleave window that an unguarded
    // store would corrupt (state.items is rebuilt across an await during fold).
    const summarizer = vi.fn(async (items: SuperMemoryItem[]) => {
      await delay(1);
      for (const it of items) foldedIds.add(it.id);
      return `S(${items.length})`;
    });
    const store = createSessionMemoryStore({
      summarizer,
      policy: { tokenBudget: 30, keepRecent: 2, maxNoteTokens: 1000 },
      estimateTokens: () => 10, // force frequent compaction
    });

    // Fire many DISTINCT writes at once on the same session.
    const writes = Array.from({ length: 25 }, (_, i) =>
      store.remember('s1', { text: `distinct note number ${i} alpha beta gamma` })
    );
    const results = await Promise.all(writes);

    const createdIds = results.map((r) => r.item.id);
    expect(new Set(createdIds).size).toBe(25); // all distinct, none deduped
    expect(results.every((r) => r.deduped === false)).toBe(true);

    const surviving = new Set(
      store
        .snapshot('s1')
        .items.filter((i) => i.kind !== 'summary')
        .map((i) => i.id)
    );
    // Invariant: every created note is either still present OR was folded — never lost.
    for (const id of createdIds) {
      expect(surviving.has(id) || foldedIds.has(id)).toBe(true);
    }
  });
});
