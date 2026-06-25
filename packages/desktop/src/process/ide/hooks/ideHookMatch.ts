/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure matching helpers for IDE Agent Hooks: decide whether a changed file's
 * workspace-relative path matches a hook's glob patterns. Kept dependency-free
 * (no `fs`, no Node globals) so it is trivially unit-testable and shareable.
 *
 * Supported glob syntax (a practical subset, enough for hook file filters):
 *   - `*`   → any run of characters except `/`
 *   - `**`  → any run of characters including `/` (spans directories)
 *   - `?`   → exactly one character except `/`
 *   - everything else is literal (regex-escaped)
 *
 * Matching is case-insensitive and slash-normalised (Windows `\` → `/`), so the
 * same pattern works on every platform.
 */

/** Normalise a path to forward slashes, lower-case, no leading `./` or `/`. */
export const normaliseRelPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();

/** Escape a literal run for use inside a RegExp. */
const escapeLiteral = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/**
 * Compile a single glob pattern into a RegExp. Tokens `**`, `*`, `?` are
 * translated; all other characters are literal. The pattern is anchored
 * (full-path match). A bare `*.ts`-style pattern (no slash) also matches the
 * file's BASENAME, so `*.ts` matches `src/a/b.ts` — the common user intent.
 */
export const globToRegExp = (glob: string): RegExp => {
  const normalised = normaliseRelPath(glob);
  let out = '';
  for (let i = 0; i < normalised.length; i++) {
    const ch = normalised[i];
    if (ch === '*') {
      if (normalised[i + 1] === '*') {
        // `**` (optionally followed by `/`) spans directory separators.
        out += '.*';
        i++;
        if (normalised[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeLiteral(ch);
    }
  }
  return new RegExp(`^${out}$`);
};

/** Whether `relPath` matches a single glob pattern (path or basename). */
export const matchesGlob = (relPath: string, glob: string): boolean => {
  const path = normaliseRelPath(relPath);
  const re = globToRegExp(glob);
  if (re.test(path)) return true;
  // A pattern with no slash also matches the basename anywhere in the tree.
  if (!normaliseRelPath(glob).includes('/')) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return re.test(base);
  }
  return false;
};

/**
 * Whether `relPath` matches a hook's pattern list. An EMPTY list means
 * "match any file" (the hook is not path-filtered). Otherwise the file matches
 * if it matches ANY pattern.
 */
export const matchesAnyPattern = (relPath: string, patterns: readonly string[]): boolean => {
  if (patterns.length === 0) return true;
  return patterns.some((p) => p.trim().length > 0 && matchesGlob(relPath, p));
};
