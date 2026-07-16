/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure layout + data-conversion helpers for {@link RepoGraphView}. Given a
 * backend {@link RepoGraph} this module produces React Flow `Node[]`/`Edge[]`
 * with deterministic positions, per-group categorical colours, and in-degree
 * emphasis. It also derives the adjacency map used to highlight a selected
 * node's neighbours and dim the rest.
 *
 * The layout is a concentric "hubs in the centre" arrangement: nodes are sorted
 * by in-degree (how many modules import them) and packed onto rings whose
 * angular capacity grows with their radius, so the most-depended-on files sit
 * near the middle and nothing overlaps. Everything here is a pure function of
 * the graph (no DOM, no React, no time) so the conversion can be memoized and
 * unit-reasoned about. Renderer-only module.
 */

import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { RepoGraph } from '../ideClient';

/** Per-node payload carried on each React Flow node and read by the renderer. */
export type RepoNodeData = {
  /** Relative path (node id) — stable identity, used as the focus key. */
  path: string;
  /** Basename shown as the node label. */
  label: string;
  /** Top-level folder this file belongs to (drives the colour). */
  group: string;
  /** Stable categorical colour for the group. */
  color: string;
  /** In-degree: how many modules import this file. */
  degree: number;
  /** Coloured-dot diameter (px), scaled by in-degree. */
  dot: number;
  /** Label font size (px), scaled by in-degree. */
  font: number;
  /** Whether the label renders bold (top hubs). */
  bold: boolean;
  /** Highlight state relative to the current focus node. */
  highlight: RepoHighlight;
};

/** How a node relates to the currently focused (selected/hovered) node. */
export type RepoHighlight = 'none' | 'focus' | 'neighbor' | 'dim';

/** A React Flow node specialised for the repo graph. */
export type RepoFlowNode = Node<RepoNodeData, 'repo'>;

/** A React Flow edge for the repo graph (no custom data needed). */
export type RepoFlowEdge = Edge;

/** Result of {@link computeRepoLayout}. */
export type RepoLayout = {
  nodes: RepoFlowNode[];
  edges: RepoFlowEdge[];
  /** Undirected adjacency (importer↔imported) for neighbour highlighting. */
  neighbors: Map<string, Set<string>>;
  /** Node id → group colour, for tinting active edges. */
  colorById: Map<string, string>;
  /** Sorted unique group names (colour assignment order). */
  groups: string[];
};

/**
 * A small categorical palette (stable per group, theme-agnostic mid-tones).
 * These are data-viz category colours — intentionally hard-coded.
 */
export const PALETTE = [
  '#6366F1',
  '#10B981',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#06B6D4',
  '#EC4899',
  '#84CC16',
  '#F97316',
  '#14B8A6',
] as const;

/** Deterministic colour for a group name given the sorted group list. */
export const colorForGroup = (group: string, groups: string[]): string => {
  const index = groups.indexOf(group);
  return PALETTE[(index < 0 ? 0 : index) % PALETTE.length];
};

// --- Layout geometry constants ---------------------------------------------

/** Fixed node height (px). */
const NODE_H = 34;
/** Minimum / maximum node width (px) — widened slightly for the busiest hubs. */
const NODE_W_MIN = 124;
const NODE_W_MAX = 184;
/** Radius of the first non-central ring and the step between rings (px). */
const BASE_RADIUS = 130;
const RING_STEP = 150;
/** Minimum arc length (px) reserved per node on a ring — prevents overlap. */
const MIN_ARC = 200;
/** Fewest nodes allowed on a ring before the radius-based capacity kicks in. */
const MIN_PER_RING = 4;

/** Angular capacity of a ring at a given radius. */
const ringCapacity = (radius: number): number => Math.max(MIN_PER_RING, Math.floor((2 * Math.PI * radius) / MIN_ARC));

/** Linear interpolation clamped to [a, b]. */
const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.min(1, Math.max(0, t));

/**
 * Convert a {@link RepoGraph} into a deterministic React Flow layout. Pure: the
 * same graph always yields identical positions, colours, and ordering.
 */
