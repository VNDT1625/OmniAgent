/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildVectorIndex,
  createVectorRanker,
  isVectorIndexFresh,
  VECTOR_INDEX_VERSION,
  type Embedder,
} from '@/process/ide/vectorIndex';
import type { KnowledgeGraph, KnowledgeNode } from '@/process/ide/understandTypes';

const makeNode = (
  id: string,
  summary: string,
  fingerprint: string,
  symbols: KnowledgeNode['symbols'] = []
): KnowledgeNode => ({
  id,
  label: id.split('/').pop() ?? id,
  group: 'src',
  layer: 'service',
  summary,
  summarySource: 'llm',
  tags: [],
  symbols,
  language: 'typescript',
  importedBy: 0,
  fingerprint,
});

const graph: KnowledgeGraph = {
  rootPath: '/repo',
  version: 3,
  builtAt: 1000,
  nodes: [
    makeNode('src/browser/captionService.ts', 'Extracts video captions and transcripts', 'a'),
    makeNode('src/music/player.ts', 'Schedules audio clips and tracks', 'b'),
  ],
  edges: [],
  tours: [],
  truncated: false,
  fileCount: 2,
};

const vectorFor = (text: string): number[] => {
  const lower = text.toLowerCase();
  return [
    lower.includes('browser') || lower.includes('caption') || lower.includes('transcript') ? 1 : 0,
    lower.includes('music') || lower.includes('audio') || lower.includes('track') ? 1 : 0,
    lower.includes('login') || lower.includes('auth') ? 1 : 0,
  ];
};

const embedder: Embedder = {
  providerId: 'test-provider',
  model: 'text-embedding-test',
  embed: async (texts) => texts.map(vectorFor),
};

describe('vectorIndex', () => {
  it('builds a fresh chunk-level index from graph and source files', async () => {
    const graphWithSymbols: KnowledgeGraph = {
      ...graph,
      nodes: [
        makeNode('src/browser/captionService.ts', 'Extracts video captions and transcripts', 'a', [
          { name: 'loadTranscript', kind: 'function', line: 1 },
          { name: 'loadCaptions', kind: 'function', line: 2 },
          { name: 'openBrowser', kind: 'function', line: 3 },
        ]),
        graph.nodes[1],
      ],
    };
    const index = await buildVectorIndex(
      graphWithSymbols,
      [
        {
          relPath: 'src/browser/captionService.ts',
          content: [
            'export const transcript = true; ' + 'transcript '.repeat(90),
            'export const captions = true; ' + 'caption '.repeat(90),
            'export const browser = true; ' + 'browser '.repeat(90),
          ].join('\n'),
        },
        { relPath: 'src/music/player.ts', content: 'export const audio = true;' },
      ],
      embedder,
      { chunkCharBudget: 500, chunkOverlapLines: 0, now: () => 2000 }
    );

    expect(index.version).toBe(VECTOR_INDEX_VERSION);
    expect(index.builtAt).toBe(2000);
    expect(index.entries.length).toBeGreaterThan(graphWithSymbols.nodes.length);
    expect(index.entries[0]).toEqual(
      expect.objectContaining({
        chunkId: expect.stringContaining('#function-'),
        startLine: expect.any(Number),
        endLine: expect.any(Number),
        preview: expect.any(String),
      })
    );
    expect(isVectorIndexFresh(graphWithSymbols, index)).toBe(true);
  });

  it('detects stale indexes when file fingerprints changed', async () => {
    const index = await buildVectorIndex(graph, [], embedder);
    const changedGraph: KnowledgeGraph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.id === 'src/browser/captionService.ts' ? { ...node, fingerprint: 'changed' } : node
      ),
    };

    expect(isVectorIndexFresh(changedGraph, index)).toBe(false);
  });

  it('ranks files by embedding similarity', async () => {
    const index = await buildVectorIndex(graph, [], embedder);
    const ranker = createVectorRanker(index, embedder.embed);
    const ranked = await ranker('video transcript not loading', graph.nodes);

    expect(ranked[0]?.id).toBe('src/browser/captionService.ts');
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
    expect(ranked[0]?.chunks?.[0]).toEqual(
      expect.objectContaining({
        startLine: expect.any(Number),
        endLine: expect.any(Number),
        preview: expect.any(String),
      })
    );
  });

  it('reuses unchanged file vectors during incremental rebuilds', async () => {
    let embeddedCount = 0;
    const countingEmbedder: Embedder = {
      ...embedder,
      embed: async (texts) => {
        embeddedCount += texts.length;
        return texts.map(vectorFor);
      },
    };
    const first = await buildVectorIndex(
      graph,
      [
        { relPath: 'src/browser/captionService.ts', content: 'transcript '.repeat(120) },
        { relPath: 'src/music/player.ts', content: 'audio '.repeat(120) },
      ],
      countingEmbedder,
      { chunkCharBudget: 500, chunkOverlapLines: 0 }
    );
    const firstEmbeddedCount = embeddedCount;
    const changedBrowserNode = { ...graph.nodes[0], fingerprint: 'changed-browser' };
    const changedGraph: KnowledgeGraph = {
      ...graph,
      nodes: [changedBrowserNode, graph.nodes[1]],
    };

    const second = await buildVectorIndex(
      changedGraph,
      [
        { relPath: 'src/browser/captionService.ts', content: 'transcript changed '.repeat(120) },
        { relPath: 'src/music/player.ts', content: 'audio unchanged '.repeat(120) },
      ],
      countingEmbedder,
      { previous: first, chunkCharBudget: 500, chunkOverlapLines: 0 }
    );

    expect(embeddedCount - firstEmbeddedCount).toBeLessThan(firstEmbeddedCount);
    expect(second.entries.some((entry) => entry.id === 'src/music/player.ts' && entry.fingerprint === 'b')).toBe(true);
    expect(isVectorIndexFresh(changedGraph, second)).toBe(true);
  });
});
