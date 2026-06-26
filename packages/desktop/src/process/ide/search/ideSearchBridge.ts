/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE Search IPC bridge — project-wide text search + replace over the open
 * folder, using Node `fs` (the renderer cannot walk disk) and the pure
 * {@link grepCore} primitives.
 *
 * Channels (always-resolving envelopes):
 *  - `ide.grep`           — search all text files; returns flat matches.
 *  - `ide.replace-file`   — replace in ONE file (via the MTUI write gateway so
 *    the edit is backed-up / undoable / policy-tracked).
 *
 * The global bootstrap calls {@link registerIdeSearchBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { grepText, replaceInText, buildSearchRegExp, type GrepOptions } from './grepCore';
import { writeTextFileWithMtui } from '@process/terminal/mtuiBridge';

/** IPC channel names for the IDE search surface (renderer-safe contract). */
export const IDE_SEARCH_CHANNELS = {
  grep: 'ide.grep',
  replaceFile: 'ide.replace-file',
} as const;

/** One flat search match (mirrors the renderer's GrepMatch). */
export type IdeGrepMatch = {
  /** Absolute file path. */
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column of the first match on the line. */
  column: number;
  /** The matching line text (trimmed). */
  text: string;
};

/** Always-resolving result envelope. */
export type IdeSearchResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Request for {@link IDE_SEARCH_CHANNELS.grep}. */
export type GrepRequest = {
  rootPath: string;
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  /**
   * Optional glob pattern to restrict which files are searched.
   * Examples: `*.ts`, `**\/*.test.ts`, `src\/**\/*.vue`
   * Patterns without `/` are matched against the basename only.
   * Mirrors the `glob` parameter of the built-in `Grep` tool.
   */
  glob?: string;
  /** Max matches to return (default 1000). */
  maxResults?: number;
};

/** Request for {@link IDE_SEARCH_CHANNELS.replaceFile}. */
export type ReplaceFileRequest = {
  /** Absolute file path. */
  path: string;
  query: string;
  replacement: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
};

/** Typed channels. Exported for bootstrap registration wiring. */
export const ideSearchChannels = {
  grep: bridge.buildProvider<IdeSearchResult<IdeGrepMatch[]>, GrepRequest>(IDE_SEARCH_CHANNELS.grep),
  replaceFile: bridge.buildProvider<IdeSearchResult<number>, ReplaceFileRequest>(IDE_SEARCH_CHANNELS.replaceFile),
};

/** Directory names skipped during the walk (build/vendor noise). */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'coverage',
  '.cache',
  'target',
  '.mtui',
]);

