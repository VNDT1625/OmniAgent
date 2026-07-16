/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Learn-notes link graph builder + layout.
 *
 * Covers:
 * - buildLinkGraph: one node per Learn note (incl. isolated ones), one edge per
 *   resolved [[wiki]] link, unresolved/self links dropped, edges de-duplicated,
 *   and node degree counts both directions.
 * - simulateLayout: deterministic, keeps coords in [0,1], never NaN, stable for
 *   the empty graph.
 */

import { describe, expect, it } from 'vitest';
import { buildLinkGraph, simulateLayout } from '@/renderer/pages/manager/notes/linking/linkGraph';
import type { Note } from '@/process/manager/managerTypes';

const learn = (id: string, title: string, body: string): Note => ({
  id,
  category: 'learn',
  title,
  body,
  tags: [],
  linkedTaskId: null,
  linkedEventId: null,
  createdAt: 1,
  updatedAt: 1,
});

describe('buildLinkGraph', () => {
  it('creates one node per learn note, including isolated notes', () => {
    const notes = [learn('a', 'Alpha', 'no links here'), learn('b', 'Beta', 'lonely')];
    const g = buildLinkGraph(notes);
    expect(g.nodes.map((n) => n.id).toSorted()).toEqual(['a', 'b']);
    expect(g.edges).toHaveLength(0);
  });

  it('creates an edge for each resolved [[wiki]] link and counts degree', () => {
    const notes = [learn('a', 'Alpha', 'see [[Beta]]'), learn('b', 'Beta', 'back to [[Alpha]]')];
    const g = buildLinkGraph(notes);
    expect(g.edges).toHaveLength(2);
    expect(g.nodes.find((n) => n.id === 'a')!.degree).toBe(2);
    expect(g.nodes.find((n) => n.id === 'b')!.degree).toBe(2);
  });

  it('drops links that resolve to no note and self-links', () => {
    const notes = [learn('a', 'Alpha', 'links [[Ghost]] and [[Alpha]]')];
    const g = buildLinkGraph(notes);
    expect(g.edges).toHaveLength(0);
    expect(g.nodes[0].degree).toBe(0);
  });

  it('de-duplicates repeated links between the same pair', () => {
    const notes = [learn('a', 'Alpha', '[[Beta]] and again [[Beta]]'), learn('b', 'Beta', '')];
    const g = buildLinkGraph(notes);
    expect(g.edges).toHaveLength(1);
  });

  it('ignores non-learn notes', () => {
    const notes = [learn('a', 'Alpha', '[[Beta]]'), { ...learn('b', 'Beta', ''), category: 'daily' as const }];
    const g = buildLinkGraph(notes);
    expect(g.nodes.map((n) => n.id)).toEqual(['a']);
    expect(g.edges).toHaveLength(0);
  });
});

describe('simulateLayout', () => {
  it('keeps every coordinate finite and within [0,1]', () => {
    const notes = [learn('a', 'Alpha', '[[Beta]]'), learn('b', 'Beta', '[[Gamma]]'), learn('c', 'Gamma', '[[Alpha]]')];
    const g = simulateLayout(buildLinkGraph(notes), { iterations: 120 });
    for (const node of g.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(1);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic for the same input', () => {
    const mk = () => buildLinkGraph([learn('a', 'Alpha', '[[Beta]]'), learn('b', 'Beta', '[[Alpha]]')]);
    const g1 = simulateLayout(mk(), { iterations: 80 });
    const g2 = simulateLayout(mk(), { iterations: 80 });
    expect(g1.nodes.map((n) => [n.x, n.y])).toEqual(g2.nodes.map((n) => [n.x, n.y]));
  });

  it('handles the empty graph without throwing', () => {
    const g = simulateLayout(buildLinkGraph([]));
    expect(g.nodes).toHaveLength(0);
  });
});
