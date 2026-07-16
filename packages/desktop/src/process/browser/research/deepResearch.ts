/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Deep, multi-source web research for the embedded browser agent.
 *
 * The plain `research` tool opens ONE hidden tab, reads a single search-results
 * page, and stops — a shallow lookup. `deepResearch` performs the full pipeline
 * a "deep research" feature (Perplexity / Gemini Deep Research) is expected to:
 *
 *   1. **Plan** — decompose the question into a handful of sub-queries via the
 *      model (falls back to the raw question when planning yields nothing).
 *   2. **Search** — for each sub-query, open a HIDDEN background tab on a search
 *      engine and extract the top organic result links (never touches the tab
 *      the user is watching).
 *   3. **Read** — open each unique result in a HIDDEN tab and extract its MAIN
 *      content (readability), not the whole noisy DOM. Fan-out is bounded and
 *      gated so the machine never thrashes.
 *   4. **Reduce** — summarise each source faithfully, then synthesise one answer
 *      with **inline citations** `[n]` mapped to a numbered source list.
 *   5. (optional) **Reflect** — ask the model what is still missing, run a small
 *      second search round to fill the gaps, then re-synthesise.
 *
 * ## This module is an ORCHESTRATION layer
 *
 * It owns the pipeline and the budget bounds, but holds **no** real browser,
 * model or DOM code. Every collaborator is injected:
 *  - {@link ResearchBrowser} — open/read/close a hidden tab (production: the
 *    browser view manager + readability);
 *  - {@link ResearchChat} — the model call (same shape as the runner's chat);
 *  - {@link ResearchLeaseGate} — the ResourceCoordinator, so each heavy hidden
 *    tab runs under a lease (criterion 1.9 / `performance` skill) and the
 *    machine is never overloaded.
 *
 * This keeps the module fully unit-testable with in-memory stubs (no Electron,
 * no network) and mirrors the DI + factory style of `mediaPipeline.ts`.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { Lease, LeaseRequest, TaskKind } from '../../resource/leaseTypes';

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/** A single organic search result discovered for a sub-query. */
export type SearchHit = {
  /** Absolute URL of the result. */
  url: string;
  /** The result's link/anchor title, when available. */
  title: string;
};

/** The readable content pulled from one opened source page. */
export type SourceContent = {
  /** The page title (readability title, else the search-hit title). */
  title: string;
  /** The main article/body text (readability-extracted, may be empty). */
  text: string;
};

/**
 * The browser surface deep research drives. Production wires this over the
 * browser view manager + readability extraction, ALWAYS in hidden tabs so the
 * user's visible tab is never disturbed. Each method must be self-contained
 * (open → act → close) and resolve even on failure (empty result), so one bad
 * page never aborts the whole run.
 */
export type ResearchBrowser = {
  /**
   * Run `query` on a search engine in a HIDDEN tab and return the top organic
   * result links (most relevant first). Resolve `[]` on any failure.
   *
   * @param query The search query.
   * @param limit Max number of hits to return.
   */
  search(query: string, limit: number): Promise<SearchHit[]>;
  /**
   * Open `url` in a HIDDEN tab, extract its main readable content, then close
   * the tab. Resolve with empty text on any failure.
   *
   * @param url The page to read.
   */
  readSource(url: string): Promise<SourceContent>;
};

/**
 * The chat-completion call used for planning / per-source summarising /
 * synthesis. Structurally compatible with the runner's `AgentChat`, so the
 * production provider-backed chat is passed directly; tests inject a stub.
 */
export type ResearchChat = (params: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  signal?: AbortSignal;
}) => Promise<string>;

/**
 * Minimal subset of the ResourceCoordinator used to gate heavy hidden-tab work.
 * The real `IResourceCoordinator` satisfies this structurally. Mirrors
 * `mediaPipeline.ts` / `pagePerception.ts`.
 */
export type ResearchLeaseGate = {
  /** Request a lease for a heavy task; resolves when the budget allows. */
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  /** Release a previously granted lease by id. */
  releaseLease: (id: string) => void;
};

// ---------------------------------------------------------------------------
// Public data models
// ---------------------------------------------------------------------------

/** A numbered source that backs the final answer (rendered as the citation list). */
export type ResearchSource = {
  /** 1-based citation index referenced as `[n]` in the answer. */
  index: number;
  /** Source page title. */
  title: string;
  /** Source URL. */
  url: string;
};

/** Options controlling one {@link IDeepResearch.research} run. */
export type DeepResearchOptions = {
  /** Model id driving planning / summarising / synthesis. */
  model: string;
  /** Language to write the final answer in (e.g. 'vi'). Optional. */
  language?: string;
  /** Abort signal threaded into every model call. */
  signal?: AbortSignal;
};

