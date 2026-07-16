/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Build + lay out the Learn-notes link graph (Obsidian-style "graph view").
 *
 * Pure, renderer-only, dependency-free:
 * - {@link buildLinkGraph} turns the Learn notes into nodes (one per note) and
 *   edges (one per resolved `[[wiki]]` link). Unresolved links are dropped so
 *   the graph only shows real connections.
 * - {@link simulateLayout} runs a small deterministic force-directed simulation
 *   (Fruchterman–Reingold-style repulsion + spring attraction + centering) to
 *   assign each node an (x, y) position inside a unit box. No animation loop is
 *   required — a fixed number of iterations gives a stable, good-enough layout
 *   that the component can then let the user nudge by dragging.
 *
 * Keeping this separate from the React component makes the layout testable and
 * keeps the SVG renderer declarative.
 */

import type { Note } from '@process/manager/managerTypes';
import { extractWikiTargets, resolveWikiTarget } from './wikiLinks';

/** A graph node — one per Learn note. */
export type GraphNode = {
  id: string;
  title: string;
  /** Number of incident edges (in + out), for sizing. */
  degree: number;
  x: number;
  y: number;
};

/** A directed edge from one note to another (resolved `[[wiki]]` link). */
export type GraphEdge = { source: string; target: string };

/** The full graph payload the component renders. */
export type LinkGraph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Deterministic pseudo-random in [0,1) from a string seed (initial placement). */
const seededUnit = (seed: string): number => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map to [0,1).
  return ((h >>> 0) % 100000) / 100000;
};

/**
 * Build the link graph from the current Learn notes.
 *
 * Only notes with a non-empty title can be link targets (a `[[wiki]]` resolves
 * by title), but every Learn note is a node so isolated notes still appear.
 */
export const buildLinkGraph = (notes: Note[]): LinkGraph => {
  const learn = notes.filter((n) => n.category === 'learn');
  const nodes: GraphNode[] = learn.map((n) => ({
    id: n.id,
    title: (n.title ?? '').trim() || 'Untitled',
    degree: 0,
    // Seed initial position from the id so the layout is stable across renders.
    x: seededUnit(n.id),
    y: seededUnit(`${n.id}:y`),
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  for (const note of learn) {
    for (const target of extractWikiTargets(note.body)) {
      const dest = resolveWikiTarget(target, learn);
      if (!dest || dest.id === note.id) continue;
      const key = `${note.id}->${dest.id}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ source: note.id, target: dest.id });
      const a = byId.get(note.id);
      const b = byId.get(dest.id);
      if (a) a.degree += 1;
      if (b) b.degree += 1;
    }
  }

  return { nodes, edges };
};

/** Tunables for {@link simulateLayout}. */
export type LayoutOptions = {
  iterations?: number;
  /** Repulsion strength between every pair of nodes. */
  repulsion?: number;
  /** Spring (attraction) strength along edges. */
  attraction?: number;
  /** Pull toward the centre so disconnected clusters don't drift off. */
  centering?: number;
};

/**
 * Run a deterministic force-directed layout, mutating the node `x`/`y` in place
 * and returning the same graph. Positions end up roughly in the unit box
 * `[0,1]²`; the renderer scales them to the SVG viewport with padding.
 */
export const simulateLayout = (graph: LinkGraph, options?: LayoutOptions): LinkGraph => {
  const { nodes, edges } = graph;
  const n = nodes.length;
  if (n === 0) return graph;

  const iterations = options?.iterations ?? 300;
  const repulsion = options?.repulsion ?? 0.02;
  const attraction = options?.attraction ?? 0.08;
  const centering = options?.centering ?? 0.01;

  const edgeList = edges.map((e) => ({
    a: nodes.findIndex((node) => node.id === e.source),
    b: nodes.findIndex((node) => node.id === e.target),
  }));

  for (let iter = 0; iter < iterations; iter += 1) {
    // Cooling factor: larger moves early, finer adjustments later.
    const cooling = 1 - iter / iterations;
    const dx = Array.from({ length: n }, () => 0);
    const dy = Array.from({ length: n }, () => 0);

    // Pairwise repulsion.
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let vx = nodes[i].x - nodes[j].x;
        let vy = nodes[i].y - nodes[j].y;
        let distSq = vx * vx + vy * vy;
        if (distSq < 1e-6) {
          // Coincident nodes: nudge apart deterministically.
          vx = (i - j) * 1e-3 + 1e-4;
          vy = (j - i) * 1e-3 + 1e-4;
          distSq = vx * vx + vy * vy;
        }
        const force = repulsion / distSq;
        const dist = Math.sqrt(distSq);
        const fx = (vx / dist) * force;
        const fy = (vy / dist) * force;
        dx[i] += fx;
        dy[i] += fy;
        dx[j] -= fx;
        dy[j] -= fy;
      }
    }

    // Spring attraction along edges.
    for (const { a, b } of edgeList) {
      if (a < 0 || b < 0) continue;
      const vx = nodes[b].x - nodes[a].x;
      const vy = nodes[b].y - nodes[a].y;
      dx[a] += vx * attraction;
      dy[a] += vy * attraction;
      dx[b] -= vx * attraction;
      dy[b] -= vy * attraction;
    }

    // Centering pull + apply.
    for (let i = 0; i < n; i += 1) {
      dx[i] += (0.5 - nodes[i].x) * centering;
      dy[i] += (0.5 - nodes[i].y) * centering;
      nodes[i].x = clamp01(nodes[i].x + dx[i] * cooling);
      nodes[i].y = clamp01(nodes[i].y + dy[i] * cooling);
    }
  }

  return graph;
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
