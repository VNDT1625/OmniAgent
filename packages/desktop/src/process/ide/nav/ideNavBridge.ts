/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE Navigation IPC bridge — heuristic go-to-definition / find-references over
 * the open folder, using Node `fs` + the pure {@link symbolNav} helpers. This is
 * a lightweight, language-agnostic alternative to a full LSP: it greps the repo
 * for declaration sites (def) and word-boundary occurrences (refs) of a symbol.
 *
 * Channels (always-resolving envelopes):
 *  - `ide.find-definition` — declaration sites of a symbol across the repo.
 *  - `ide.find-references` — all references of a symbol across the repo.
 *
 * The global bootstrap calls {@link registerIdeNavBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { findDeclarations, findReferences, isIdentifier, type SymbolHit } from './symbolNav';

/** IPC channel names for the IDE nav surface (renderer-safe contract). */
export const IDE_NAV_CHANNELS = {
  findDefinition: 'ide.find-definition',
  findReferences: 'ide.find-references',
} as const;

/** A symbol hit with its absolute file path. */
export type NavHit = SymbolHit & { path: string };

/** Always-resolving result envelope. */
export type IdeNavResult = { ok: true; data: NavHit[] } | { ok: false; error: string };

/** Request for the nav channels. */
export type NavRequest = {
  rootPath: string;
  /** The identifier to locate. */
  symbol: string;
  /** Max hits to return (default 200). */
  maxResults?: number;
};

/** Typed channels. Exported for bootstrap registration wiring. */
export const ideNavChannels = {
  findDefinition: bridge.buildProvider<IdeNavResult, NavRequest>(IDE_NAV_CHANNELS.findDefinition),
  findReferences: bridge.buildProvider<IdeNavResult, NavRequest>(IDE_NAV_CHANNELS.findReferences),
};

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', 'target', '.mtui']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 20000;

const isCodeFile = (name: string): boolean => CODE_EXT.has(path.extname(name).toLowerCase());

/** Recursively collect code-file paths under `root` (bounded). */
const collectCodeFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop() as string;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && isCodeFile(entry.name)) {
        out.push(path.join(dir, entry.name));
        if (out.length >= MAX_FILES) break;
      }
    }
  }
  return out;
};

/** Walk the repo and apply a per-file scanner (def or refs). */
const scanRepo = async (req: NavRequest, scan: (content: string, symbol: string) => SymbolHit[]): Promise<NavHit[]> => {
  const root = req.rootPath?.trim();
  if (!root) throw new Error('A folder path is required.');
  if (!isIdentifier(req.symbol ?? '')) return [];
  const maxResults = req.maxResults ?? 200;
  const files = await collectCodeFiles(root);
  const out: NavHit[] = [];
  for (const file of files) {
    if (out.length >= maxResults) break;
    const stat = await fsp.stat(file).catch((): null => null);
    if (!stat || stat.size > MAX_FILE_BYTES) continue;
    const content = await fsp.readFile(file, 'utf-8').catch((): null => null);
    if (content === null) continue;
    for (const hit of scan(content, req.symbol)) {
      out.push({ ...hit, path: file });
      if (out.length >= maxResults) break;
    }
  }
  return out;
};

/**
 * Register the IDE nav IPC handlers. Idempotent. Intended to be called once
 * during Main-process bootstrap.
 */
export function registerIdeNavBridge(): void {
  ideNavChannels.findDefinition.provider(async (req): Promise<IdeNavResult> => {
    try {
      return { ok: true, data: await scanRepo(req, findDeclarations) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideNavChannels.findReferences.provider(async (req): Promise<IdeNavResult> => {
    try {
      return { ok: true, data: await scanRepo(req, findReferences) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