/** The result of a deep-research run. */
export type DeepResearchResult = {
  /** The synthesised answer, with inline `[n]` citations. */
  answer: string;
  /** The numbered sources the answer cites (for a reference list). */
  sources: ResearchSource[];
  /** The sub-queries the planner produced (for transparency / UI narration). */
  subQueries: string[];
};

/** A progress note emitted as the run advances (so the UI can show live status). */
export type ResearchProgress =
  /** The planner produced its sub-queries. */
  | { phase: 'planned'; subQueries: string[] }
  /** A sub-query search returned hits. */
  | { phase: 'searched'; query: string; hits: number }
  /** A source page is being read (1-based of total). */
  | { phase: 'reading'; index: number; total: number; url: string }
  /** A reflection round started to fill gaps. */
  | { phase: 'reflecting' }
  /** The final synthesis is being produced. */
  | { phase: 'synthesizing'; sources: number };

/** Callback the runner passes to stream {@link ResearchProgress} into the chat narration. */
export type ResearchProgressSink = (progress: ResearchProgress) => void;

/** Public contract of the deep-research orchestrator. */
export type IDeepResearch = {
  /**
   * Research `question` end-to-end and return a cited answer. `onProgress` (if
   * given) receives live phase updates. Never rejects on individual source
   * failures; rejects only on a fatal model error or abort.
   */
  research(
    question: string,
    options: DeepResearchOptions,
    onProgress?: ResearchProgressSink
  ): Promise<DeepResearchResult>;
};

/** Dependencies and tunables for {@link createDeepResearch}. */
export type DeepResearchDeps = {
  /** The hidden-tab browser surface (search + read). */
  browser: ResearchBrowser;
  /** The model call for plan / summarise / synthesize. */
  chat: ResearchChat;
  /** Lease gate; each hidden-tab read runs under a lease (criterion 1.9). */
  coordinator: ResearchLeaseGate;
  /** Lease kind charged per hidden-tab read. Defaults to `'agent'`. */
  leaseKind?: TaskKind;
  /** Estimated RAM (MB) charged per hidden-tab read. Defaults to 256. */
  estCostMB?: number;
  /** Max sub-queries the planner may produce. Default 4. */
  maxSubQueries?: number;
  /** Max search hits taken per sub-query. Default 3. */
  hitsPerQuery?: number;
  /** Max source pages actually opened+read in a run (hard ceiling). Default 6. */
  maxSources?: number;
  /** How many source reads run concurrently. Default 3. */
  concurrency?: number;
  /** Max characters of per-source text fed into synthesis. Default 2000. */
  perSourceChars?: number;
  /** Whether to run one reflection round to fill gaps. Default true. */
  reflect?: boolean;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LEASE_KIND: TaskKind = 'agent';
const DEFAULT_EST_COST_MB = 256;
const DEFAULT_MAX_SUBQUERIES = 4;
const DEFAULT_HITS_PER_QUERY = 3;
const DEFAULT_MAX_SOURCES = 6;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_PER_SOURCE_CHARS = 2000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Normalise a URL for dedup: drop hash, trailing slash, and lowercase the host. */
export const normalizeForDedup = (url: string): string => {
  try {
    const u = new URL(url);
    u.hash = '';
    const host = u.host.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return url.trim();
  }
};

/**
 * Parse the model's planning reply into a clean list of sub-queries. Accepts a
 * JSON array, or a newline / numbered list; strips bullets, numbering and empty
 * lines; de-duplicates; bounds to `max`. Falls back to `[question]` when nothing
 * usable is produced.
 */
export const parseSubQueries = (reply: string, question: string, max: number): string[] => {
  const out: string[] = [];
  const push = (raw: string): void => {
    const clean = raw
      .replace(/^[\s\-*•\d.)\]]+/, '')
      .replace(/^["'`]|["'`]$/g, '')
      .trim();
    if (clean.length > 0 && !out.includes(clean)) out.push(clean);
  };
  // Try JSON array first.
  const match = reply.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const arr: unknown = JSON.parse(match[0]);
      if (Array.isArray(arr)) {
        for (const item of arr) if (typeof item === 'string') push(item);
      }
    } catch {
      // fall through to line parsing
    }
  }
  if (out.length === 0) {
    for (const line of reply.split('\n')) push(line);
  }
  const bounded = out.slice(0, Math.max(1, max));
  return bounded.length > 0 ? bounded : [question.trim()];
};

// ---------------------------------------------------------------------------
// Prompt builders (pure)
// ---------------------------------------------------------------------------

