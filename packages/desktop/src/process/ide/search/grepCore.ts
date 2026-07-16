/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure text search + replace primitives for the IDE Search surface. No `fs`, no
 * IPC — just string/line logic, so the matching and the replace-preview are
 * fully unit-testable. The bridge layer walks the repo and applies these.
 */

/** A single match inside one file. */
export type GrepLineMatch = {
  /** 1-based line number. */
  line: number;
  /** The full matching line text (trimmed of trailing newline). */
  text: string;
};

/** Search options. */
export type GrepOptions = {
  /** Case-sensitive match. Default false. */
  caseSensitive?: boolean;
  /** Treat the query as a JS regular expression. Default false (literal). */
  regex?: boolean;
  /** Whole-word match only. Default false. */
  wholeWord?: boolean;
};

/** Escape a literal string for safe use inside a RegExp. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build the RegExp for a query + options. Throws when `regex` is set and the
 * query is not a valid pattern (the caller surfaces that as a user error).
 */
export const buildSearchRegExp = (query: string, opts: GrepOptions = {}): RegExp => {
  let source = opts.regex ? query : escapeRegExp(query);
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  const flags = opts.caseSensitive ? 'g' : 'gi';
  return new RegExp(source, flags);
};

/** Find every matching line in a file's text. Returns [] when none match. */
export const grepText = (content: string, query: string, opts: GrepOptions = {}): GrepLineMatch[] => {
  if (query.length === 0) return [];
  const re = buildSearchRegExp(query, opts);
  const out: GrepLineMatch[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    re.lastIndex = 0;
    if (re.test(line)) {
      out.push({ line: i + 1, text: line.trim().slice(0, 400) });
    }
  }
  return out;
};

/** Result of applying a replace to one file's content. */
export type ReplaceResult = {
  /** The new content after replacement. */
  content: string;
  /** Number of individual occurrences replaced. */
  count: number;
};

/**
 * Replace all occurrences of `query` with `replacement` in `content`.
 * Supports regex capture groups in `replacement` (e.g. `$1`) when `regex` is on
 * (native `String.replace` expansion). Returns the new content + the number of
 * replacements (0 = nothing changed).
 */
export const replaceInText = (
  content: string,
  query: string,
  replacement: string,
  opts: GrepOptions = {}
): ReplaceResult => {
  if (query.length === 0) return { content, count: 0 };
  const re = buildSearchRegExp(query, opts);
  let count = 0;
  // Count matches first (a separate scan, so the count is exact regardless of
  // how the replacement string expands).
  const counter = buildSearchRegExp(query, opts);
  while (counter.exec(content) !== null) {
    count++;
    // Guard against zero-width matches looping forever.
    if (counter.lastIndex === 0) counter.lastIndex++;
  }
  if (count === 0) return { content, count: 0 };
  // For a literal (non-regex) query, escape `$` in the replacement so it is not
  // treated as a capture-group reference. For a regex query, pass it through so
  // `$1`-style references work.
  const safeReplacement = opts.regex ? replacement : replacement.replace(/\$/g, '$$$$');
  const next = content.replace(re, safeReplacement);
  return { content: next, count };
};
