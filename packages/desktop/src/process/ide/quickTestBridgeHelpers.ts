/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared helpers for the Quick Test bridge — extracted to avoid a circular
 * import between `quickTestBridge` and `knowledgeGraphBridge`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { KnowledgeGraph } from './understandTypes';

const resolveStorageDir = (): string => path.join(app.getPath('userData'), 'ide-knowledge');
const graphFileName = (rootPath: string): string =>
  `${createHash('sha256').update(rootPath).digest('hex').slice(0, 32)}.json`;

/** Normalize a root path enough to compare duplicate parent/child folder shells. */
const normRoot = (rootPath: string): string => path.resolve(rootPath).replace(/[\\/]+$/, '');

/** Read a persisted KG by exact root path hash. */
const loadGraphExact = async (rootPath: string): Promise<KnowledgeGraph | null> => {
  const target = path.join(resolveStorageDir(), graphFileName(normRoot(rootPath)));
  try {
    const text = await fsp.readFile(target, 'utf-8');
    return JSON.parse(text) as KnowledgeGraph;
  } catch {
    return null;
  }
};

/** Basename that works for both Windows and POSIX path strings. */
const pathBasename = (input: string): string => {
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
};

/** Whether a directory exists. */
const isDirectory = async (target: string): Promise<boolean> => {
  try {
    return (await fsp.stat(target)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Candidate roots that may own the same real project when the user opens a
 * duplicate shell like `a/a/main`: the wiki may have been built for `a` while
 * Quick Test is opened on the inner `a/main`, or vice versa.
 */
const graphRootCandidates = async (rootPath: string): Promise<string[]> => {
  const start = normRoot(rootPath);
  const candidates = [start];
  const base = pathBasename(start).toLowerCase();
  let current = start;

  for (let depth = 0; depth < 4; depth += 1) {
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    const parentBase = pathBasename(parent).toLowerCase();
    if (parentBase === base || (await isDirectory(path.join(parent, 'wiki')))) {
      candidates.push(parent);
      current = parent;
      continue;
    }
    break;
  }

  return Array.from(new Set(candidates));
};

/** Load the persisted KG for a repo root, or null when absent. */
export const loadGraph = async (rootPath: string): Promise<KnowledgeGraph | null> => {
  for (const candidate of await graphRootCandidates(rootPath)) {
    // eslint-disable-next-line no-await-in-loop -- candidates are ordered by trust: exact root, then parent wiki shells.
    const graph = await loadGraphExact(candidate);
    if (graph) return graph;
  }
  return null;
};
