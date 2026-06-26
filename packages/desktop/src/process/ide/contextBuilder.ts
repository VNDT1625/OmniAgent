/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `contextBuilder` — the CORE of Omni's "agent understands code" engine.
 *
 * It sits between a user request ("fix the login button") and the coding agent,
 * and assembles a small, focused **context pack** ({@link ContextPack}) instead
 * of letting the agent read the whole repo. The point is the three things that
 * are really one thing: the agent becomes more accurate, far cheaper in tokens,
 * and faster — because it receives only the few functions that matter.
 *
 * ## Pipeline (deterministic, no LLM at module scope)
 *
 *   1. **Rank** — score every file against the request. A {@link Ranker} is
 *      injected: production wires a semantic (embedding) ranker; the default is
 *      a cheap lexical+graph ranker so the builder works with graph-only data
 *      and is unit-testable without embeddings.
 *   2. **Seed** — take the top-ranked files as entry points.
 *   3. **Graph-expand** — pull each seed's direct neighbours (what it imports +
 *      what imports it), 1 hop by default, so the agent sees the call chain.
 *   4. **Changed-boost** — if a diff is supplied (a recent regression), mark
 *      changed files so they surface even if lexically unrelated.
 *   5. **Trim + budget** — keep only the relevant symbols/file ranges and cap
 *      the total slice count, then render a compact retrieval guide.
 *
 * Everything is pure given its inputs + the injected ranker, so the same
 * request always yields the same pack (cacheable). No fs, no network here.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { ArchLayer, ContextPack, ContextSlice, GraphDiff, KnowledgeGraph, KnowledgeNode } from './understandTypes';
import { changedNodeIds } from './graphSnapshot';

/** A scored file id (higher = more relevant to the request). */
export type RankedFile = {
  /** Node id (relative path). */
  id: string;
  /** Relevance score in any positive range; only the ORDER matters. */
  score: number;
  /** Best matching source chunks when the ranker is backed by semantic indexing. */
  chunks?: ContextSlice['chunks'];
};

/**
 * Ranks graph nodes by relevance to a request. Injected so the builder is
 * decoupled from HOW relevance is computed: the default is lexical+graph
 * (no embeddings), production can pass a semantic ranker backed by the vector
 * store. Async because a real ranker embeds the query.
 */
export type Ranker = (request: string, nodes: readonly KnowledgeNode[]) => Promise<RankedFile[]>;

/** Tunables for {@link createContextBuilder}. */
export type ContextBuilderOptions = {
  /** Max files in the pack (budget). Default 12. */
  maxSlices?: number;
  /** Number of top-ranked files used as seeds before graph expansion. Default 5. */
  seedCount?: number;
  /** Graph-expansion hops from each seed (1 = direct neighbours). Default 1. */
  expandHops?: number;
  /** Max symbols shown per slice (keeps the brief compact). Default 12. */
  maxSymbolsPerSlice?: number;
};

/** Injected collaborators for {@link createContextBuilder}. */
export type ContextBuilderDeps = {
  /** Relevance ranker. Defaults to {@link lexicalGraphRanker}. */
  ranker?: Ranker;
};

/** Input for a single {@link ContextBuilder.build} call. */
export type BuildContextInput = {
  /** The user request to focus the pack on. */
  request: string;
  /** The repo's knowledge graph. */
  graph: KnowledgeGraph;
  /** Project rules (from `.aionrules` etc.) to prepend. Optional. */
  rules?: string[];
  /** A recent graph diff (regression context). Optional — boosts changed files. */
  diff?: GraphDiff | null;
};

/** Public contract of the context builder. */
export type ContextBuilder = {
  /** Assemble a focused {@link ContextPack} for one request. */
  build: (input: BuildContextInput) => Promise<ContextPack>;
};

// ---------------------------------------------------------------------------
// Default ranker — lexical + graph (no embeddings; the testable baseline)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'ai',
  'bang',
  'ban',
  'cai',
  'chao',
  'chua',
  'duoc',
  'hien',
  'lay',
  'nao',
  'nhu',
  'phan',
  'tai',
  'thay',
  'toi',
  'xin',
]);

const normalizeSearchText = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase → camel Case
    .toLowerCase();

/** Split text into lowercase word tokens (≥ 2 chars), incl. splitting camelCase/paths. */
const tokenize = (text: string): string[] =>
  normalizeSearchText(text)
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

const compactSearchText = (text: string): string => normalizeSearchText(text).replace(/[^a-z0-9]+/g, '');