const buildPlanPrompt = (question: string, max: number): Array<{ role: string; content: string }> => [
  {
    role: 'system',
    content: [
      'You are a research planner.',
      `Break the user's question into at most ${max} focused, non-overlapping web-search sub-queries.`,
      'Each sub-query should target a distinct facet needed to answer well.',
      'Reply with ONLY a JSON array of short query strings, e.g. ["a","b"]. No prose.',
    ].join('\n'),
  },
  { role: 'user', content: question },
];

const buildSourceSummaryPrompt = (
  question: string,
  source: SourceContent,
  chars: number
): Array<{ role: string; content: string }> => [
  {
    role: 'system',
    content: [
      'You extract only the facts from a source that help answer a research question.',
      'Be faithful: never invent. If the source is irrelevant, reply exactly "IRRELEVANT".',
      'Otherwise give a tight factual digest (no preamble).',
    ].join('\n'),
  },
  {
    role: 'user',
    content: `Question: ${question}\n\nSource title: ${source.title}\n\nSource content:\n${source.text.slice(0, chars)}`,
  },
];

const buildSynthesisPrompt = (
  question: string,
  digests: Array<{ index: number; title: string; url: string; digest: string }>,
  language: string | undefined
): Array<{ role: string; content: string }> => {
  const sourceBlock = digests.map((d) => `[${d.index}] ${d.title} — ${d.url}\n${d.digest}`).join('\n\n');
  const langLine =
    language && language.trim().length > 0
      ? `Write the answer in this language: ${language.trim()}.`
      : 'Write the answer in the same language as the question.';
  return [
    {
      role: 'system',
      content: [
        'You are a research analyst. Synthesise ONE coherent answer from the numbered sources below.',
        'Cite every non-obvious claim with an inline marker like [1] or [2][3] matching the source numbers.',
        'Do not invent facts or sources. Prefer agreement across sources; note disagreements.',
        'Structure: a short direct answer first, then supporting detail.',
        langLine,
      ].join('\n'),
    },
    { role: 'user', content: `Question: ${question}\n\nSources:\n${sourceBlock}` },
  ];
};

const buildReflectionPrompt = (
  question: string,
  answer: string,
  max: number
): Array<{ role: string; content: string }> => [
  {
    role: 'system',
    content: [
      'You audit a draft research answer for gaps.',
      `List at most ${max} NEW web-search sub-queries that would fill important gaps or verify weak claims.`,
      'If the answer is already well-supported and complete, reply with an empty JSON array [].',
      'Reply with ONLY a JSON array of query strings.',
    ].join('\n'),
  },
  { role: 'user', content: `Question: ${question}\n\nDraft answer:\n${answer}` },
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link IDeepResearch} from injected collaborators.
 *
 * @param deps Browser surface, chat, lease gate and tunables. See {@link DeepResearchDeps}.
 * @returns A ready-to-use deep-research orchestrator.
 */
