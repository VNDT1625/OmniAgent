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

/** Load the persisted KG for a repo root, or null when absent. */
export const loadGraph = async (rootPath: string): Promise<KnowledgeGraph | null> => {
  const target = path.join(resolveStorageDir(), graphFileName(rootPath));
  try {
    const text = await fsp.readFile(target, 'utf-8');
    return JSON.parse(text) as KnowledgeGraph;
  } catch {
    return null;
  }
};