const acronymOf = (text: string): string =>
  tokenize(text)
    .map((token) => token[0])
    .join('');

const isBoundary = (text: string, index: number): boolean => {
  if (index <= 0) return true;
  return /[^a-z0-9]/.test(text[index - 1]);
};

const fuzzySubsequenceScore = (query: string, text: string): number => {
  const q = compactSearchText(query);
  const target = normalizeSearchText(text);
  if (q.length === 0 || target.length === 0) return 0;
  let qi = 0;
  let first = -1;
  let last = -1;
  let score = 0;
  for (let ti = 0; ti < target.length && qi < q.length; ti += 1) {
    const char = target[ti];
    if (!/[a-z0-9]/.test(char) || char !== q[qi]) continue;
    if (first === -1) first = ti;
    score += 2;
    if (last === ti - 1) score += 3;
    if (isBoundary(target, ti)) score += 2;
    last = ti;
    qi += 1;
  }
  if (qi < q.length || first === -1 || last === -1) return 0;
  const spreadPenalty = Math.max(0, last - first + 1 - q.length) * 0.15;
  const startPenalty = Math.min(first, 40) * 0.03;
  return Math.max(0, score - spreadPenalty - startPenalty);
};

const bestFuzzyScore = (query: string, values: readonly string[]): number =>
  values.reduce((best, value) => Math.max(best, fuzzySubsequenceScore(query, value)), 0);

/** Adjacent query token pairs keep multi-word intent generic without a domain dictionary. */
const adjacentTokenPairs = (tokens: readonly string[]): string[] => {
  const pairs: string[] = [];
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (tokens[i] !== tokens[i + 1]) {
      pairs.push(`${tokens[i]} ${tokens[i + 1]}`);
    }
  }
  return pairs;
};

/** The searchable text of a node: path + label + summary + tags + symbol names. */
const nodeText = (node: KnowledgeNode): string =>
  [node.id, node.label, node.summary, node.tags.join(' '), node.symbols.map((s) => s.name).join(' ')].join(' ');

const pathTokenSet = (id: string): Set<string> => new Set(tokenize(id.replace(/\.[^./]+$/u, '')));

const symbolTokenSet = (node: KnowledgeNode): Set<string> =>
  new Set(tokenize(node.symbols.map((symbol) => symbol.name).join(' ')));

const queryWantsTests = (tokens: ReadonlySet<string>): boolean =>
  ['test', 'tests', 'spec', 'vitest', 'playwright', 'kiem', 'thu'].some((token) => tokens.has(token));

/**
 * Default {@link Ranker}: scores each node by lexical overlap with the request
 * (token frequency over path/label/summary/symbols), with a small in-degree
 * boost so hub files break ties. Deterministic, no embeddings — the baseline
 * that makes the builder work + testable before the vector store is wired.
 */
export const lexicalGraphRanker: Ranker = async (request, nodes) => {
  const orderedQueryTokens = tokenize(request);
  const queryTokens = new Set(orderedQueryTokens);
  if (queryTokens.size === 0) {
    // No usable query terms: fall back to importance (in-degree) ordering.
    return nodes.map((n) => ({ id: n.id, score: n.importedBy })).toSorted((a, b) => b.score - a.score);
  }
  const queryPhrases = adjacentTokenPairs(orderedQueryTokens);
  const compactQuery = orderedQueryTokens.join(' ');
  const maxDegree = nodes.reduce((m, n) => Math.max(m, n.importedBy), 0) || 1;
  const ranked = nodes.map((node): RankedFile => {
    const searchableText = nodeText(node);
    const tokens = tokenize(searchableText);
    const tokenSet = new Set(tokens);
    const normalizedText = normalizeSearchText(searchableText);
    let hits = 0;
    for (const token of tokens) {
      if (queryTokens.has(token)) hits += 1;
    }
    let matchedQueryTerms = 0;
    for (const token of queryTokens) {
      if (tokenSet.has(token)) matchedQueryTerms += 1;
    }
    const phraseHits = queryPhrases.filter((phrase) => normalizedText.includes(phrase)).length;
    // Exact basename / path-segment matches are strong signals — boost them.
    const labelTokens = new Set(tokenize(node.label));
    const pathTokens = pathTokenSet(node.id);
    const symbolTokens = symbolTokenSet(node);
    const nameBoost = [...queryTokens].filter((q) => labelTokens.has(q)).length * 4;
    const pathBoost = [...queryTokens].filter((q) => pathTokens.has(q)).length * 5;
    const symbolBoost = [...queryTokens].filter((q) => symbolTokens.has(q)).length * 6;
    const symbolNames = node.symbols.map((symbol) => symbol.name);
    const fuzzyPathBoost = fuzzySubsequenceScore(compactQuery, node.id) * 0.35;
    const fuzzyNameBoost = fuzzySubsequenceScore(compactQuery, node.label) * 0.8;
    const fuzzySymbolBoost = bestFuzzyScore(compactQuery, symbolNames) * 0.75;
    const acronym = acronymOf([node.id, node.label, symbolNames.join(' ')].join(' '));
    const acronymBoost =
      [...queryTokens].filter((token) => token.length >= 2 && fuzzySubsequenceScore(token, acronym) > 0).length * 4;
    const testPenalty = node.layer === 'test' && !queryWantsTests(queryTokens) ? 12 : 0;
    const fallbackPenalty = node.summarySource === 'fallback' ? 0.5 : 0;
    const degreeBoost = (node.importedBy / maxDegree) * 0.5;
    const relevance =
      hits +
      matchedQueryTerms * 4 +
      phraseHits * 8 +
      nameBoost +
      pathBoost +
      symbolBoost +
      fuzzyPathBoost +
      fuzzyNameBoost +
      fuzzySymbolBoost +
      acronymBoost -
      testPenalty -
      fallbackPenalty;
    return {
      id: node.id,
      score: relevance > 0 ? relevance + degreeBoost : 0,
    };
  });
  return ranked.toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id));
};

