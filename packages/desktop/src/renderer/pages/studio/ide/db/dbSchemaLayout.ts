/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure layout + data-conversion helpers for the database **ER / schema diagram**
 * ({@link SchemaDiagram}). Given a backend {@link DbSchemaGraph} this module
 * produces React Flow `Node[]`/`Edge[]`: one node per table (a card listing its
 * columns, with primary keys + foreign keys marked) and one edge per foreign
 * key (child table → referenced parent table).
 *
 * Layout is a deterministic masonry: tables are ordered by "relationship degree"
 * (how many FKs touch them) so the most-connected hubs come first, then packed
 * into a fixed number of columns, each node dropped into the currently-shortest
 * column so variable-height cards never overlap. Everything here is a pure
 * function of the graph (no DOM, no React, no time) so it can be memoized and
 * unit-tested. Renderer-only module.
 */

import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type { DbColumn, DbSchemaGraph } from './dbClient';

/** How a node relates to the currently focused (hovered) table. */
export type DbHighlight = 'none' | 'focus' | 'neighbor' | 'dim';

/** Per-node payload carried on each React Flow table node. */
export type DbTableNodeData = {
  /** Table id (schema-qualified when present) — stable identity. */
  id: string;
  /** Bare table name shown in the header. */
  name: string;
  /** Schema/owner (postgres); blank for sqlite/mysql. */
  schema?: string;
  /** 'table' or 'view'. */
  type: 'table' | 'view';
  /** Columns to render (capped — see {@link hiddenColumns}). */
  columns: DbColumn[];
  /** Number of columns not shown because of the per-card cap (0 when none). */
  hiddenColumns: number;
  /** Names of columns that are the SOURCE of a foreign key (for the link icon). */
  fkColumns: string[];
  /** Highlight state relative to the focused node. */
  highlight: DbHighlight;
};

/** A React Flow node specialised for the schema diagram. */
export type DbFlowNode = Node<DbTableNodeData, 'dbtable'>;

/** A React Flow edge for the schema diagram (FK relationship). */
export type DbFlowEdge = Edge;

/** Result of {@link computeSchemaLayout}. */
export type DbSchemaLayout = {
  nodes: DbFlowNode[];
  edges: DbFlowEdge[];
  /** Undirected adjacency (child↔parent) for neighbour highlighting. */
  neighbors: Map<string, Set<string>>;
};

// --- Geometry constants -----------------------------------------------------

/** Fixed card width (px). */
export const NODE_W = 230;
/** Header height (px). */
const HEADER_H = 30;
/** Per-column row height (px). */
const ROW_H = 20;
/** Footer height when columns are hidden (px). */
const FOOTER_H = 18;
/** Max column rows rendered per card (rest summarised as "+N"). */
export const MAX_ROWS = 14;
/** Gaps between cards (px). */
const GAP_X = 60;
const GAP_Y = 44;

/** Schema-qualified id for a table (matches FK target resolution). */
export const tableId = (schema: string | undefined, name: string): string => (schema ? `${schema}.${name}` : name);

/** Pixel height of a card given its (capped) column count + footer. */
export const nodeHeight = (columnCount: number, hidden: number): number =>
  HEADER_H + Math.min(columnCount, MAX_ROWS) * ROW_H + (hidden > 0 ? FOOTER_H : 0);

/** Number of masonry columns for `n` tables (√n, clamped to a readable range). */
const columnCount = (n: number): number => Math.min(6, Math.max(1, Math.round(Math.sqrt(n))));

/**
 * Convert a {@link DbSchemaGraph} into a deterministic React Flow layout. Pure:
 * the same graph always yields identical positions, ordering, and edges.
 */
