/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chunk-level vector index for IDE Understand retrieval.
 *
 * The index stores multiple source chunks per file. Retrieval ranks chunks by
 * semantic similarity, then aggregates the best chunk matches back to files so
 * the existing graph-expansion pipeline can still pull related dependencies.
 */

import type { KnowledgeGraph, KnowledgeNode } from './understandTypes';
import { lexicalGraphRanker, type RankedFile, type Ranker } from './contextBuilder';

/** Persisted vector-index schema version. */
export const VECTOR_INDEX_VERSION = 2;

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_CHUNK_CHAR_BUDGET = 1800;
const DEFAULT_CHUNK_OVERLAP_LINES = 8;
const DEFAULT_MAX_CHUNKS_PER_FILE = 16;
const DEFAULT_MATCHES_PER_FILE = 3;
const PREVIEW_CHAR_BUDGET = 700;

export type VectorIndexEntry = {
  id: string;
  chunkId: string;
  fingerprint?: string;
  startLine: number;
  endLine: number;
  preview: string;
  vector: number[];
};

export type VectorIndex = {
  rootPath: string;
  version: number;
  graphVersion: number;
  builtAt: number;
  providerId: string;
  model: string;
  dimensions: number;
  entries: VectorIndexEntry[];
};

export type Embedder = {
  providerId: string;
  model: string;
  embed: (texts: readonly string[], signal?: AbortSignal) => Promise<number[][]>;
};

export type VectorIndexOptions = {
  batchSize?: number;
  chunkCharBudget?: number;
  chunkOverlapLines?: number;
  maxChunksPerFile?: number;
  previous?: VectorIndex | null;
  now?: () => number;
  signal?: AbortSignal;
};

const clip = (text: string, budget: number): string => (text.length > budget ? text.slice(0, budget) : text);

type SourceChunk = {
  node: KnowledgeNode;
  chunkId: string;
  startLine: number;
  endLine: number;
  text: string;
};

const chunkDocument = (chunk: SourceChunk): string =>
  [
    `Path: ${chunk.node.id}`,
    `Lines: ${chunk.startLine}-${chunk.endLine}`,
    `Layer: ${chunk.node.layer}`,
    chunk.node.tags.length > 0 ? `Tags: ${chunk.node.tags.join(', ')}` : '',
    chunk.node.summary.length > 0 ? `Summary: ${chunk.node.summary}` : '',
    chunk.node.symbols.length > 0
      ? `Symbols: ${chunk.node.symbols.map((s) => `${s.kind} ${s.name} L${s.line}`).join(', ')}`
      : '',
    `Source:\n${chunk.text}`,
  ]
    .filter((part) => part.length > 0)
    .join('\n');

const makeChunk = (
  node: KnowledgeNode,
  lines: readonly string[],
  start: number,
  end: number,
  chunkIdSuffix: string
): SourceChunk => {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart + 1, Math.min(lines.length, end));
  const text = lines.slice(safeStart, safeEnd).join('\n').trim();
  return {
    node,
    chunkId: `${node.id}#${chunkIdSuffix}-L${safeStart + 1}-L${safeEnd}`,
    startLine: safeStart + 1,
    endLine: safeEnd,
    text: text.length > 0 ? text : node.summary || node.id,
  };
};

const boundedEnd = (lines: readonly string[], start: number, limit: number, chunkCharBudget: number): number => {
  let end = start;
  let chars = 0;
  while (end < limit && (chars === 0 || chars + lines[end].length + 1 <= chunkCharBudget)) {
    chars += lines[end].length + 1;
    end += 1;
  }
  return Math.max(end, start + 1);
};