// ---------------------------------------------------------------------------
// Graph expansion + adjacency
// ---------------------------------------------------------------------------

/** Build forward (imports) + reverse (imported-by) adjacency maps from edges. */
const addAdjacency = (map: Map<string, Set<string>>, key: string, value: string): void => {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  set.add(value);
};

const buildAdjacency = (
  graph: KnowledgeGraph
): { imports: Map<string, Set<string>>; importedBy: Map<string, Set<string>> } => {
  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    addAdjacency(imports, edge.from, edge.to);
    addAdjacency(importedBy, edge.to, edge.from);
  }
  return { imports, importedBy };
};

/**
 * Expand a set of seed ids by following both directions up to `hops`, returning
 * a map of id → how it was reached (`dependency` = seed imports it,
 * `dependent` = it imports a seed). Seeds themselves are not included here.
 */
const expandNeighbors = (
  seeds: readonly string[],
  graph: KnowledgeGraph,
  hops: number
): Map<string, 'dependency' | 'dependent'> => {
  const { imports, importedBy } = buildAdjacency(graph);
  const reached = new Map<string, 'dependency' | 'dependent'>();
  const seedSet = new Set(seeds);
  let frontier = new Set(seeds);
  for (let hop = 0; hop < Math.max(1, hops); hop += 1) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const dep of imports.get(id) ?? []) {
        if (!seedSet.has(dep) && !reached.has(dep)) {
          reached.set(dep, 'dependency');
          next.add(dep);
        }
      }
      for (const dependent of importedBy.get(id) ?? []) {
        if (!seedSet.has(dependent) && !reached.has(dependent)) {
          reached.set(dependent, 'dependent');
          next.add(dependent);
        }
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return reached;
};

// ---------------------------------------------------------------------------
// Rendering — compact Markdown retrieval guide for the agent
// ---------------------------------------------------------------------------

/** Render one slice as a compact Markdown block (path · layer · summary · symbols). */
const renderSlice = (slice: ContextSlice, maxSymbols: number): string => {
  const head = `### \`${slice.path}\` · ${slice.layer} · ${slice.reason}`;
  const summary = slice.summary.length > 0 ? `\n${slice.summary}` : '';
  const syms = slice.symbols.slice(0, maxSymbols).map((s) => `- ${s.kind} \`${s.name}\` (L${s.line})`);
  const symbolBlock = syms.length > 0 ? `\nSymbols:\n${syms.join('\n')}` : '';
  const chunkLines =
    slice.chunks && slice.chunks.length > 0
      ? slice.chunks.map(
          (chunk) => `- \`${slice.path}\` L${chunk.startLine}-L${chunk.endLine} · score ${chunk.score.toFixed(1)}`
        )
      : [];
  const chunkBlock = chunkLines.length > 0 ? `\nRelevant source regions:\n${chunkLines.join('\n')}` : '';
  return `${head}${summary}${symbolBlock}${chunkBlock}`;
};

