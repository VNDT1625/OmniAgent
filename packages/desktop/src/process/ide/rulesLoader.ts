/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `rulesLoader` — reads project governance rules from well-known files in a
 * repo root and returns them as a string array for the Context Builder.
 *
 * Supported files (checked in priority order, first found wins):
 *   1. `.aionrules`   — Omni-native rules file (Markdown, one rule per line or block)
 *   2. `AGENTS.md`    — Claude Code / Kiro convention (already used by this repo)
 *   3. `.cursorrules` — Cursor convention (many repos already have this)
 *
 * The content is split into non-empty lines and returned as individual rule
 * strings so the Context Builder can prepend them to the agent brief. Lines
 * starting with `#` (Markdown headings) are kept as section headers.
 *
 * Pure + dependency-injected (fs is injected) so it is unit-testable without
 * real disk. Silently returns `[]` when no rules file is found — the IDE Chat
 * still works, just without project-specific rules.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as path from 'node:path';

/** Candidate filenames checked in order (first found wins). */
const RULES_FILES = ['.aionrules', 'AGENTS.md', '.cursorrules'] as const;

/** Max bytes read from a rules file (prevents huge files from bloating context). */
const MAX_BYTES = 32 * 1024; // 32 KB

/** Injected fs surface (subset of `fs/promises`). */
export type RulesLoaderFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
};

/** Default fs backed by Node `fs/promises`. */
export const defaultRulesLoaderFs: RulesLoaderFs = {
  readFile: async (filePath, encoding) => {
    const { promises: fsp } = await import('node:fs');
    return fsp.readFile(filePath, encoding);
  },
};

/**
 * Load project rules from the first matching rules file in `rootPath`.
 * Returns an array of non-empty rule strings (lines), or `[]` when no file
 * is found or the file is empty. Silently swallows read errors.
 */
export const loadProjectRules = async (
  rootPath: string,
  fs: RulesLoaderFs = defaultRulesLoaderFs
): Promise<string[]> => {
  for (const filename of RULES_FILES) {
    const filePath = path.join(rootPath, filename);
    try {
      let content = await fs.readFile(filePath, 'utf-8');
      // Truncate to budget to avoid bloating the agent context.
      if (content.length > MAX_BYTES) {
        content = content.slice(0, MAX_BYTES) + '\n[rules file truncated]';
      }
      const lines = content
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
      if (lines.length > 0) {
        return lines;
      }
    } catch {
      // File not found or unreadable — try the next candidate.
    }
  }
  return [];
};