export const computeSchemaLayout = (graph: DbSchemaGraph): DbSchemaLayout => {
  // Map a table name (and schema-qualified id) to its canonical node id so FK
  // targets resolve even when the FK omits the schema.
  const idByName = new Map<string, string>();
  const ids = new Set<string>();
  for (const t of graph.tables) {
    const id = tableId(t.schema, t.name);
    ids.add(id);
    idByName.set(id, id);
    if (!idByName.has(t.name)) idByName.set(t.name, id);
  }

  const resolveTarget = (refSchema: string | undefined, refTable: string): string | null => {
    const qualified = tableId(refSchema, refTable);
    if (ids.has(qualified)) return qualified;
    return idByName.get(refTable) ?? null;
  };

  // Relationship degree per table (outgoing + incoming FK endpoints).
  const degree = new Map<string, number>();
  const neighbors = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    degree.set(a, (degree.get(a) ?? 0) + 1);
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    neighbors.get(a)!.add(b);
  };
  const rawEdges: Array<{ source: string; target: string; label: string }> = [];
  for (const t of graph.tables) {
    const source = tableId(t.schema, t.name);
    for (const fk of t.foreignKeys) {
      const target = resolveTarget(fk.referencedSchema, fk.referencedTable);
      if (!target || target === source) continue;
      rawEdges.push({ source, target, label: fk.columns.join(', ') });
      link(source, target);
      link(target, source);
    }
  }

  // Order by degree desc (hubs first), stable tiebreak by id.
  const ordered = [...graph.tables].toSorted((a, b) => {
    const da = degree.get(tableId(a.schema, a.name)) ?? 0;
    const db = degree.get(tableId(b.schema, b.name)) ?? 0;
    return db - da || tableId(a.schema, a.name).localeCompare(tableId(b.schema, b.name));
  });

  const cols = columnCount(ordered.length);
  const colHeights = Array.from({ length: cols }, () => 0);
  const nodes: DbFlowNode[] = ordered.map((t) => {
    const id = tableId(t.schema, t.name);
    const hidden = Math.max(0, t.columns.length - MAX_ROWS);
    const shown = t.columns.slice(0, MAX_ROWS);
    const fkColumns = [...new Set(t.foreignKeys.flatMap((fk) => fk.columns))];
    // Drop into the shortest column (masonry).
    let col = 0;
    for (let c = 1; c < cols; c += 1) if (colHeights[c] < colHeights[col]) col = c;
    const x = col * (NODE_W + GAP_X);
    const y = colHeights[col];
    colHeights[col] += nodeHeight(shown.length, hidden) + GAP_Y;
    return {
      id,
      type: 'dbtable',
      position: { x, y },
      width: NODE_W,
      draggable: true,
      connectable: false,
      data: {
        id,
        name: t.name,
        schema: t.schema,
        type: t.type,
        columns: shown,
        hiddenColumns: hidden,
        fkColumns,
        highlight: 'none',
      },
    };
  });

  // Dedupe parallel FKs between the same pair (keep first label).
  const seen = new Set<string>();
  const edges: DbFlowEdge[] = [];
  for (const e of rawEdges) {
    const key = `${e.source}__${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(baseEdge(e.source, e.target, e.label));
  }

  return { nodes, edges, neighbors };
};

/** Idle FK edge stroke — an inherited Arco fill token. */
const EDGE_STROKE = 'var(--color-fill-3)';
/** Accent for an edge touching the focused node. */
const EDGE_ACTIVE = 'var(--primary)';

/** Build one FK edge in its idle style. */
const baseEdge = (source: string, target: string, label: string): DbFlowEdge => ({
  id: `${source}__${target}`,
  source,
  target,
  type: 'smoothstep',
  label,
  labelStyle: { fontSize: 9, fill: 'var(--color-text-3)' },
  style: { stroke: EDGE_STROKE, strokeWidth: 1.2, opacity: 0.45 },
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: EDGE_STROKE },
});

/**
 * Recompute edge styles for the focused node: edges touching it are accented +
 * emphasised, the rest faded. Pure — returns a fresh array.
 */
export const styleSchemaEdges = (edges: DbFlowEdge[], focusId: string | null): DbFlowEdge[] =>
  edges.map((edge) => {
    const label = typeof edge.label === 'string' ? edge.label : '';
    if (!focusId) return baseEdge(edge.source, edge.target, label);
    const active = edge.source === focusId || edge.target === focusId;
    if (!active) {
      return {
        ...baseEdge(edge.source, edge.target, label),
        style: { stroke: EDGE_STROKE, strokeWidth: 1, opacity: 0.08 },
      };
    }
    return {
      ...baseEdge(edge.source, edge.target, label),
      zIndex: 10,
      style: { stroke: EDGE_ACTIVE, strokeWidth: 2, opacity: 0.95 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: EDGE_ACTIVE },
    };
  });

/** Classify a node relative to the focus node (for dimming/highlighting). */
export const computeHighlight = (
  nodeId: string,
  focusId: string | null,
  neighbors: Map<string, Set<string>>
): DbHighlight => {
  if (!focusId) return 'none';
  if (nodeId === focusId) return 'focus';
  return neighbors.get(focusId)?.has(nodeId) ? 'neighbor' : 'dim';
};
