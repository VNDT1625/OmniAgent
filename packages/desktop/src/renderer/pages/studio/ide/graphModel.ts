/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `graphModel` — pure, renderer-side derivations over a {@link KnowledgeGraph}:
 *
 *  - {@link deriveC4} projects the file-level graph onto a chosen C4 abstraction
 *    level (Context / Container / Component / Code) so the same data can be read
 *    at four "zoom" levels (Simon Brown's C4 model). This is computed in the
 *    renderer from already-built data — no extra build cost, no bigger payload.
 *  - {@link computeImpact} performs a diff-impact traversal: given a set of
 *    changed file ids, it finds every node that transitively DEPENDS ON a
 *    changed file (its dependents), so a live edit highlights its ripple.
 *
 * Everything here is a pure function of its inputs (stable output for stable
 * input) so it memoizes cleanly and unit-tests without mocks. No React, no DOM,
 * no Node — safe to import from components and from tests alike.
 */

import type { C4Level, ImpactResult, KnowledgeGraph } from './ideClient';
import type { ArchLayer } from '@process/ide/understandTypes';

/** A node in a C4-projected view (generic across all four levels). */
export type C4Node = {
  /** Stable id within the level (file path, module id, container id, or actor). */
  id: string;
  /** Display label. */
  label: string;
  /** Architectural layer (drives colour); `unknown` for actors/externals. */
  layer: ArchLayer;
  /** Node kind, so the view can shape actors/externals differently from code. */
  kind: 'file' | 'module' | 'container' | 'system' | 'actor' | 'external';
  /** Plain-English summary, where available. */
  summary: string;
  /** A size weight (in-degree / file count / usage) for visual scaling. */
  weight: number;
  /** Underlying file ids this node represents (for selection + impact mapping). */
  files: string[];
};

/** A directed edge in a C4-projected view, with an aggregation weight. */
export type C4Edge = {
  from: string;
  to: string;
  /** How many underlying file edges this aggregates (1 for file level). */
  weight: number;
};

/** A fully projected C4 view at one level. */
export type C4View = {
  level: C4Level;
  nodes: C4Node[];
  edges: C4Edge[];
};

/** The top-level folder (container) a file belongs to, or `(root)`. */
const containerOf = (relPath: string): string => {
  const slash = relPath.indexOf('/');
  return slash > 0 ? relPath.slice(0, slash) : '(root)';
};

/** Most common layer among files (ties broken by first-seen order). */
const dominantLayer = (layers: ArchLayer[]): ArchLayer => {
  const counts = new Map<ArchLayer, number>();
  for (const layer of layers) counts.set(layer, (counts.get(layer) ?? 0) + 1);
  let best: ArchLayer = 'unknown';
  let bestCount = -1;
  for (const [layer, count] of counts) {
    if (count > bestCount) {
      best = layer;
      bestCount = count;
    }
  }
  return best;
};

/** Project the graph to the CODE level: one node per file (the raw graph). */
const deriveCode = (graph: KnowledgeGraph): C4View => ({
  level: 'code',
  nodes: graph.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    layer: n.layer,
    kind: 'file',
    summary: n.summary,
    weight: n.importedBy,
    files: [n.id],
  })),
  edges: graph.edges.map((e) => ({ from: e.from, to: e.to, weight: 1 })),
});

/**
 * Project to the COMPONENT level: one node per module (folder group). Reuses the
 * builder's `modules`/`moduleEdges` when present, else aggregates on the fly.
 */
const deriveComponent = (graph: KnowledgeGraph): C4View => {
  if (graph.modules && graph.modules.length > 0) {
    return {
      level: 'component',
      nodes: graph.modules.map((m) => ({
        id: m.id,
        label: m.label,
        layer: m.layer,
        kind: 'module',
        summary: m.summary,
        weight: m.fileCount,
        files: m.files,
      })),
      edges: (graph.moduleEdges ?? []).map((e) => ({ from: e.from, to: e.to, weight: e.weight })),
    };
  }
  // Fallback: derive modules from the top-two path segments.
  return aggregateBy(
    graph,
    (id) => {
      const parts = id.split('/');
      return parts.length <= 1 ? '(root)' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
    },
    'module'
  );
};

/** Project to the CONTAINER level: one node per top-level folder / package. */
const deriveContainer = (graph: KnowledgeGraph): C4View => aggregateBy(graph, containerOf, 'container');

/**
 * Aggregate the file graph into groups keyed by `keyOf(fileId)`, producing
 * weighted inter-group edges (self-loops dropped). Shared by container + the
 * component fallback. Pure.
 */
