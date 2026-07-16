/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for contextBuilder — the core "agent understands code" engine.
 * Uses the default lexical+graph ranker (no embeddings needed).
 */

import { describe, expect, it } from 'vitest';
import { createContextBuilder, lexicalGraphRanker } from '@/process/ide/contextBuilder';
import type { KnowledgeGraph } from '@/process/ide/understandTypes';

const node = (
  id: string,
  summary = '',
  importedBy = 0,
  symbols: { name: string; kind: 'function'; line: number }[] = [],
  layer: KnowledgeGraph['nodes'][number]['layer'] = 'util'
) => ({
  id,
  label: id.split('/').pop() ?? id,
  group: 'src',
  layer,
  summary,
  summarySource: 'llm' as const,
  tags: [],
  symbols,
  language: 'typescript',
  importedBy,
  fingerprint: 'fp-' + id,
});

const graph: KnowledgeGraph = {
  rootPath: '/repo',
  version: 2,
  builtAt: 1000,
  nodes: [
    node('src/auth/LoginButton.tsx', 'The login button component', 3, [
      { name: 'LoginButton', kind: 'function', line: 5 },
    ]),
    node('src/auth/useAuth.ts', 'Auth hook managing login state', 5, [
      { name: 'useAuth', kind: 'function', line: 1 },
      { name: 'login', kind: 'function', line: 10 },
    ]),
    node('src/api/authApi.ts', 'API calls for authentication', 2, [
      { name: 'loginRequest', kind: 'function', line: 3 },
    ]),
    node('src/utils/logger.ts', 'Logging utility', 8),
    node('src/components/Button.tsx', 'Generic button', 12),
  ],
  edges: [
    { from: 'src/auth/LoginButton.tsx', to: 'src/auth/useAuth.ts' },
    { from: 'src/auth/useAuth.ts', to: 'src/api/authApi.ts' },
    { from: 'src/auth/LoginButton.tsx', to: 'src/components/Button.tsx' },
  ],
  tours: [],
  truncated: false,
  fileCount: 5,
};

