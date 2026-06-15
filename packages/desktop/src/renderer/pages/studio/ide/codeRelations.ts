/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers that turn the codebase graph into in-editor awareness — the glue
 * behind "hover an import to see what that file is" and "what does editing this
 * file affect". No `fs`/IPC/React, so it is fully unit-testable: callers feed it
 * a graph (nodes + import edges) + the active file, and it answers structural
 * questions deterministically.
 *
 * Mirrors the resolution rules of {@link file://../../../process/ide/repoGraph.ts}
 * (relative specifiers only, try the literal target then code extensions then
 * `index.*`) so an import string resolves to the same node id the graph used.
 *
 * Process boundary: renderer-safe (no Node APIs used here).
 */

/** Extensions tried when resolving an extensionless relative specifier. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/** The import-specifier forms we detect on a single line of source. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/,
  /\bimport\s*['"]([^'"]+)['"]/,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/,
];

/** Whether a specifier is intra-repo (relative) vs a bare package import. */
export const isRelativeSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';

/** Normalize separators to `/` and collapse `.`/`..` segments (posix, pure). */
const normalizePosix = (input: string): string => {
  const segments = input.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop();
      else stack.push('..');
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
};

/** Posix dirname: the path minus its last segment. */
const dirnamePosix = (input: string): string => {
  const normalized = input.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? '' : normalized.slice(0, idx);
};

/** Extract the import specifier on a line of source, or `null` when it is not an import. */
export const importSpecifierOnLine = (line: string): string | null => {
  // Skip commented-out lines so hovering a disabled import shows nothing.
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*')) return null;
  for (const pattern of SPECIFIER_PATTERNS) {
    const match = pattern.exec(line);
    if (match && typeof match[1] === 'string' && match[1].length > 0) return match[1];
  }
  return null;
};

/**
 * Resolve a RELATIVE import specifier (from a file at `fromRel`) to a known node
 * id. Tries the literal target, then each code extension, then `index.<ext>`.
 * Returns `null` for bare/package specifiers or when nothing matches.
 */
export const resolveImport = (fromRel: string, specifier: string, knownIds: ReadonlySet<string>): string | null => {
  if (!isRelativeSpecifier(specifier)) return null;
  const baseDir = dirnamePosix(fromRel.replace(/\\/g, '/'));
  const target = normalizePosix(baseDir.length > 0 ? `${baseDir}/${specifier}` : specifier);
  if (knownIds.has(target)) return target;
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${target}${ext}`;
    if (knownIds.has(candidate)) return candidate;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = normalizePosix(`${target}/index${ext}`);
    if (knownIds.has(candidate)) return candidate;
  }
  return null;
};

/** A file's structural relations within the repo graph. */
export type FileRelations = {
  /** Node ids this file imports (its direct dependencies). */
  dependsOn: string[];
  /** Node ids that import this file (who an edit here may affect). */
  usedBy: string[];
};

/** Compute a file's depends-on / used-by sets from the graph's import edges. */
export const relationsFor = (
  activeRel: string,
  edges: ReadonlyArray<{ from: string; to: string }>
): FileRelations => {
  const dependsOn = new Set<string>();
  const usedBy = new Set<string>();
  for (const edge of edges) {
    if (edge.from === activeRel) dependsOn.add(edge.to);
    if (edge.to === activeRel) usedBy.add(edge.from);
  }
  return { dependsOn: [...dependsOn].toSorted(), usedBy: [...usedBy].toSorted() };
};
