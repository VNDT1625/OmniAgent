/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `kgRefresh` — deterministically patch ONE file's structural node in a
 * persisted knowledge graph after an edit, WITHOUT calling a model.
 *
 * This is the shared core behind both the `ide.kg-refresh-file` IPC handler and
 * the team-collab rule "editing a file must update the codebase graph" — when a
 * host or a peer writes/edits a file through the team session, the host runs
 * this so the Understand graph it serves to peers stays accurate. Semantic
 * summaries still come from an explicit, model-backed rebuild; this only keeps
 * the cheap structural facts (symbols / language / fingerprint / layer / import
 * membership) current, so it is safe to run on every save.
 *
 * Pure-ish: all fs is injected ({@link KgRefreshDeps}) so it is unit-testable
 * without Electron / disk. The default wiring (`refreshGraphFileOnDisk`) reads
 * and writes the same `userData/ide-knowledge/<hash>.json` the KG bridge uses.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import {
  detectLanguage,
  enrichSymbolRangesAndCalls,
  extractSymbols,
  fingerprintOf,
  inferLayer,
} from './knowledgeGraphBuilder';
import type { KnowledgeGraph, KnowledgeNode } from './understandTypes';

/** Injected collaborators so the refresh is testable without disk. */
export type KgRefreshDeps = {
  /** Load the persisted graph for a repo root, or null when none exists. */
  loadGraph: (rootPath: string) => Promise<KnowledgeGraph | null>;
  /** Persist the patched graph. */
  saveGraph: (graph: KnowledgeGraph) => Promise<void>;
  /** Read the (just-written) file content; null when unreadable. */
  readFile: (absPath: string) => Promise<string | null>;
};

/** Normalise a repo-relative path to forward-slash, no leading `./`. */
const normalizeRel = (relPath: string): string => relPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

/**
 * Patch the structural node for `relPath` in the repo's persisted graph from the
 * file's current content. No-op (returns null) when no graph is persisted yet.
 *
 * @returns the updated/created node, or null when there is no graph to patch.
 */
export const refreshGraphFile = async (
  deps: KgRefreshDeps,
  rootPath: string,
  relPathRaw: string,
  content: string
): Promise<KnowledgeNode | null> => {
  const relPath = normalizeRel(relPathRaw);
  if (!relPath) return null;
  const graph = await deps.loadGraph(rootPath);
  if (!graph) return null;

  const language = detectLanguage(relPath);
  const symbols = enrichSymbolRangesAndCalls(content, extractSymbols(content, language));
  const fingerprint = fingerprintOf(content);
  const idx = graph.nodes.findIndex((node) => node.id === relPath);
  let node: KnowledgeNode;
  if (idx >= 0) {
    node = { ...graph.nodes[idx], symbols, fingerprint, language };
    graph.nodes[idx] = node;
  } else {
    const label = relPath.slice(relPath.lastIndexOf('/') + 1);
    const slash = relPath.indexOf('/');
    const group = slash > 0 ? relPath.slice(0, slash) : relPath;
    node = {
      id: relPath,
      label,
      group,
      layer: inferLayer(relPath),
      summary: '',
      summarySource: 'fallback',
      tags: [],
      symbols,
      language,
      importedBy: 0,
      fingerprint,
    };
    graph.nodes.push(node);
    graph.fileCount = graph.nodes.length;
  }
  await deps.saveGraph(graph);
  return node;
};

// ---------------------------------------------------------------------------
// Default on-disk wiring (mirrors knowledgeGraphBridge persistence)
// ---------------------------------------------------------------------------

const resolveStorageDir = (): string => path.join(app.getPath('userData'), 'ide-knowledge');
const graphFileName = (rootPath: string): string =>
  `${createHash('sha256').update(rootPath).digest('hex').slice(0, 32)}.json`;

/** Production fs-backed {@link KgRefreshDeps}. */
export const onDiskKgRefreshDeps: KgRefreshDeps = {
  loadGraph: async (rootPath) => {
    try {
      const target = path.join(resolveStorageDir(), graphFileName(rootPath));
      return JSON.parse(await fsp.readFile(target, 'utf-8')) as KnowledgeGraph;
    } catch {
      return null;
    }
  },
  saveGraph: async (graph) => {
    const dir = resolveStorageDir();
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, graphFileName(graph.rootPath));
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(graph), 'utf-8');
    await fsp.rename(tmp, target);
  },
  readFile: async (absPath) => {
    try {
      return await fsp.readFile(absPath, 'utf-8');
    } catch {
      return null;
    }
  },
};

/**
 * Convenience: refresh a file's node by reading it from disk (post-write) using
 * the default on-disk deps. Best-effort; never throws.
 */
export const refreshGraphFileOnDisk = async (rootPath: string, relPath: string, absPath: string): Promise<void> => {
  try {
    const content = await onDiskKgRefreshDeps.readFile(absPath);
    if (content === null) return;
    await refreshGraphFile(onDiskKgRefreshDeps, rootPath, relPath, content);
  } catch {
    /* best-effort — a failed graph refresh must never fail the write */
  }
};