describe('lexicalGraphRanker', () => {
  it('ranks files with matching tokens higher', async () => {
    const ranked = await lexicalGraphRanker('login button', graph.nodes);
    const ids = ranked.map((r) => r.id);
    // LoginButton and useAuth should rank above logger/Button (no login token)
    expect(ids.indexOf('src/auth/LoginButton.tsx')).toBeLessThan(ids.indexOf('src/utils/logger.ts'));
  });

  it('falls back to importedBy order when query is empty', async () => {
    const ranked = await lexicalGraphRanker('', graph.nodes);
    // Button (importedBy=12) should rank above LoginButton (importedBy=3)
    const buttonIdx = ranked.findIndex((r) => r.id === 'src/components/Button.tsx');
    const loginIdx = ranked.findIndex((r) => r.id === 'src/auth/LoginButton.tsx');
    expect(buttonIdx).toBeLessThan(loginIdx);
  });

  it('uses Understand summaries to rank Vietnamese browser and transcript queries', async () => {
    const browserGraph: KnowledgeGraph = {
      ...graph,
      nodes: [
        node('mobile/src/utils/messageAdapter.ts', 'Generic message utilities', 50),
        node('musicdaw/src/agent/producer.ts', 'Music producer agent', 40),
        node('tests/e2e/fixtures.ts', 'Playwright fixtures', 35),
        node('packages/desktop/src/process/browser/browserBridge.ts', 'Điều khiển trình duyệt và các tab', 2),
        node(
          'packages/desktop/src/process/services/contentExtract/ytDlpTranscript.ts',
          'Lấy phụ đề và transcript YouTube cho phần trình duyệt',
          1
        ),
        node('packages/desktop/src/renderer/pages/browser/BrowserPage.tsx', 'Trang UI trình duyệt nhúng', 1),
      ],
      edges: [],
      fileCount: 6,
    };

    const browserRanked = await lexicalGraphRanker(
      'xin chào bạn thấy trình duyệt hiện tại như nào?',
      browserGraph.nodes
    );
    expect(
      browserRanked
        .slice(0, 3)
        .map((r) => r.id)
        .toSorted()
    ).toEqual(
      [
        'packages/desktop/src/process/browser/browserBridge.ts',
        'packages/desktop/src/renderer/pages/browser/BrowserPage.tsx',
        'packages/desktop/src/process/services/contentExtract/ytDlpTranscript.ts',
      ].toSorted()
    );

    const subtitleRanked = await lexicalGraphRanker(
      'phần trình duyệt chưa lấy được phụ đề bằng AI',
      browserGraph.nodes
    );
    const subtitleTop = subtitleRanked.slice(0, 3).map((r) => r.id);
    expect(subtitleTop).toContain('packages/desktop/src/process/services/contentExtract/ytDlpTranscript.ts');
    expect(subtitleTop).not.toContain('mobile/src/utils/messageAdapter.ts');
    expect(subtitleTop).not.toContain('musicdaw/src/agent/producer.ts');
  });

  it('prefers source files over tests unless the request asks for tests', async () => {
    const ranked = await lexicalGraphRanker('improve knowledge graph builder', [
      node(
        'tests/unit/ide/knowledgeGraphBuilder.test.ts',
        'Knowledge graph builder tests',
        30,
        [{ name: 'knowledgeGraphBuilder', kind: 'function', line: 1 }],
        'test'
      ),
      node(
        'packages/desktop/src/process/ide/knowledgeGraphBuilder.ts',
        'Knowledge graph builder implementation',
        2,
        [{ name: 'createKnowledgeGraphBuilder', kind: 'function', line: 10 }],
        'service'
      ),
    ]);

    expect(ranked[0]?.id).toBe('packages/desktop/src/process/ide/knowledgeGraphBuilder.ts');

    const testRanked = await lexicalGraphRanker('fix knowledge graph builder test', [
      node(
        'tests/unit/ide/knowledgeGraphBuilder.test.ts',
        'Knowledge graph builder tests',
        30,
        [{ name: 'knowledgeGraphBuilder', kind: 'function', line: 1 }],
        'test'
      ),
      node(
        'packages/desktop/src/process/ide/knowledgeGraphBuilder.ts',
        'Knowledge graph builder implementation',
        2,
        [{ name: 'createKnowledgeGraphBuilder', kind: 'function', line: 10 }],
        'service'
      ),
    ]);

    expect(testRanked[0]?.id).toBe('tests/unit/ide/knowledgeGraphBuilder.test.ts');
  });

  it('uses fuzzy path and symbol matching for abbreviation-style code queries', async () => {
    const ranked = await lexicalGraphRanker('kg builder', [
      node(
        'packages/desktop/src/process/ide/knowledgeGraphBuilder.ts',
        'Builds the Understand knowledge graph',
        2,
        [{ name: 'createKnowledgeGraphBuilder', kind: 'function', line: 10 }],
        'service'
      ),
      node('packages/desktop/src/process/ide/graphSnapshot.ts', 'Diffs graph snapshots', 8, [], 'service'),
      node('packages/desktop/src/renderer/pages/browser/BrowserPage.tsx', 'Browser page UI', 20, [], 'ui'),
    ]);

    expect(ranked[0]?.id).toBe('packages/desktop/src/process/ide/knowledgeGraphBuilder.ts');
  });

  it('uses basename and camelCase fuzzy matching for Cursor-like file jumps', async () => {
    const ranked = await lexicalGraphRanker('browserpage', [
      node('packages/desktop/src/process/browser/browserBridge.ts', 'Browser process bridge', 12, [], 'api'),
      node(
        'packages/desktop/src/renderer/pages/browser/BrowserPage.tsx',
        'Embedded browser page',
        1,
        [{ name: 'BrowserPage', kind: 'function', line: 7 }],
        'ui'
      ),
      node('packages/desktop/src/renderer/pages/browser/BrowserToolbar.tsx', 'Browser toolbar', 4, [], 'ui'),
    ]);

    expect(ranked[0]?.id).toBe('packages/desktop/src/renderer/pages/browser/BrowserPage.tsx');
  });

  it('keeps semantic source intent above generic utility hubs for transcript queries', async () => {
    const ranked = await lexicalGraphRanker('yt transcript crawl subtitles', [
      node('mobile/src/utils/messageAdapter.ts', 'Generic message utilities', 50, [], 'util'),
      node(
        'packages/desktop/src/process/services/contentExtract/ytDlpTranscript.ts',
        'Crawls YouTube subtitles and transcript text',
        1,
        [{ name: 'fetchYtDlpTranscript', kind: 'function', line: 12 }],
        'service'
      ),
      node('packages/desktop/src/process/browser/browserBridge.ts', 'Browser tab control', 5, [], 'api'),
    ]);

    expect(ranked[0]?.id).toBe('packages/desktop/src/process/services/contentExtract/ytDlpTranscript.ts');
  });
});

