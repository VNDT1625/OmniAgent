/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure freshness checks for persisted Understand graphs. Summary/context reads
 * must not silently trust an old graph after files changed outside Live mode.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprintOf, type KnowledgeGraphBuilderDeps } from './knowledgeGraphBuilder';
import type { KnowledgeGraph } from './understandTypes';

export type GraphFreshness = {
  fresh: boolean;
  changed: string[];
  removed: string[];
  added: string[];
  staleMarker: boolean;
  markerChanged: string[];
  markerUpdatedAt?: string;
};

type StaleMarker = {
  updatedAt?: string;
  paths?: string[];
};

const readStaleMarker = async (rootPath: string): Promise<StaleMarker | null> => {
  try {
    const text = await fs.readFile(path.join(rootPath, '.aionui', 'understand', 'stale.json'), 'utf-8');
    const parsed = JSON.parse(text) as Partial<StaleMarker>;
    return {
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
      paths: Array.isArray(parsed.paths)
        ? parsed.paths
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.replace(/\\/g, '/'))
        : [],
    };
  } catch {
    return null;
  }
};

export const assessGraphFreshness = async (
  graph: KnowledgeGraph,
  deps: Pick<KnowledgeGraphBuilderDeps, 'collectFiles'>
): Promise<GraphFreshness> => {
  const files = await deps.collectFiles(graph.rootPath);
  const fileByPath = new Map(files.map((file) => [file.relPath.replace(/\\/g, '/'), file.content] as const));
  const nodeByPath = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const changed: string[] = [];
  const removed: string[] = [];
  const added: string[] = [];
  const marker = await readStaleMarker(graph.rootPath);
  const markerChanged = Array.from(new Set(marker?.paths ?? [])).toSorted();

  for (const node of graph.nodes) {
    const content = fileByPath.get(node.id);
    if (content === undefined) {
      removed.push(node.id);
      continue;
    }
    if (node.fingerprint && fingerprintOf(content) !== node.fingerprint) {
      changed.push(node.id);
    }
  }

  for (const relPath of fileByPath.keys()) {
    if (!nodeByPath.has(relPath)) {
      added.push(relPath);
    }
  }

  changed.sort();
  removed.sort();
  added.sort();

  return {
    fresh: changed.length === 0 && removed.length === 0 && added.length === 0 && markerChanged.length === 0,
    changed,
    removed,
    added,
    staleMarker: markerChanged.length > 0,
    markerChanged,
    markerUpdatedAt: marker?.updatedAt,
  };
};
