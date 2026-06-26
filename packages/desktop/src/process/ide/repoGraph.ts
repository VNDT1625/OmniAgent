/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lightweight intra-repo import/dependency graph extraction for the IDE
 * "repo-intelligence" feature. The goal is to help a user UNDERSTAND a
 * codebase by surfacing how its own modules import one another — not to be a
 * full module resolver.
 *
 * {@link buildGraphFromFiles} is a PURE function: given a set of files (relative
 * path + content) it parses import/require/dynamic-import specifiers with
 * regex, resolves RELATIVE specifiers against the importer's directory, and
 * emits a deduplicated node/edge graph. Bare/package specifiers (e.g. `react`,
 * `@scope/x`) are ignored — only intra-repo edges are graphed. To keep the
 * function portable and trivially testable it does NOT touch `node:path`;
 * instead it relies on the small string-based posix helpers below.
 *
 * {@link collectRepoFiles} is a thin, dependency-injected directory walker: the
 * caller supplies `listDir`/`readFile`/`toRel` so this module never imports
 * Electron or `fs` directly (Main-process friendly, unit-testable).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** A graph node — one file in the repo. */
export type GraphNode = {
  /** Relative file path (forward-slash normalized). Stable identity. */
  id: string;
  /** Basename of the file (last path segment). */
  label: string;
  /** Top-level folder, or file extension when the file sits at the root. */
  group: string;
};

/** A directed graph edge: `from` (importer) depends on `to` (imported). */
export type GraphEdge = {
  /** Relative path of the importing file. */
  from: string;
  /** Relative path of the imported file (resolved within the provided set). */
  to: string;
};

/** The full extracted repo graph. */
export type RepoGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Absolute root path the graph was built for (passed through verbatim). */
  rootPath: string;
  /** Number of files represented as nodes. */
  fileCount: number;
  /** True when the caller provided an already-capped file list. */
  truncated: boolean;
};

/** Code file extensions whose imports we parse (and that `codeOnly` keeps). */
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/** Extensions tried when resolving an extensionless relative specifier. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/** Directory names skipped while walking a repository. */
const IGNORED_DIRS = new Set([
  '.aionui',
  '.cache',
  '.git',
  '.mtui',
  '.next',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
]);

/** Directories listed per walker turn; keeps IO parallel without flooding disks. */
const WALK_DIR_BATCH_SIZE = 16;

const fsPathBasename = (input: string): string => {
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
};

const stripRelPrefix = (relPath: string, prefix: string): string => {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const cleanPrefix = prefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleanPrefix.length === 0 || normalized === cleanPrefix) {
    return normalized;
  }
  return normalized.startsWith(`${cleanPrefix}/`) ? normalized.slice(cleanPrefix.length + 1) : normalized;
};

const resolveDuplicateNestedRoot = async (rootPath: string, deps: CollectRepoFilesDeps): Promise<string> => {
  const entries = await deps
    .listDir(rootPath)
    .catch(() => [] as Array<{ name: string; fullPath: string; isDir: boolean }>);
  const candidateDirs = entries.filter((entry) => entry.isDir && !IGNORED_DIRS.has(entry.name.toLowerCase()));
  const hasFiles = entries.some((entry) => !entry.isDir);
  const onlyDir = candidateDirs.length === 1 ? candidateDirs[0] : undefined;
  if (!hasFiles && onlyDir && onlyDir.name.toLowerCase() === fsPathBasename(rootPath).toLowerCase()) {
    return onlyDir.fullPath;
  }
  return rootPath;
};

// ---------------------------------------------------------------------------
// String-based posix path helpers (no node:path — keeps the parser portable).
// ---------------------------------------------------------------------------

/** Normalize separators to `/` and collapse `.`/`..` segments. */
const normalizePosix = (input: string): string => {
  const isAbsolute = input.startsWith('/');
  const segments = input.replace(/\\/g, '/').split('/');
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push('..');
      }
      continue;
    }
    stack.push(segment);
  }
  const joined = stack.join('/');
  return isAbsolute ? `/${joined}` : joined;
};

/** Posix dirname: the path minus its last segment (`''` when none remains). */
const dirnamePosix = (input: string): string => {
  const normalized = input.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) {
    return '';
  }
  if (idx === 0) {
    return '/';
  }
  return normalized.slice(0, idx);
};

/** Posix join + normalize for an arbitrary number of segments. */
const joinPosix = (...parts: string[]): string => {
  const filtered = parts.filter((part) => part.length > 0);
  return normalizePosix(filtered.join('/'));
};

// ---------------------------------------------------------------------------
// Import-specifier extraction
// ---------------------------------------------------------------------------

/**
 * Regexes covering the specifier forms we support. Each capture group #1 (or
 * the first non-empty group) holds the raw specifier string.
 *
 * - `import ... from '...'` / `export ... from '...'`
 * - bare side-effect `import '...'`
 * - `require('...')`
 * - dynamic `import('...')`
 */