describe('createContextBuilder.build', () => {
  const builder = createContextBuilder({}, { maxSlices: 6, seedCount: 2, expandHops: 1 });

  it('includes seed files and their graph neighbours', async () => {
    const pack = await builder.build({ request: 'fix login button', graph });
    const ids = pack.slices.map((s) => s.path);
    // LoginButton is a seed; useAuth + Button are its neighbours
    expect(ids).toContain('src/auth/LoginButton.tsx');
    expect(ids).toContain('src/auth/useAuth.ts');
  });

  it('marks seeds with reason=seed and neighbours with dependency/dependent', async () => {
    const pack = await builder.build({ request: 'fix login button', graph });
    const seed = pack.slices.find((s) => s.path === 'src/auth/LoginButton.tsx');
    expect(seed?.reason).toBe('seed');
    const dep = pack.slices.find((s) => s.path === 'src/auth/useAuth.ts');
    expect(dep?.reason).toBe('dependency');
  });

  it('boosts changed files from a diff even if not lexically relevant', async () => {
    const diff = {
      fromCommit: 'a',
      toCommit: 'b',
      fromBuiltAt: 0,
      toBuiltAt: 1,
      addedNodes: [],
      removedNodes: [],
      changedNodes: ['src/api/authApi.ts'],
      addedEdges: [],
      removedEdges: [],
    };
    const pack = await builder.build({ request: 'fix login button', graph, diff });
    const changed = pack.slices.find((s) => s.path === 'src/api/authApi.ts');
    expect(changed).toBeDefined();
    expect(changed?.reason).toBe('changed');
  });

  it('respects maxSlices budget', async () => {
    const smallBuilder = createContextBuilder({}, { maxSlices: 2 });
    const pack = await smallBuilder.build({ request: 'login', graph });
    expect(pack.slices.length).toBeLessThanOrEqual(2);
    expect(pack.truncated).toBe(true);
  });

  it('includes rules in the rendered context', async () => {
    const pack = await builder.build({ request: 'login', graph, rules: ['No raw <button>', 'Use i18n'] });
    expect(pack.renderedContext).toContain('No raw <button>');
    expect(pack.renderedContext).toContain('Use i18n');
    expect(pack.rules).toEqual(['No raw <button>', 'Use i18n']);
  });

  it('rendered context contains file paths and symbols', async () => {
    const pack = await builder.build({ request: 'fix login button', graph });
    expect(pack.renderedContext).toContain('IDE Repo Guide (lazy retrieval)');
    expect(pack.renderedContext).toContain('source is not preloaded');
    expect(pack.renderedContext).toContain('MTUI runtime (MANDATORY): use `mtui --json`');
    expect(pack.renderedContext).toContain('After writes check `diff --last`');
    expect(pack.renderedContext).toContain('accept stale confirmations after reviewing the diff excerpt');
    expect(pack.renderedContext).toContain('Planning runtime');
    expect(pack.renderedContext).toContain('.omni/specs/<slug>/');
    expect(pack.renderedContext).toContain('plan/temporary/');
    expect(pack.renderedContext).toContain('src/auth/LoginButton.tsx');
    expect(pack.renderedContext).toContain('LoginButton');
    expect(pack.renderedContext).not.toContain('already part of this message');
  });

  it('renders semantic chunk locations without preloading source previews', async () => {
    const semanticBuilder = createContextBuilder(
      {
        ranker: async () => [
          {
            id: 'src/auth/LoginButton.tsx',
            score: 99,
            chunks: [{ startLine: 10, endLine: 18, preview: 'const LoginButton = () => login();', score: 99 }],
          },
        ],
      },
      { maxSlices: 1, seedCount: 1 }
    );

    const pack = await semanticBuilder.build({ request: 'login click fails', graph });
    expect(pack.slices[0]?.chunks?.[0]?.startLine).toBe(10);
    expect(pack.renderedContext).toContain('Relevant source regions');
    expect(pack.renderedContext).toContain('L10-L18');
    expect(pack.renderedContext).not.toContain('const LoginButton');
  });
});
