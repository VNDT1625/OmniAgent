/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/browser/research/deepResearch — the multi-source
 * research pipeline. Browser, chat and lease gate are all in-memory stubs, so
 * these tests assert: planning, parallel search + dedup, bounded source reads
 * under a balanced lease, citation synthesis, the reflection round, and the
 * empty-input short-circuit.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createDeepResearch,
  normalizeForDedup,
  parseSubQueries,
  type ResearchBrowser,
  type ResearchChat,
  type ResearchLeaseGate,
  type SearchHit,
} from '@/process/browser/research/deepResearch';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

/** A lease gate that counts grants/releases so tests can assert balance. */
const countingGate = (): ResearchLeaseGate & { granted: () => number; released: () => number } => {
  let granted = 0;
  let released = 0;
  let n = 0;
  return {
    requestLease: async () => {
      granted += 1;
      return { id: `lease-${++n}` } as Awaited<ReturnType<ResearchLeaseGate['requestLease']>>;
    },
    releaseLease: () => {
      released += 1;
    },
    granted: () => granted,
    released: () => released,
  };
};

/** A browser stub with scripted search results and per-url page text. */
const stubBrowser = (
  searchMap: Record<string, SearchHit[]>,
  pageText: Record<string, string>
): ResearchBrowser & { reads: string[] } => {
  const reads: string[] = [];
  return {
    reads,
    search: vi.fn(async (query: string) => searchMap[query] ?? []),
    readSource: vi.fn(async (url: string) => {
      reads.push(url);
      return { title: `Title ${url}`, text: pageText[url] ?? '' };
    }),
  };
};

/** A chat stub that routes by the system prompt's role (plan/digest/synthesize/reflect). */
const routedChat = (opts: { plan: string; digest?: string; synthesis?: string; reflect?: string }): ResearchChat => {
  return async ({ messages }) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    if (system.includes('research planner')) return opts.plan;
    if (system.includes('extract only the facts')) return opts.digest ?? 'a relevant fact';
    if (system.includes('research analyst')) return opts.synthesis ?? 'Answer with citation [1].';
    if (system.includes('audit a draft')) return opts.reflect ?? '[]';
    return '';
  };
};

describe('normalizeForDedup', () => {
  it('drops hash + trailing slash and lowercases host', () => {
    expect(normalizeForDedup('https://Example.com/a/#frag')).toBe('https://example.com/a');
    expect(normalizeForDedup('https://example.com/a/')).toBe('https://example.com/a');
  });
});

describe('parseSubQueries', () => {
  it('parses a JSON array', () => {
    expect(parseSubQueries('["one","two"]', 'q', 4)).toEqual(['one', 'two']);
  });

  it('parses a numbered/bulleted list and dedupes', () => {
    expect(parseSubQueries('1. alpha\n- beta\nalpha', 'q', 4)).toEqual(['alpha', 'beta']);
  });

  it('falls back to the question when nothing usable', () => {
    expect(parseSubQueries('', 'the question', 4)).toEqual(['the question']);
  });

  it('bounds the count to max', () => {
    expect(parseSubQueries('["a","b","c","d","e"]', 'q', 2)).toEqual(['a', 'b']);
  });
});

describe('createDeepResearch', () => {
  it('short-circuits empty input', async () => {
    const dr = createDeepResearch({
      browser: stubBrowser({}, {}),
      chat: routedChat({ plan: '[]' }),
      coordinator: countingGate(),
    });
    const result = await dr.research('   ', { model: 'm' });
    expect(result).toEqual({ answer: '', sources: [], subQueries: [] });
  });

  it('plans, searches, reads sources under a balanced lease, and synthesizes with citations', async () => {
    const browser = stubBrowser(
      {
        'sub one': [{ url: 'https://a.com/x', title: 'A' }],
        'sub two': [{ url: 'https://b.com/y', title: 'B' }],
      },
      { 'https://a.com/x': 'content from A', 'https://b.com/y': 'content from B' }
    );
    const gate = countingGate();
    const dr = createDeepResearch({
      browser,
      chat: routedChat({ plan: '["sub one","sub two"]', synthesis: 'Synthesised answer [1][2].', reflect: '[]' }),
      coordinator: gate,
      reflect: true,
    });

    const result = await dr.research('main question', { model: 'm' });

    expect(result.subQueries).toEqual(['sub one', 'sub two']);
    expect(result.answer).toContain('[1]');
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].index).toBe(1);
    // Every read acquired and released exactly one lease.
    expect(gate.granted()).toBe(browser.reads.length);
    expect(gate.released()).toBe(gate.granted());
  });

  it('dedupes identical result URLs across sub-queries', async () => {
    const browser = stubBrowser(
      {
        q1: [{ url: 'https://dup.com/p', title: 'Dup' }],
        q2: [{ url: 'https://dup.com/p/', title: 'Dup again' }],
      },
      { 'https://dup.com/p': 'shared content' }
    );
    const dr = createDeepResearch({
      browser,
      chat: routedChat({ plan: '["q1","q2"]', reflect: '[]' }),
      coordinator: countingGate(),
      reflect: false,
    });

    const result = await dr.research('q', { model: 'm' });
    // The duplicate URL is only read once.
    expect(browser.reads).toHaveLength(1);
    expect(result.sources).toHaveLength(1);
  });

  it('runs a reflection round to fill gaps and re-synthesizes', async () => {
    const browser = stubBrowser(
      {
        base: [{ url: 'https://a.com/1', title: 'A' }],
        gap: [{ url: 'https://c.com/2', title: 'C' }],
      },
      { 'https://a.com/1': 'first content', 'https://c.com/2': 'gap-filling content' }
    );
    const synth = vi.fn();
    const chat: ResearchChat = async ({ messages }) => {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      if (system.includes('research planner')) return '["base"]';
      if (system.includes('extract only the facts')) return 'a fact';
      if (system.includes('audit a draft')) return '["gap"]';
      if (system.includes('research analyst')) {
        synth();
        return 'answer [1]';
      }
      return '';
    };
    const dr = createDeepResearch({ browser, chat, coordinator: countingGate(), reflect: true });

    const result = await dr.research('q', { model: 'm' });
    // Synthesis ran twice (draft + after reflection) and both sources are cited.
    expect(synth).toHaveBeenCalledTimes(2);
    expect(result.sources).toHaveLength(2);
    expect(browser.reads).toEqual(['https://a.com/1', 'https://c.com/2']);
  });

  it('drops sources the model marks IRRELEVANT', async () => {
    const browser = stubBrowser(
      {
        q: [
          { url: 'https://keep.com', title: 'Keep' },
          { url: 'https://drop.com', title: 'Drop' },
        ],
      },
      { 'https://keep.com': 'useful', 'https://drop.com': 'noise' }
    );
    const chat: ResearchChat = async ({ messages }) => {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      if (system.includes('research planner')) return '["q"]';
      if (system.includes('extract only the facts'))
        return user.includes('https://drop.com') || user.includes('noise') ? 'IRRELEVANT' : 'useful fact';
      if (system.includes('research analyst')) return 'answer [1]';
      return '[]';
    };
    const dr = createDeepResearch({ browser, chat, coordinator: countingGate(), reflect: false });

    const result = await dr.research('q', { model: 'm' });
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].url).toBe('https://keep.com');
  });
});
