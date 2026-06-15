/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for graphSnapshot — the time-dimension diff between two KG snapshots.
 */

import { describe, expect, it } from 'vitest';
import { changedNodeIds, diffGraphs, isEmptyDiff } from '@/process/ide/graphSnapshot';
import type { KnowledgeGraph } from '@/process/ide/understandTypes';

/** Build a minimal KnowledgeGraph for testing. */
const makeGraph = (overrides: Partial<KnowledgeGraph> = {}): KnowledgeGraph => ({
  rootPath: '/repo',
  version: 2,
  builtAt: 1000,
  nodes: [],
  edges: [],
  tours: [],
  truncated: false,
  fileCount: 0,
  ...overrides,
});

const node = (id: string, fingerprint = 'fp-' + id) => ({
  id,
  label: id.split('/').pop() ?? id,
  group: 'src',
  layer: 'util' as const,
  summary: '',
  tags: [],
  symbols: [],
  language: 'typescript',
  importedBy: 0,
  fingerprint,
});

describe('diffGraphs', () => {
  it('detects added nodes', () => {
    const from = makeGraph({ nodes: [node('a.ts')] });
    const to = makeGraph({ nodes: [node('a.ts'), node('b.ts')] });
    const diff = diffGraphs(from, to);
    expect(diff.addedNodes).toEqual(['b.ts']);
    expect(diff.removedNodes).toEqual([]);
    expect(diff.changedNodes).toEqual([]);
  });

  it('detects removed nodes', () => {
    const from = makeGraph({ nodes: [node('a.ts'), node('b.ts')] });
    const to = makeGraph({ nodes: [node('a.ts')] });
    const diff = diffGraphs(from, to);
    expect(diff.removedNodes).toEqual(['b.ts']);
    expect(diff.addedNodes).toEqual([]);
  });

  it('detects changed nodes (fingerprint differs)', () => {
    const from = makeGraph({ nodes: [node('a.ts', 'fp-old')] });
    const to = makeGraph({ nodes: [node('a.ts', 'fp-new')] });
    const diff = diffGraphs(from, to);
    expect(diff.changedNodes).toEqual(['a.ts']);
    expect(diff.addedNodes).toEqual([]);
    expect(diff.removedNodes).toEqual([]);
  });

  it('does NOT flag changed when fingerprint is same', () => {
    const from = makeGraph({ nodes: [node('a.ts', 'same')] });
    const to = makeGraph({ nodes: [node('a.ts', 'same')] });
    const diff = diffGraphs(from, to);
    expect(diff.changedNodes).toEqual([]);
  });

  it('detects added and removed edges', () => {
    const from = makeGraph({ edges: [{ from: 'a.ts', to: 'b.ts' }] });
    const to = makeGraph({ edges: [{ from: 'a.ts', to: 'c.ts' }] });
    const diff = diffGraphs(from, to);
    expect(diff.addedEdges).toEqual([{ from: 'a.ts', to: 'c.ts' }]);
    expect(diff.removedEdges).toEqual([{ from: 'a.ts', to: 'b.ts' }]);
  });

  it('carries commit hashes through', () => {
    const from = makeGraph({ commitHash: 'abc', builtAt: 1000 });
    const to = makeGraph({ commitHash: 'def', builtAt: 2000 });
    const diff = diffGraphs(from, to);
    expect(diff.fromCommit).toBe('abc');
    expect(diff.toCommit).toBe('def');
    expect(diff.fromBuiltAt).toBe(1000);
    expect(diff.toBuiltAt).toBe(2000);
  });
});

describe('isEmptyDiff', () => {
  it('returns true for identical graphs', () => {
    const g = makeGraph({ nodes: [node('a.ts')], edges: [{ from: 'a.ts', to: 'b.ts' }] });
    expect(isEmptyDiff(diffGraphs(g, g))).toBe(true);
  });

  it('returns false when something changed', () => {
    const from = makeGraph({ nodes: [node('a.ts', 'old')] });
    const to = makeGraph({ nodes: [node('a.ts', 'new')] });
    expect(isEmptyDiff(diffGraphs(from, to))).toBe(false);
  });
});

describe('changedNodeIds', () => {
  it('collects all touched ids (added + removed + changed + edge endpoints)', () => {
    const from = makeGraph({
      nodes: [node('a.ts'), node('b.ts')],
      edges: [{ from: 'a.ts', to: 'b.ts' }],
    });
    const to = makeGraph({
      nodes: [node('a.ts', 'new'), node('c.ts')],
      edges: [{ from: 'a.ts', to: 'c.ts' }],
    });
    const diff = diffGraphs(from, to);
    const ids = new Set(changedNodeIds(diff));
    expect(ids.has('a.ts')).toBe(true); // changed fingerprint + edge endpoint
    expect(ids.has('b.ts')).toBe(true); // removed node + removed edge endpoint
    expect(ids.has('c.ts')).toBe(true); // added node + added edge endpoint
  });
});