export const createDeepResearch = (deps: DeepResearchDeps): IDeepResearch => {
  const { browser, chat, coordinator } = deps;
  const leaseKind = deps.leaseKind ?? DEFAULT_LEASE_KIND;
  const estCostMB = deps.estCostMB ?? DEFAULT_EST_COST_MB;
  const maxSubQueries = deps.maxSubQueries ?? DEFAULT_MAX_SUBQUERIES;
  const hitsPerQuery = deps.hitsPerQuery ?? DEFAULT_HITS_PER_QUERY;
  const maxSources = deps.maxSources ?? DEFAULT_MAX_SOURCES;
  const concurrency = Math.max(1, deps.concurrency ?? DEFAULT_CONCURRENCY);
  const perSourceChars = deps.perSourceChars ?? DEFAULT_PER_SOURCE_CHARS;
  const reflect = deps.reflect ?? true;

  /** Run one heavy hidden-tab read under a lease, always released in finally. */
  const underLease = async <T>(work: () => Promise<T>): Promise<T> => {
    const lease = await coordinator.requestLease({ kind: leaseKind, estCostMB });
    try {
      return await work();
    } finally {
      coordinator.releaseLease(lease.id);
    }
  };

  /** Plan sub-queries from the question (model), with a safe fallback. */
  const plan = async (question: string, options: DeepResearchOptions): Promise<string[]> => {
    try {
      const reply = await chat({
        model: options.model,
        messages: buildPlanPrompt(question, maxSubQueries),
        signal: options.signal,
      });
      return parseSubQueries(reply, question, maxSubQueries);
    } catch {
      return [question.trim()];
    }
  };

  /** Search every sub-query (parallel) and collect de-duplicated hits, capped at maxSources. */
  const gatherHits = async (
    queries: string[],
    seen: Set<string>,
    onProgress?: ResearchProgressSink
  ): Promise<SearchHit[]> => {
    const perQuery = await Promise.all(
      queries.map(async (query) => {
        const hits = await browser.search(query, hitsPerQuery).catch(() => [] as SearchHit[]);
        onProgress?.({ phase: 'searched', query, hits: hits.length });
        return hits;
      })
    );
    const collected: SearchHit[] = [];
    // Round-robin across sub-queries so one query can't monopolise the budget.
    let added = true;
    for (let rank = 0; added; rank++) {
      added = false;
      for (const hits of perQuery) {
        if (rank >= hits.length) continue;
        added = true;
        const hit = hits[rank];
        if (!hit?.url) continue;
        const key = normalizeForDedup(hit.url);
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(hit);
        if (collected.length >= maxSources) return collected;
      }
    }
    return collected;
  };

  /** Read sources with bounded concurrency, gated by the ResourceCoordinator. */
  const readSources = async (
    hits: SearchHit[],
    onProgress?: ResearchProgressSink
  ): Promise<Array<{ hit: SearchHit; content: SourceContent }>> => {
    const results: Array<{ hit: SearchHit; content: SourceContent }> = [];
    let cursor = 0;
    const total = hits.length;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= hits.length) return;
        const hit = hits[i];
        onProgress?.({ phase: 'reading', index: i + 1, total, url: hit.url });
        const content = await underLease(() => browser.readSource(hit.url)).catch(() => ({
          title: hit.title,
          text: '',
        }));
        results.push({ hit, content });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, hits.length) }, () => worker()));
    return results;
  };

  /** Summarise each source into a faithful digest, dropping irrelevant/empty ones. */
  const digestSources = async (
    question: string,
    read: Array<{ hit: SearchHit; content: SourceContent }>,
    options: DeepResearchOptions
  ): Promise<Array<{ index: number; title: string; url: string; digest: string }>> => {
    const digests: Array<{ index: number; title: string; url: string; digest: string }> = [];
    for (const { hit, content } of read) {
      if (content.text.trim().length === 0) continue;
      let digest = '';
      try {
        digest = (
          await chat({
            model: options.model,
            messages: buildSourceSummaryPrompt(question, content, perSourceChars),
            signal: options.signal,
          })
        ).trim();
      } catch {
        continue;
      }
      if (digest.length === 0 || /^irrelevant\b/i.test(digest)) continue;
      digests.push({ index: digests.length + 1, title: content.title || hit.title || hit.url, url: hit.url, digest });
    }
    return digests;
  };

  const research = async (
    question: string,
    options: DeepResearchOptions,
    onProgress?: ResearchProgressSink
  ): Promise<DeepResearchResult> => {
    const trimmed = question.trim();
    if (trimmed.length === 0) return { answer: '', sources: [], subQueries: [] };

    // 1. Plan.
    const subQueries = await plan(trimmed, options);
    onProgress?.({ phase: 'planned', subQueries });

    // 2. Search + 3. read (round 1).
    const seen = new Set<string>();
    const hits = await gatherHits(subQueries, seen, onProgress);
    const read = await readSources(hits, onProgress);
    let digests = await digestSources(trimmed, read, options);

    // 4. Synthesize a draft.
    onProgress?.({ phase: 'synthesizing', sources: digests.length });
    let answer =
      digests.length > 0
        ? (
            await chat({
              model: options.model,
              messages: buildSynthesisPrompt(trimmed, digests, options.language),
              signal: options.signal,
            })
          ).trim()
        : '';

    // 5. Reflect: one extra round to fill gaps, then re-synthesize.
    if (reflect && digests.length > 0 && seen.size < maxSources) {
      let gapQueries: string[] = [];
      try {
        const reply = await chat({
          model: options.model,
          messages: buildReflectionPrompt(trimmed, answer, maxSubQueries),
          signal: options.signal,
        });
        gapQueries = parseSubQueries(reply, '', maxSubQueries).filter((q) => q.length > 0 && q !== trimmed);
      } catch {
        gapQueries = [];
      }
      if (gapQueries.length > 0) {
        onProgress?.({ phase: 'reflecting' });
        const moreHits = await gatherHits(gapQueries, seen, onProgress);
        if (moreHits.length > 0) {
          const moreRead = await readSources(moreHits, onProgress);
          const moreDigests = await digestSources(trimmed, moreRead, options);
          if (moreDigests.length > 0) {
            // Re-number the merged digest set so citations stay contiguous.
            digests = [...digests, ...moreDigests].map((d, i) => ({ ...d, index: i + 1 }));
            onProgress?.({ phase: 'synthesizing', sources: digests.length });
            answer = (
              await chat({
                model: options.model,
                messages: buildSynthesisPrompt(trimmed, digests, options.language),
                signal: options.signal,
              })
            ).trim();
          }
        }
      }
    }

    const sources: ResearchSource[] = digests.map((d) => ({ index: d.index, title: d.title, url: d.url }));
    return { answer, sources, subQueries };
  };

  return { research };
};