export const computeRepoLayout = (graph: RepoGraph): RepoLayout => {
  // In-degree per node (how many modules import it).
  const indeg = new Map<string, number>();
  for (const node of graph.nodes) indeg.set(node.id, 0);
  for (const edge of graph.edges) {
    if (indeg.has(edge.to)) indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  }

  // Undirected adjacency for neighbour highlighting.
  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    let set = neighbors.get(a);
    if (!set) {
      set = new Set<string>();
      neighbors.set(a, set);
    }
    set.add(b);
  };
  for (const edge of graph.edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  const groups = Array.from(new Set(graph.nodes.map((n) => n.group))).toSorted();
  const maxDegree = graph.nodes.reduce((max, n) => Math.max(max, indeg.get(n.id) ?? 0), 0);

  // Order by in-degree desc so hubs land on the inner rings (stable tiebreak).
  const ordered = [...graph.nodes].toSorted((a, b) => {
    const d = (indeg.get(b.id) ?? 0) - (indeg.get(a.id) ?? 0);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });

  const colorById = new Map<string, string>();
  const nodes: RepoFlowNode[] = [];

  let placed = 0;
  let ring = 0;
  while (placed < ordered.length) {
    const radius = ring === 0 ? 0 : BASE_RADIUS + RING_STEP * (ring - 1);
    const capacity = ring === 0 ? 1 : ringCapacity(radius);
    const count = Math.min(capacity, ordered.length - placed);
    // Stagger successive rings so nodes don't line up radially.
    const angleOffset = ring * 0.45;

    for (let i = 0; i < count; i++) {
      const node = ordered[placed + i];
      const degree = indeg.get(node.id) ?? 0;
      const t = maxDegree > 0 ? degree / maxDegree : 0;
      const color = colorForGroup(node.group, groups);
      colorById.set(node.id, color);

      const width = Math.round(lerp(NODE_W_MIN, NODE_W_MAX, t));
      const angle = count > 0 ? (i / count) * Math.PI * 2 + angleOffset : 0;
      const cx = Math.cos(angle) * radius;
      const cy = Math.sin(angle) * radius;

      nodes.push({
        id: node.id,
        type: 'repo',
        position: { x: cx - width / 2, y: cy - NODE_H / 2 },
        width,
        height: NODE_H,
        draggable: true,
        connectable: false,
        data: {
          path: node.id,
          label: node.label,
          group: node.group,
          color,
          degree,
          dot: Math.round(lerp(7, 16, t)),
          font: Math.round(lerp(11, 14, t)),
          bold: t >= 0.5,
          highlight: 'none',
        },
      });
    }

    placed += count;
    ring += 1;
  }

  const edges: RepoFlowEdge[] = graph.edges.map((edge) => baseEdge(edge.from, edge.to));

  return { nodes, edges, neighbors, colorById, groups };
};

/** Idle (no-focus) edge stroke colour — an inherited Arco fill token. */
const EDGE_IDLE_STROKE = 'var(--color-fill-3)';

/** Build a single edge in its idle (un-highlighted) style. */
const baseEdge = (from: string, to: string): RepoFlowEdge => ({
  id: `${from}__${to}`,
  source: from,
  target: to,
  type: 'default',
  style: { stroke: EDGE_IDLE_STROKE, strokeWidth: 1, opacity: 0.3 },
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: EDGE_IDLE_STROKE },
});

/**
 * Recompute edge styles for the current focus node. Edges touching the focus
 * are tinted with the source node's group colour and emphasised; every other
 * edge is faded. Returns a fresh array (pure).
 */
export const styleRepoEdges = (
  edges: RepoFlowEdge[],
  focusId: string | null,
  colorById: Map<string, string>
): RepoFlowEdge[] =>
  edges.map((edge) => {
    if (!focusId) return baseEdge(edge.source, edge.target);
    const active = edge.source === focusId || edge.target === focusId;
    if (!active) {
      return {
        ...baseEdge(edge.source, edge.target),
        style: { stroke: EDGE_IDLE_STROKE, strokeWidth: 1, opacity: 0.06 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: EDGE_IDLE_STROKE },
      };
    }
    const color = colorById.get(edge.source) ?? colorById.get(edge.target) ?? EDGE_IDLE_STROKE;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'default',
      zIndex: 10,
      style: { stroke: color, strokeWidth: 2, opacity: 0.95 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
    };
  });

/** Classify a node relative to the focus node (for dimming/highlighting). */
export const computeHighlight = (
  nodeId: string,
  focusId: string | null,
  neighbors: Map<string, Set<string>>
): RepoHighlight => {
  if (!focusId) return 'none';
  if (nodeId === focusId) return 'focus';
  return neighbors.get(focusId)?.has(nodeId) ? 'neighbor' : 'dim';
};