/** Compose the full agent guide: rules first, then the ranked retrieval map. */
const renderBrief = (
  request: string,
  slices: readonly ContextSlice[],
  rules: readonly string[],
  maxSymbols: number
): string => {
  const sections: string[] = [];
  if (rules.length > 0) {
    sections.push('## Project rules\n' + rules.map((r) => `- ${r}`).join('\n'));
  }
  sections.push(
    [
      `## IDE Repo Guide (lazy retrieval)`,
      `User request: ${request}`,
      'Map only; source is not preloaded. Inspect listed paths lazily, then widen by search only when evidence points elsewhere.',
      'MTUI runtime (MANDATORY): use `mtui --json` for ALL repo search/read/write/verify; do NOT use generic built-in tools (Read/Glob/Grep/cat/shell) for repo files — they bypass the MTUI layer the user reviews. After writes check `diff --last`, and only accept stale confirmations after reviewing the diff excerpt.',
      'Planning runtime: non-trivial work lives in `.aionui/specs/<slug>/`; execute claimed backend tasks; put temporary scripts under `plan/temporary/`.',
    ].join('\n')
  );
  sections.push(slices.map((s) => renderSlice(s, maxSymbols)).join('\n\n'));
  sections.push(
    '_Only the paths above were judged relevant. They are candidates to inspect, not a complete context dump._'
  );
  return sections.join('\n\n');
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Default option values for the builder. */
const DEFAULTS: Required<ContextBuilderOptions> = {
  maxSlices: 12,
  seedCount: 5,
  expandHops: 1,
  maxSymbolsPerSlice: 12,
};

/**
 * Create a {@link ContextBuilder}. The ranker is injected (defaults to
 * {@link lexicalGraphRanker}); pass a semantic ranker once the vector store is
 * wired to upgrade relevance without changing the rest of the pipeline.
 */
export const createContextBuilder = (
  deps: ContextBuilderDeps = {},
  options: ContextBuilderOptions = {}
): ContextBuilder => {
  const ranker = deps.ranker ?? lexicalGraphRanker;
  const opts = { ...DEFAULTS, ...options };

  const build = async (input: BuildContextInput): Promise<ContextPack> => {
    const { request, graph } = input;
    const rules = input.rules ?? [];
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));

    // 1. Rank + 2. seed.
    const ranked = await ranker(request, graph.nodes);
    const matchingRanked = ranked.filter((r) => r.score > 0);
    const seedSource = matchingRanked.length > 0 ? matchingRanked : ranked;
    const seeds = seedSource.slice(0, opts.seedCount).map((r) => r.id);
    const scoreById = new Map(ranked.map((r) => [r.id, r.score] as const));
    const chunksById = new Map(ranked.map((r) => [r.id, r.chunks] as const));

    // 3. Graph-expand from seeds.
    const neighbors = expandNeighbors(seeds, graph, opts.expandHops);

    // 4. Changed-boost from a diff (regression context).
    const changed = new Set(input.diff ? changedNodeIds(input.diff) : []);

    // Assemble candidate slices with a reason + score, de-duplicated by id.
    const slices = new Map<string, ContextSlice>();
    const put = (id: string, reason: ContextSlice['reason'], baseScore: number): void => {
      const node = nodeById.get(id);
      if (!node || slices.has(id)) return;
      const changedBoost = changed.has(id) ? 100 : 0;
      slices.set(id, {
        path: id,
        layer: node.layer as ArchLayer,
        reason: changed.has(id) ? 'changed' : reason,
        score: baseScore + changedBoost,
        summary: node.summary,
        symbols: node.symbols,
        chunks: chunksById.get(id),
      });
    };

    seeds.forEach((id) => put(id, 'seed', (scoreById.get(id) ?? 0) + 1000));
    for (const [id, rel] of neighbors) put(id, rel, scoreById.get(id) ?? 0);
    // Ensure changed files are present even if neither seed nor neighbour.
    for (const id of changed) put(id, 'changed', 0);

    const ordered = Array.from(slices.values()).toSorted((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const truncated = ordered.length > opts.maxSlices;
    const kept = truncated ? ordered.slice(0, opts.maxSlices) : ordered;

    return {
      request,
      slices: kept,
      rules,
      renderedContext: renderBrief(request, kept, rules, opts.maxSymbolsPerSlice),
      sliceCount: kept.length,
      truncated,
    };
  };

  return { build };
};

export default createContextBuilder;
