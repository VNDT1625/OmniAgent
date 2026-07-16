/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `graphSnapshot` — the TIME dimension of the IDE knowledge graph.
 *
 * The structural graph ({@link KnowledgeGraph}) answers "what depends on what
 * RIGHT NOW". This module adds "what CHANGED between two points in time": given
 * an older snapshot and a newer one, {@link diffGraphs} reports the files and
 * relationships that were added / removed / changed.
 *
 * ## Role (deliberately narrow — avoid over-reach)
 *
 * This is a *localisation hint* for bug fixing, NOT a bug detector. When code
 * worked at commit A but breaks at commit B, the diff narrows the suspects:
 * "between A and B, file X changed and now imports Y". It does NOT decide what
 * is broken or why — git-bisect + tests find the breaking commit; the agent
 * reads the real code to decide the fix. The diff just stops the agent from
 * re-reading the whole repo.
 *
 * Pure + dependency-free (no fs, no git, no LLM) so it is trivially testable;
 * the bridge layer supplies the persisted snapshots and the git commit hash.
 *
 * Process boundary: shared module (Main builder imports it). No DOM/Node APIs.
 */

import type { GraphDiff, KnowledgeEdge, KnowledgeGraph } from './understandTypes';

/** A stable string key for an edge, for set membership. */
const edgeKey = (edge: KnowledgeEdge): string => `${edge.from}\u0000${edge.to}`;

/** Parse an edge key back into an edge. */
const edgeFromKey = (key: string): KnowledgeEdge => {
  const [from, to] = key.split('\u0000');
  return { from, to };
};

/**
 * Diff two knowledge-graph snapshots. `from` is the older graph (e.g. a
 * known-good commit), `to` is the newer one (e.g. the current/broken state).
 *
 * - `addedNodes` / `removedNodes`: files that appeared / disappeared.
 * - `changedNodes`: files present in both but whose content fingerprint differs
 *   (so a same-named file that was edited shows up here, not as add+remove).
 * - `addedEdges` / `removedEdges`: dependencies that appeared / disappeared.
 *
 * Pure: returns a fresh object, mutates nothing.
 */
export const diffGraphs = (from: KnowledgeGraph, to: KnowledgeGraph): GraphDiff => {
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n] as const));
  const toNodes = new Map(to.nodes.map((n) => [n.id, n] as const));

  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const changedNodes: string[] = [];

  for (const [id, toNode] of toNodes) {
    const fromNode = fromNodes.get(id);
    if (!fromNode) {
      addedNodes.push(id);
    } else if (
      typeof fromNode.fingerprint === 'string' &&
      typeof toNode.fingerprint === 'string' &&
      fromNode.fingerprint !== toNode.fingerprint
    ) {
      changedNodes.push(id);
    }
  }
  for (const id of fromNodes.keys()) {
    if (!toNodes.has(id)) removedNodes.push(id);
  }

  const fromEdges = new Set(from.edges.map(edgeKey));
  const toEdges = new Set(to.edges.map(edgeKey));
  const addedEdges: KnowledgeEdge[] = [];
  const removedEdges: KnowledgeEdge[] = [];
  for (const key of toEdges) {
    if (!fromEdges.has(key)) addedEdges.push(edgeFromKey(key));
  }
  for (const key of fromEdges) {
    if (!toEdges.has(key)) removedEdges.push(edgeFromKey(key));
  }

  return {
    fromCommit: from.commitHash,
    toCommit: to.commitHash,
    fromBuiltAt: from.builtAt,
    toBuiltAt: to.builtAt,
    addedNodes: addedNodes.toSorted(),
    removedNodes: removedNodes.toSorted(),
    changedNodes: changedNodes.toSorted(),
    addedEdges: addedEdges.toSorted((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
    removedEdges: removedEdges.toSorted((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
  };
};

/** Whether a diff found any change at all (used to skip empty diff briefs). */
export const isEmptyDiff = (diff: GraphDiff): boolean =>
  diff.addedNodes.length === 0 &&
  diff.removedNodes.length === 0 &&
  diff.changedNodes.length === 0 &&
  diff.addedEdges.length === 0 &&
  diff.removedEdges.length === 0;

/**
 * All node ids touched by a diff (added + removed + changed + edge endpoints).
 * The Context Builder uses this to mark "recently changed" slices so the agent
 * looks at them first when fixing a regression.
 */
export const changedNodeIds = (diff: GraphDiff): string[] => {
  const ids = new Set<string>([...diff.addedNodes, ...diff.removedNodes, ...diff.changedNodes]);
  for (const edge of [...diff.addedEdges, ...diff.removedEdges]) {
    ids.add(edge.from);
    ids.add(edge.to);
  }
  return Array.from(ids).toSorted();
};