// ---------------------------------------------------------------------------
// Glob pattern matching (shared with ideFileBridge logic, inlined here so this
// module stays self-contained with no circular import).
// ---------------------------------------------------------------------------
const globToRegExp = (pattern: string): RegExp => {
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        i += 2;
        if (p[i] === '/') i++;
        re += '(?:.+/)?';
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '{') {
      const end = p.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i++;
      } else {
        re += `(?:${p
          .slice(i + 1, end)
          .split(',')
          .map((s) => globToRegExp(s).source.slice(1, -1))
          .join('|')})`;
        i = end + 1;
      }
    } else if (ch === '[') {
      const end = p.indexOf(']', i);
      if (end === -1) {
        re += '\\[';
        i++;
      } else {
        re += p.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`, 'i');
};

const matchGlob = (relPath: string, pattern: string): boolean => {
  const norm = relPath.replace(/\\/g, '/');
  const hasSlash = pattern.replace(/\\/g, '/').includes('/');
  const re = globToRegExp(pattern);
  if (hasSlash) return re.test(norm);
  return re.test(norm.split('/').pop() ?? norm);
};

/** Extensions treated as searchable text. */
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.vue',
  '.svelte',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.rb',
  '.php',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.sh',
  '.yml',
  '.yaml',
  '.toml',
  '.xml',
  '.txt',
  '.sql',
  '.kt',
  '.swift',
]);

/** Per-file size cap (skip very large files to keep search fast). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Hard cap on files walked, to bound a pathological repo. */
const MAX_FILES_WALKED = 20000;
/** Folder-walk concurrency: enough to speed large repos without thrashing disk. */
const WALK_CONCURRENCY = 12;
/** File-read concurrency for grep. Kept bounded so the Main process remains responsive. */
const GREP_CONCURRENCY = 32;

const isTextFile = (name: string): boolean => TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());

type DirectoryScan = {
  dir: string;
  entries: Dirent[];
};

const sortByName = (a: Dirent, b: Dirent): number => a.name.localeCompare(b.name);

const sortByLocation = (a: IdeGrepMatch, b: IdeGrepMatch): number => {
  const pathOrder = a.path.localeCompare(b.path);
  if (pathOrder !== 0) return pathOrder;
  return a.line - b.line;
};

const runLimited = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: Array<R | undefined> = Array.from({ length: items.length }, (): R | undefined => undefined);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    const index = next++;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    await runWorker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
  return results.map((result): R => {
    if (result === undefined) throw new Error('Concurrent worker did not produce a result.');
    return result;
  });
};

const readDirectory = async (dir: string): Promise<DirectoryScan> => ({
  dir,
  entries: await fsp.readdir(dir, { withFileTypes: true }).catch((_error): Dirent[] => []),
});

/** Recursively collect text-file paths under `root` (bounded). */
export const collectFiles = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const walkLevel = async (dirs: string[]): Promise<void> => {
    if (dirs.length === 0 || out.length >= MAX_FILES_WALKED) return;
    const nextDirs: string[] = [];
    const scans = await runLimited(dirs, WALK_CONCURRENCY, readDirectory);
    for (const scan of scans) {
      for (const entry of scan.entries.toSorted(sortByName)) {
        if (out.length >= MAX_FILES_WALKED) break;
        const fullPath = path.join(scan.dir, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) nextDirs.push(fullPath);
        } else if (entry.isFile() && isTextFile(entry.name)) {
          out.push(fullPath);
        }
      }
    }
    await walkLevel(nextDirs);
  };
  await walkLevel([root]);
  return out.toSorted((a, b) => a.localeCompare(b));
};

const grepFile = async (
  file: string,
  root: string,
  query: string,
  opts: GrepOptions,
  glob?: string
): Promise<IdeGrepMatch[]> => {
  const stat = await fsp.stat(file).catch((_error): null => null);
  if (!stat || stat.size > MAX_FILE_BYTES) return [];
  // Apply glob filter before reading file content (avoids disk I/O).
  if (glob) {
    const rel = path.relative(root, file).replace(/\\/g, '/');
    if (!matchGlob(rel, glob)) return [];
  }
  const content = await fsp.readFile(file, 'utf-8').catch((_error): null => null);
  if (content === null) return [];
  const re = buildSearchRegExp(query, opts);
  return grepText(content, query, opts).map((m) => {
    const lineText = content.split('\n')[m.line - 1] ?? '';
    re.lastIndex = 0;
    const match = re.exec(lineText);
    return { path: file, line: m.line, column: match ? match.index + 1 : 1, text: m.text };
  });
};

/** Walk the repo and return all matching lines (bounded by `maxResults`). */
export const grepRepo = async (req: GrepRequest): Promise<IdeGrepMatch[]> => {
  const root = req.rootPath?.trim();
  if (!root) throw new Error('A folder path is required.');
  if (!req.query || req.query.length === 0) return [];
  const opts: GrepOptions = { caseSensitive: req.caseSensitive, regex: req.regex, wholeWord: req.wholeWord };
  const maxResults = req.maxResults ?? 1000;
  const files = await collectFiles(root);
  const out: IdeGrepMatch[] = [];
  let next = 0;
  const runWorker = async (): Promise<void> => {
    if (out.length >= maxResults) return;
    const file = files[next++];
    if (!file) return;
    const matches = await grepFile(file, root, req.query, opts, req.glob);
    if (matches.length > 0 && out.length < maxResults) {
      out.push(...matches.slice(0, maxResults - out.length));
    }
    await runWorker();
  };
  await Promise.all(Array.from({ length: Math.min(GREP_CONCURRENCY, files.length) }, () => runWorker()));
  return out.toSorted(sortByLocation).slice(0, maxResults);
};

/** Replace in a single file via the MTUI write gateway; returns the count. */
const replaceFile = async (req: ReplaceFileRequest): Promise<number> => {
  const filePath = req.path?.trim();
  if (!filePath) throw new Error('A file path is required.');
  const content = await fsp.readFile(filePath, 'utf-8');
  const opts: GrepOptions = { caseSensitive: req.caseSensitive, regex: req.regex, wholeWord: req.wholeWord };
  const result = replaceInText(content, req.query, req.replacement, opts);
  if (result.count === 0) return 0;
  const write = await writeTextFileWithMtui(filePath, result.content);
  if (!write.ok) throw new Error(String(write.message ?? 'MTUI write failed'));
  return result.count;
};

/**
 * Register the IDE search IPC handlers. Idempotent. Intended to be called once
 * during Main-process bootstrap.
 */
export function registerIdeSearchBridge(): void {
  ideSearchChannels.grep.provider(async (req): Promise<IdeSearchResult<IdeGrepMatch[]>> => {
    try {
      return { ok: true, data: await grepRepo(req) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideSearchChannels.replaceFile.provider(async (req): Promise<IdeSearchResult<number>> => {
    try {
      return { ok: true, data: await replaceFile(req) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