const aggregateBy = (graph: KnowledgeGraph, keyOf: (fileId: string) => string, kind: C4Node['kind']): C4View => {
  const groupOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  const layersOf = new Map<string, ArchLayer[]>();
  const summaryOf = new Map<string, string>();

  for (const node of graph.nodes) {
    const key = keyOf(node.id);
    groupOf.set(node.id, key);
    (members.get(key) ?? members.set(key, []).get(key)!).push(node.id);
    (layersOf.get(key) ?? layersOf.set(key, []).get(key)!).push(node.layer);
    if (!summaryOf.has(key) && node.summary.length > 0 && node.summarySource === 'llm') {
      summaryOf.set(key, node.summary);
    }
  }

  const nodes: C4Node[] = Array.from(members.entries())
    .map(([id, files]) => ({
      id,
      label: id === '(root)' ? '(root)' : (id.split('/').pop() ?? id),
      layer: dominantLayer(layersOf.get(id) ?? []),
      kind,
      summary: summaryOf.get(id) ?? '',
      weight: files.length,
      files,
    }))
    .toSorted((a, b) => b.weight - a.weight);

  const edgeWeights = new Map<string, number>();
  for (const edge of graph.edges) {
    const from = groupOf.get(edge.from);
    const to = groupOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
  }
  const edges: C4Edge[] = Array.from(edgeWeights.entries()).map(([key, weight]) => {
    const [from, to] = key.split('\u0000');
    return { from, to, weight };
  });

  return { level: 'container', nodes, edges };
};

/** Synthetic ids for the Context level (kept stable + unlikely to collide). */
export const CONTEXT_IDS = { user: '__actor:user', system: '__system:repo' } as const;

/**
 * Project to the CONTEXT level: the system as one node, a generic User actor,
 * and the repo's top external dependencies — the C4 "system context" diagram.
 * The System node carries every file so selecting it still maps to the codebase.
 */
const deriveContext = (graph: KnowledgeGraph): C4View => {
  const allFiles = graph.nodes.map((n) => n.id);
  const systemLabel = graph.overview?.tagline ? 'System' : 'System';
  const nodes: C4Node[] = [
    { id: CONTEXT_IDS.user, label: 'User', layer: 'unknown', kind: 'actor', summary: '', weight: 1, files: [] },
    {
      id: CONTEXT_IDS.system,
      label: systemLabel,
      layer: 'service',
      kind: 'system',
      summary: graph.overview?.tagline ?? '',
      weight: Math.max(1, allFiles.length),
      files: allFiles,
    },
  ];
  const edges: C4Edge[] = [{ from: CONTEXT_IDS.user, to: CONTEXT_IDS.system, weight: 1 }];

  for (const ext of graph.externals ?? []) {
    const id = `__external:${ext.name}`;
    nodes.push({ id, label: ext.name, layer: 'unknown', kind: 'external', summary: '', weight: ext.usedBy, files: [] });
    edges.push({ from: CONTEXT_IDS.system, to: id, weight: ext.usedBy });
  }
  return { level: 'context', nodes, edges };
};

/**
 * Project a knowledge graph onto a chosen C4 abstraction level. Pure; the same
 * graph + level always yields the same view, so callers can memoize on `[graph,
 * level]`. Levels with no extra data (e.g. Context with no externals) still
 * render the system + user so the view is never empty.
 */
export const deriveC4 = (graph: KnowledgeGraph, level: C4Level): C4View => {
  switch (level) {
    case 'context':
      return deriveContext(graph);
    case 'container':
      return deriveContainer(graph);
    case 'component':
      return deriveComponent(graph);
    case 'code':
    default:
      return deriveCode(graph);
  }
};

/**
 * Diff-impact analysis. Given the edges (`from` imports `to`) and a set of
 * changed file ids, return the changed set plus every node that transitively
 * DEPENDS ON a changed file. Dependents are followed against the import
 * direction: if A imports B and B changed, A is impacted. Cycle-safe (visited
 * set). Pure.
 */
export const computeImpact = (edges: Array<{ from: string; to: string }>, changedIds: string[]): ImpactResult => {
  const changed = changedIds.filter((id) => id.length > 0);
  const changedSet = new Set(changed);

  // Reverse adjacency: importedFile → [files that import it].
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    const list = dependents.get(edge.to) ?? [];
    list.push(edge.from);
    dependents.set(edge.to, list);
  }

  const impacted = new Set<string>();
  const queue = [...changedSet];
  const visited = new Set<string>(changedSet);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of dependents.get(current) ?? []) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      if (!changedSet.has(dependent)) impacted.add(dependent);
      queue.push(dependent);
    }
  }

  return { changed, impacted: Array.from(impacted).toSorted() };
};

/**
 * Map a set of changed FILE ids up to the ids used at a given C4 view, so an
 * impact highlight works at every zoom level (a changed file marks its module /
 * container / the system as touched).
 */
export const liftChangedToView = (view: C4View, changedFileIds: string[]): Set<string> => {
  const changed = new Set(changedFileIds);
  const out = new Set<string>();
  for (const node of view.nodes) {
    if (node.files.some((f) => changed.has(f))) out.add(node.id);
  }
  return out;
};
