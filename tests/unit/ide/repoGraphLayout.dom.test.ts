/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the pure React Flow layout helpers used by `RepoGraphView`.
 * These exercise `computeRepoLayout`, `styleRepoEdges`, and `computeHighlight`
 * directly with in-memory graphs — deterministic, no rendering. Runs under
 * jsdom only because the module imports `@xyflow/react` (which touches the DOM).
 */

import { describe, expect, it } from 'vitest';
import {
  colorForGroup,
  computeHighlight,
  computeRepoLayout,
  PALETTE,
  styleRepoEdges,
} from '@renderer/pages/studio/ide/components/repoGraphLayout';
import type { RepoGraph } from '@/process/ide/repoGraph';

/** Build a minimal RepoGraph for tests. */
const makeGraph = (
  nodes: Array<{ id: string; label: string; group: string }>,
  edges: Array<{ from: string; to: string }>
): RepoGraph => ({
  nodes,
  edges,
  rootPath: '/repo',
  fileCount: nodes.length,
  truncated: false,
});

describe('computeRepoLayout', () => {
  it('produces one repo node per graph node with stable colours per group', () => {
    const graph = makeGraph(
      [
        { id: 'src/a.ts', label: 'a.ts', group: 'src' },
        { id: 'src/b.ts', label: 'b.ts', group: 'src' },
        { id: 'lib/c.ts', label: 'c.ts', group: 'lib' },
      ],
      [{ from: 'src/a.ts', to: 'lib/c.ts' }]
    );

    const layout = computeRepoLayout(graph);

    expect(layout.nodes).toHaveLength(3);
    expect(layout.nodes.every((n) => n.type === 'repo')).toBe(true);
    expect(layout.groups).toEqual(['lib', 'src']);
    // Same group → same colour; different groups → different colour.
    const a = layout.nodes.find((n) => n.id === 'src/a.ts');
    const b = layout.nodes.find((n) => n.id === 'src/b.ts');
    const c = layout.nodes.find((n) => n.id === 'lib/c.ts');
    expect(a?.data.color).toBe(b?.data.color);
    expect(a?.data.color).not.toBe(c?.data.color);
    expect(PALETTE).toContain(a?.data.color);
  });

  it('is deterministic — identical input yields identical positions', () => {
    const graph = makeGraph(
      [
        { id: 'a.ts', label: 'a.ts', group: '.ts' },
        { id: 'b.ts', label: 'b.ts', group: '.ts' },
        { id: 'c.ts', label: 'c.ts', group: '.ts' },
      ],
      [
        { from: 'a.ts', to: 'b.ts' },
        { from: 'c.ts', to: 'b.ts' },
      ]
    );

    const first = computeRepoLayout(graph);
    const second = computeRepoLayout(graph);
    expect(first.nodes.map((n) => n.position)).toEqual(second.nodes.map((n) => n.position));
  });

  it('emphasises high in-degree hubs with larger dot/font', () => {
    const graph = makeGraph(
      [
        { id: 'hub.ts', label: 'hub.ts', group: '.ts' },
        { id: 'x.ts', label: 'x.ts', group: '.ts' },
        { id: 'y.ts', label: 'y.ts', group: '.ts' },
      ],
      [
        { from: 'x.ts', to: 'hub.ts' },
        { from: 'y.ts', to: 'hub.ts' },
      ]
    );

    const layout = computeRepoLayout(graph);
    const hub = layout.nodes.find((n) => n.id === 'hub.ts');
    const leaf = layout.nodes.find((n) => n.id === 'x.ts');
    expect(hub?.data.degree).toBe(2);
    expect(leaf?.data.degree).toBe(0);
    expect(hub!.data.dot).toBeGreaterThan(leaf!.data.dot);
    expect(hub!.data.font).toBeGreaterThanOrEqual(leaf!.data.font);
  });

  it('builds undirected adjacency for neighbour highlighting', () => {
    const graph = makeGraph(
      [
        { id: 'a.ts', label: 'a.ts', group: '.ts' },
        { id: 'b.ts', label: 'b.ts', group: '.ts' },
      ],
      [{ from: 'a.ts', to: 'b.ts' }]
    );
    const layout = computeRepoLayout(graph);
    expect(layout.neighbors.get('a.ts')?.has('b.ts')).toBe(true);
    expect(layout.neighbors.get('b.ts')?.has('a.ts')).toBe(true);
  });

  it('maps one React Flow edge per graph edge with source/target', () => {
    const graph = makeGraph(
      [
        { id: 'a.ts', label: 'a.ts', group: '.ts' },
        { id: 'b.ts', label: 'b.ts', group: '.ts' },
      ],
      [{ from: 'a.ts', to: 'b.ts' }]
    );
    const layout = computeRepoLayout(graph);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ source: 'a.ts', target: 'b.ts' });
  });
});

describe('computeHighlight', () => {
  const neighbors = new Map<string, Set<string>>([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
  ]);

  it('returns "none" when nothing is focused', () => {
    expect(computeHighlight('a', null, neighbors)).toBe('none');
  });
  it('marks the focus node, its neighbours, and dims the rest', () => {
    expect(computeHighlight('a', 'a', neighbors)).toBe('focus');
    expect(computeHighlight('b', 'a', neighbors)).toBe('neighbor');
    expect(computeHighlight('c', 'a', neighbors)).toBe('dim');
  });
});

describe('styleRepoEdges', () => {
  const graph = makeGraph(
    [
      { id: 'a.ts', label: 'a.ts', group: '.ts' },
      { id: 'b.ts', label: 'b.ts', group: '.ts' },
      { id: 'c.ts', label: 'c.ts', group: '.ts' },
    ],
    [
      { from: 'a.ts', to: 'b.ts' },
      { from: 'b.ts', to: 'c.ts' },
    ]
  );

  it('emphasises edges touching the focus node and fades the others', () => {
    const { edges, colorById } = computeRepoLayout(graph);
    const styled = styleRepoEdges(edges, 'a.ts', colorById);
    const active = styled.find((e) => e.source === 'a.ts' && e.target === 'b.ts');
    const inactive = styled.find((e) => e.source === 'b.ts' && e.target === 'c.ts');
    expect(active?.style?.opacity).toBeGreaterThan(inactive?.style?.opacity as number);
  });

  it('returns idle styling when no node is focused', () => {
    const { edges, colorById } = computeRepoLayout(graph);
    const styled = styleRepoEdges(edges, null, colorById);
    expect(styled).toHaveLength(2);
    expect(styled.every((e) => (e.style?.opacity as number) <= 0.3)).toBe(true);
  });
});

describe('colorForGroup', () => {
  it('is stable and wraps around the palette', () => {
    const groups = Array.from({ length: PALETTE.length + 2 }, (_, i) => `g${i}`);
    expect(colorForGroup('g0', groups)).toBe(PALETTE[0]);
    expect(colorForGroup(`g${PALETTE.length}`, groups)).toBe(PALETTE[0]);
    expect(colorForGroup('missing', groups)).toBe(PALETTE[0]);
  });
});