const symbolChunks = (
  node: KnowledgeNode,
  lines: readonly string[],
  chunkCharBudget: number,
  maxChunks: number
): SourceChunk[] => {
  const symbols = node.symbols
    .filter((symbol) => symbol.line > 0)
    .toSorted((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  const chunks: SourceChunk[] = [];
  for (let i = 0; i < symbols.length && chunks.length < maxChunks; i += 1) {
    const symbol = symbols[i];
    const start = Math.max(0, symbol.line - 1);
    const nextStart = symbols[i + 1] ? Math.max(start + 1, symbols[i + 1].line - 1) : lines.length;
    const end = boundedEnd(lines, start, nextStart, chunkCharBudget);
    chunks.push(makeChunk(node, lines, start, end, `${symbol.kind}-${symbol.name}`));
  }
  return chunks;
};

const lineChunks = (
  node: KnowledgeNode,
  lines: readonly string[],
  chunkCharBudget: number,
  overlapLines: number,
  maxChunks: number
): SourceChunk[] => {
  const chunks: SourceChunk[] = [];
  let start = 0;
  while (start < lines.length && chunks.length < maxChunks) {
    const safeEnd = boundedEnd(lines, start, lines.length, chunkCharBudget);
    chunks.push(makeChunk(node, lines, start, safeEnd, 'chunk'));
    if (safeEnd >= lines.length) {
      break;
    }
    start = Math.max(safeEnd - overlapLines, start + 1);
  }
  return chunks;
};

const chunkContent = (
  node: KnowledgeNode,
  content: string,
  chunkCharBudget: number,
  overlapLines: number,
  maxChunks: number
): SourceChunk[] => {
  const source =
    content.length > 0 ? content : [node.id, node.summary, node.symbols.map((s) => s.name).join('\n')].join('\n');
  const lines = source.split(/\r?\n/);
  const bySymbol = symbolChunks(node, lines, chunkCharBudget, maxChunks);
  return bySymbol.length > 0 ? bySymbol : lineChunks(node, lines, chunkCharBudget, overlapLines, maxChunks);
};

const magnitude = (vector: readonly number[]): number =>
  Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

const normalizeVector = (vector: readonly number[]): number[] => {
  const mag = magnitude(vector);
  if (mag <= 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / mag);
};

const cosine = (a: readonly number[], b: readonly number[]): number => {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
};

/** Return true when a persisted vector index still matches this graph exactly. */
export const isVectorIndexFresh = (graph: KnowledgeGraph, index: VectorIndex): boolean => {
  if (
    index.version !== VECTOR_INDEX_VERSION ||
    index.rootPath !== graph.rootPath ||
    index.graphVersion !== graph.version
  ) {
    return false;
  }
  const fingerprintById = new Map(graph.nodes.map((node) => [node.id, node.fingerprint] as const));
  const indexedIds = new Set<string>();
  for (const entry of index.entries) {
    if (fingerprintById.get(entry.id) !== entry.fingerprint) {
      return false;
    }
    indexedIds.add(entry.id);
  }
  return graph.nodes.every((node) => indexedIds.has(node.id));
};

/** Build a chunk-level vector index from graph nodes plus source text. */
export const buildVectorIndex = async (
  graph: KnowledgeGraph,
  files: ReadonlyArray<{ relPath: string; content: string }>,
  embedder: Embedder,
  options: VectorIndexOptions = {}
): Promise<VectorIndex> => {
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const chunkCharBudget = Math.max(500, options.chunkCharBudget ?? DEFAULT_CHUNK_CHAR_BUDGET);
  const overlapLines = Math.max(0, options.chunkOverlapLines ?? DEFAULT_CHUNK_OVERLAP_LINES);
  const maxChunks = Math.max(1, options.maxChunksPerFile ?? DEFAULT_MAX_CHUNKS_PER_FILE);
  const now = options.now ?? Date.now;
  const contentByPath = new Map(files.map((file) => [file.relPath.replace(/\\/g, '/'), file.content] as const));
  const reusable =
    options.previous?.version === VECTOR_INDEX_VERSION &&
    options.previous.rootPath === graph.rootPath &&
    options.previous.graphVersion === graph.version &&
    options.previous.providerId === embedder.providerId &&
    options.previous.model === embedder.model
      ? options.previous
      : null;
  const reusableEntriesById = new Map<string, VectorIndexEntry[]>();
  for (const entry of reusable?.entries ?? []) {
    const current = reusableEntriesById.get(entry.id) ?? [];
    current.push(entry);
    reusableEntriesById.set(entry.id, current);
  }

  const entries: VectorIndexEntry[] = [];
  const chunks: SourceChunk[] = [];
  for (const node of graph.nodes) {
    const previousEntries = reusableEntriesById.get(node.id);
    if (previousEntries?.every((entry) => entry.fingerprint === node.fingerprint)) {
      entries.push(...previousEntries);
      continue;
    }
    chunks.push(...chunkContent(node, contentByPath.get(node.id) ?? '', chunkCharBudget, overlapLines, maxChunks));
  }

  for (let i = 0; i < chunks.length; i += batchSize) {
    if (options.signal?.aborted) {
      break;
    }
    const batch = chunks.slice(i, i + batchSize);
    const documents = batch.map(chunkDocument);
    const vectors = await embedder.embed(documents, options.signal);
    for (let j = 0; j < batch.length; j += 1) {
      const vector = vectors[j];
      if (!vector || vector.length === 0) {
        continue;
      }
      const chunk = batch[j];
      entries.push({
        id: chunk.node.id,
        chunkId: chunk.chunkId,
        fingerprint: chunk.node.fingerprint,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        preview: clip(chunk.text, PREVIEW_CHAR_BUDGET),
        vector: normalizeVector(vector),
      });
    }
  }

  return {
    rootPath: graph.rootPath,
    version: VECTOR_INDEX_VERSION,
    graphVersion: graph.version,
    builtAt: now(),
    providerId: embedder.providerId,
    model: embedder.model,
    dimensions: entries[0]?.vector.length ?? 0,
    entries,
  };
};

/** Create a semantic ranker backed by a persisted vector index. */
export const createVectorRanker = (index: VectorIndex, embedQuery: Embedder['embed']): Ranker => {
  return async (request, nodes): Promise<RankedFile[]> => {
    const [queryVector] = await embedQuery([request]);
    const normalizedQuery = normalizeVector(queryVector ?? []);
    const lexical = await lexicalGraphRanker(request, nodes);
    const lexicalById = new Map(lexical.map((item) => [item.id, item.score] as const));
    const matchesById = new Map<string, NonNullable<RankedFile['chunks']>>();
    for (const entry of index.entries) {
      if (normalizedQuery.length === 0) {
        continue;
      }
      const score = Math.max(0, cosine(normalizedQuery, entry.vector)) * 100;
      if (score <= 0) {
        continue;
      }
      const current = matchesById.get(entry.id) ?? [];
      current.push({
        startLine: entry.startLine,
        endLine: entry.endLine,
        preview: entry.preview,
        score,
      });
      matchesById.set(
        entry.id,
        current.toSorted((a, b) => b.score - a.score || a.startLine - b.startLine).slice(0, DEFAULT_MATCHES_PER_FILE)
      );
    }
    const semanticRaw = new Map<string, number>();
    for (const [id, chunks] of matchesById) {
      semanticRaw.set(
        id,
        chunks.reduce((total, chunk, chunkIndex) => total + chunk.score / (chunkIndex + 1), 0)
      );
    }
    const maxSemantic = Math.max(1, ...semanticRaw.values());
    const maxLexical = Math.max(1, ...lexical.map((item) => item.score));
    const maxDegree = Math.max(1, ...nodes.map((node) => node.importedBy));

    return nodes
      .map((node): RankedFile => {
        const chunks = matchesById.get(node.id);
        const semanticScore = ((semanticRaw.get(node.id) ?? 0) / maxSemantic) * 100;
        const lexicalScore = ((lexicalById.get(node.id) ?? 0) / maxLexical) * 35;
        const graphScore = (node.importedBy / maxDegree) * 10;
        const score = semanticScore + lexicalScore + graphScore;
        return { id: node.id, score, chunks };
      })
      .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  };
};