const IMPORT_FROM_RE = /(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const IMPORT_BARE_RE = /import\s*['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Extract every import/require/dynamic-import specifier from source text. */
const extractSpecifiers = (content: string): string[] => {
  const found: string[] = [];
  const collect = (re: RegExp): void => {
    re.lastIndex = 0;
    let match = re.exec(content);
    while (match !== null) {
      if (typeof match[1] === 'string' && match[1].length > 0) {
        found.push(match[1]);
      }
      match = re.exec(content);
    }
  };
  collect(IMPORT_FROM_RE);
  collect(IMPORT_BARE_RE);
  collect(REQUIRE_RE);
  collect(DYNAMIC_IMPORT_RE);
  return found;
};

/** Whether `relPath` names a code file we parse for imports. */
const isCodeFile = (relPath: string): boolean => CODE_EXTENSIONS.some((ext) => relPath.toLowerCase().endsWith(ext));

/** Whether a specifier is intra-repo (relative) vs a bare package import. */
const isRelativeSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';

/**
 * Reduce a bare import specifier to its package name, keeping the scope:
 * `@scope/pkg/sub` → `@scope/pkg`, `lodash/merge` → `lodash`, `node:fs` → null
 * (Node built-ins are not external packages we want to surface). Returns `null`
 * for relative specifiers and built-ins.
 */
export const packageNameOf = (specifier: string): string | null => {
  if (isRelativeSpecifier(specifier) || specifier.length === 0) {
    return null;
  }
  if (specifier.startsWith('node:')) {
    return null;
  }
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  return parts[0];
};

/** Node built-in modules (ignored when surfacing external packages). */
const NODE_BUILTINS = new Set([
  'fs',
  'path',
  'os',
  'crypto',
  'http',
  'https',
  'net',
  'url',
  'util',
  'stream',
  'events',
  'child_process',
  'zlib',
  'buffer',
  'assert',
  'process',
  'tty',
  'readline',
  'worker_threads',
  'cluster',
  'dns',
  'module',
]);

/**
 * Extract the repo's external (package) dependencies from a set of files, ranked
 * by how many files import each. Pure — counts unique (file, package) pairs so a
 * file importing `react` twice counts once. Node built-ins are skipped. Used to
 * give the C4 "Context" level real system boundaries.
 */
export const extractExternals = (
  files: Array<{ relPath: string; content: string }>,
  limit = 24
): Array<{ name: string; usedBy: number }> => {
  const usedBy = new Map<string, Set<string>>();
  for (const file of files) {
    if (!isCodeFile(file.relPath)) {
      continue;
    }
    for (const specifier of extractSpecifiers(file.content)) {
      const pkg = packageNameOf(specifier);
      if (pkg === null || NODE_BUILTINS.has(pkg)) {
        continue;
      }
      let set = usedBy.get(pkg);
      if (!set) {
        set = new Set<string>();
        usedBy.set(pkg, set);
      }
      set.add(file.relPath);
    }
  }
  return Array.from(usedBy.entries())
    .map(([name, fileSet]) => ({ name, usedBy: fileSet.size }))
    .toSorted((a, b) => (b.usedBy !== a.usedBy ? b.usedBy - a.usedBy : a.name.localeCompare(b.name)))
    .slice(0, limit);
};

/** Top-level folder of a path, or its extension when it sits at the root. */
const groupOf = (relPath: string): string => {
  const slash = relPath.indexOf('/');
  if (slash > 0) {
    return relPath.slice(0, slash);
  }
  const dot = relPath.lastIndexOf('.');
  if (dot > 0) {
    return relPath.slice(dot);
  }
  return relPath;
};

/** Basename (last segment) of a forward-slash path. */
const basenameOf = (relPath: string): string => {
  const slash = relPath.lastIndexOf('/');
  return slash >= 0 ? relPath.slice(slash + 1) : relPath;
};

/**
 * Resolve a relative `specifier` (from a file at `fromРel`) to a known file in
 * `known`. Tries, in order: the literal target, the target with each code
 * extension, then `target/index.<ext>`. Returns `null` when unresolved.
 */
const resolveRelative = (fromRel: string, specifier: string, known: Set<string>): string | null => {
  const baseDir = dirnamePosix(fromRel);
  const target = joinPosix(baseDir, specifier);

  if (known.has(target)) {
    return target;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = `${target}${ext}`;
    if (known.has(candidate)) {
      return candidate;
    }
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = joinPosix(target, `index${ext}`);
    if (known.has(candidate)) {
      return candidate;
    }
  }
  return null;
};

/**
 * Build a lightweight intra-repo import graph from a set of files.
 *
 * Pure: no fs/network/`node:path`. The `files` array carries each file's
 * relative path and full text content. Keeps every provided file so retrieval
 * never loses source files just because a UI or semantic-summary layer has a
 * budget. Edges are deduplicated and self-edges are dropped.
 */
export const buildGraphFromFiles = (
  rootPath: string,
  files: Array<{ relPath: string; content: string }>
): RepoGraph => {
  // Normalize relative paths up-front and de-duplicate by id (first wins).
  const normalized: Array<{ relPath: string; content: string }> = [];
  const seenRel = new Set<string>();
  for (const file of files) {
    const relPath = file.relPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (seenRel.has(relPath)) {
      continue;
    }
    seenRel.add(relPath);
    normalized.push({ relPath, content: file.content });
  }

  const knownIds = new Set<string>(normalized.map((file) => file.relPath));

  const nodes: GraphNode[] = normalized.map((file) => ({
    id: file.relPath,
    label: basenameOf(file.relPath),
    group: groupOf(file.relPath),
  }));

  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  for (const file of normalized) {
    if (!isCodeFile(file.relPath)) {
      continue;
    }
    for (const specifier of extractSpecifiers(file.content)) {
      if (!isRelativeSpecifier(specifier)) {
        continue;
      }
      const resolved = resolveRelative(file.relPath, specifier, knownIds);
      if (resolved === null || resolved === file.relPath) {
        continue;
      }
      const key = `${file.relPath}\u0000${resolved}`;
      if (seenEdges.has(key)) {
        continue;
      }
      seenEdges.add(key);
      edges.push({ from: file.relPath, to: resolved });
    }
  }

  return {
    nodes,
    edges,
    rootPath,
    fileCount: nodes.length,
    truncated: false,
  };
};

/** Injected filesystem-ish primitives for {@link collectRepoFiles}. */
export type CollectRepoFilesDeps = {
  /** List the direct entries of a directory. */
  listDir: (dir: string) => Promise<Array<{ name: string; fullPath: string; isDir: boolean }>>;
  /** Read a file's text content. */
  readFile: (path: string) => Promise<string>;
  /** Convert an absolute path to a repo-relative, forward-slash path. */
  toRel: (full: string) => string;
};

/** Options for {@link collectRepoFiles}. */
export type CollectRepoFilesOptions = {
  /** Optional hard cap on the number of files collected. Undefined means no cap. */
  maxFiles?: number;
  /** When true (default) only read code files; otherwise include others empty. */
  codeOnly?: boolean;
  /** Read content for selected non-code files when `codeOnly` is false. */
  readContent?: (relPath: string) => boolean;
};

/**
 * Walk `rootPath` using the injected `deps`, returning files suitable for
 * {@link buildGraphFromFiles}. Skips well-known build/vendor directories. With
 * `codeOnly` (the default) only code files are read. Otherwise non-code files
 * are included and remain empty unless `readContent` selects them for reading.
 *
 * Dependency-injected on purpose: this module never imports Electron or `fs`.
 */
export const collectRepoFiles = async (
  rootPath: string,
  deps: CollectRepoFilesDeps,
  opts?: CollectRepoFilesOptions
): Promise<Array<{ relPath: string; content: string }>> => {
  const maxFiles = opts?.maxFiles ?? Number.POSITIVE_INFINITY;
  const codeOnly = opts?.codeOnly ?? true;
  const effectiveRoot = await resolveDuplicateNestedRoot(rootPath, deps);
  const relRootPrefix = effectiveRoot === rootPath ? '' : deps.toRel(effectiveRoot);

  const collected: Array<{ relPath: string; content: string }> = [];
  const queue: string[] = [effectiveRoot];

  while (queue.length > 0 && collected.length < maxFiles) {
    const dirs = queue.splice(0, WALK_DIR_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop -- each BFS batch discovers the next directories to list.
    const listed = await Promise.all(
      dirs.map(async (dir) =>
        (await deps.listDir(dir).catch(() => [] as Array<{ name: string; fullPath: string; isDir: boolean }>)).toSorted(
          (a, b) => a.name.localeCompare(b.name)
        )
      )
    );

    const fileReads: Array<{ relPath: string; fullPath: string; read: boolean }> = [];
    for (const entries of listed) {
      if (collected.length + fileReads.length >= maxFiles) {
        break;
      }
      for (const entry of entries) {
        if (collected.length + fileReads.length >= maxFiles) {
          break;
        }
        if (entry.isDir) {
          if (!IGNORED_DIRS.has(entry.name.toLowerCase())) {
            queue.push(entry.fullPath);
          }
          continue;
        }

        const relPath = stripRelPrefix(deps.toRel(entry.fullPath), relRootPrefix);
        const code = isCodeFile(relPath);
        if (code || !codeOnly) {
          fileReads.push({ relPath, fullPath: entry.fullPath, read: code || Boolean(opts?.readContent?.(relPath)) });
        }
      }
    }
    // eslint-disable-next-line no-await-in-loop -- file reads within the current BFS batch run in parallel.
    const files = await Promise.all(
      fileReads.map(async (file) => ({
        relPath: file.relPath,
        content: file.read ? await deps.readFile(file.fullPath).catch(() => '') : '',
      }))
    );
    collected.push(...files);
  }

  return collected;
};
