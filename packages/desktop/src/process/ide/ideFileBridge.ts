/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE filesystem IPC bridge — lets the IDE workspace browse, read, and write
 * ARBITRARY folders on disk via Node `fs`.
 *
 * Why this exists: the renderer's existing `fs.*` bridge (`/api/fs/*`) is served
 * by aioncore and is scoped to the active conversation WORKSPACE — it cannot
 * list or read a folder the user opens from anywhere on disk. The IDE needs to
 * open any project folder (exactly like the Map's `ide.scan-repo`, which already
 * uses Node `fs`), so file listing/reading/writing for the IDE goes through this
 * Main-process bridge instead.
 *
 * Channels (all return an always-resolving envelope so the renderer never hangs):
 *  - `ide.list-dir`         — one directory level (dirs first, then files).
 *  - `ide.read-file`        — UTF-8 text content of a file.
 *  - `ide.read-file-base64` — base64 bytes of a file (for binary adapters).
 *  - `ide.write-file`       — write UTF-8 text.
 *  - `ide.write-file-base64`— write decoded base64 bytes (binary-safe).
 *  - `ide.file-watch-start` - start watching a folder for filesystem changes.
 *  - `ide.file-watch-stop`  - stop watching a folder for filesystem changes.
 *  - `ide.file-changed`     - emits filesystem change events.
 *  - `ide.create-dir`       — create a directory (and any missing parents).
 *  - `ide.rename-file`      — rename / move a file or directory.
 *  - `ide.delete-file`      — delete a file or directory (recursive).
 *
 * The global bootstrap calls {@link registerIdeFileBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { loadProjectRules } from './rulesLoader';
import { writeTextFileWithMtui } from '@process/terminal/mtuiBridge';

/** IPC channel names for the IDE filesystem surface (renderer-safe contract). */
export const IDE_FILE_CHANNELS = {
  listDir: 'ide.list-dir',
  readFile: 'ide.read-file',
  readFileBase64: 'ide.read-file-base64',
  writeFile: 'ide.write-file',
  writeFileBase64: 'ide.write-file-base64',
  watchStart: 'ide.file-watch-start',
  watchStop: 'ide.file-watch-stop',
  changed: 'ide.file-changed',
  rulesLoad: 'ide.rules-load',
  createDir: 'ide.create-dir',
  renameFile: 'ide.rename-file',
  deleteFile: 'ide.delete-file',
} as const;

/** One entry in a listed directory. */
export type IdeDirEntry = {
  /** Display name (basename). */
  name: string;
  /** Absolute path. */
  fullPath: string;
  /** Path relative to the requested root (forward-slash). Present for recursive walks. */
  relativePath?: string;
  /** True for a directory, false for a file. */
  isDir: boolean;
  /** File size in bytes (files only, undefined for directories). */
  sizeBytes?: number;
  /** Last-modified timestamp (ms since epoch). */
  mtimeMs?: number;
};

/** Always-resolving result envelope. */
export type IdeFileResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Glob pattern matching — micro-implementation, no external dependency.
// Supports: * (any chars in one segment), ** (any depth), ? (one char),
// {a,b,c} (alternatives), [abc] / [a-z] (char classes).
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a RegExp.
 * Rules:
 *  - `**`  matches zero or more path segments (including none).
 *  - `*`   matches any characters within a single path segment (no `/`).
 *  - `?`   matches exactly one character within a segment (no `/`).
 *  - `{a,b}` expands to `(a|b)`.
 *  - `[abc]` / `[a-z]` — character classes passed through as-is.
 */
const globToRegExp = (pattern: string): RegExp => {
  // Normalise separators.
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // `**` — consume optional surrounding slashes and match any depth.
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
        const alts = p
          .slice(i + 1, end)
          .split(',')
          .map(globToRegExpPart)
          .join('|');
        re += `(?:${alts})`;
        i = end + 1;
      }
    } else if (ch === '[') {
      const end = p.indexOf(']', i);
      if (end === -1) {
        re += '\\[';
        i++;
      } else {
        re += p.slice(i, end + 1); // pass [abc] / [a-z] through verbatim
        i = end + 1;
      }
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`, 'i');
};

/** Convert a single glob alternative (no `{`) to a RegExp fragment. */
const globToRegExpPart = (s: string): string => globToRegExp(s).source.slice(1, -1);

/**
 * Return true when `relPath` (forward-slash, relative to some root) matches the
 * glob `pattern`.  Patterns without a `/` are tested against the basename only
 * (mirrors shell glob behaviour: `*.ts` matches `src/foo.ts`).
 */
const matchGlob = (relPath: string, pattern: string): boolean => {
  const norm = relPath.replace(/\\/g, '/');
  const hasSlash = pattern.replace(/\\/g, '/').includes('/');
  const re = globToRegExp(pattern);
  if (hasSlash) return re.test(norm);
  // Basename-only match when pattern has no directory separator.
  const base = norm.split('/').pop() ?? norm;
  return re.test(base);
};

/** Request shapes. */
export type ListDirRequest = {
  dir: string;
  /**
   * Optional glob pattern — when provided only entries whose name (or relative
   * path for recursive walks) matches are returned.
   * Examples: `*.ts`, `**\/*.test.ts`, `src\/**`
   */
  glob?: string;
  /**
   * When true, walk all subdirectories instead of listing a single level.
   * Ignored directories (node_modules, .git, dist, …) are still skipped.
   */
  recursive?: boolean;
  /** Cap on entries returned (default 100, max 2000). Mirrors `Glob` tool. */
  maxResults?: number;
};

/**
 * Extended read-file request — mirrors the options of `mtui read` and the
 * built-in `Read` tool so that `ide_read_file` is equally capable.
 *
 * - `from` / `to`     : 1-based inclusive line range (both optional). Omitting
 *                       both reads from line 1 up to the default cap (whole file
 *                       for normal-sized files); pass them only for a window.
 * - `maxLines`        : cap on returned lines (default 2000); ignored when `all` is true.
 * - `maxBytes`        : cap on returned characters/bytes (default 200 000); ignored when `all` is true.
 * - `all`             : return the entire file, bypassing line/byte limits.
 * - `lineNumbers`     : prefix every returned line with "N: " (default true).
 */
export type ReadFileRequest = {
  path: string;
  from?: number;
  to?: number;
  maxLines?: number;
  maxBytes?: number;
  all?: boolean;
  lineNumbers?: boolean;
};

/** Structured result returned by `ide.read-file`. */
export type ReadFileData = {
  text: string;
  lineStart: number;
  lineEnd: number;
  totalLines: number;
  returnedLines: number;
  truncated: boolean;
  /** True when the file is binary — `text` will be "(binary file, N bytes)" in that case. */
  binary: boolean;
  /** Raw file size in bytes. */
  sizeBytes: number;
};

export type WriteFileRequest = { path: string; data: string };
export type WriteFileBase64Request = { path: string; dataBase64: string };
export type IdeFileWatchStartRequest = { rootPath: string };
export type IdeFileWatchStopRequest = { rootPath: string };
export type IdeFileChangeEvent = {
  rootPath: string;
  relativePath: string;
  path: string;
  eventType: 'rename' | 'change';
};
export type IdeFileChangeEnvelope = { event: IdeFileChangeEvent };
export type LoadRulesRequest = { rootPath: string };
export type CreateDirRequest = { path: string };
export type RenameFileRequest = { oldPath: string; newPath: string };
export type DeleteFileRequest = { path: string };

/** Typed IDE filesystem channels. Exported for bootstrap registration wiring. */
export const ideFileChannels = {
  listDir: bridge.buildProvider<IdeFileResult<IdeDirEntry[]>, ListDirRequest>(IDE_FILE_CHANNELS.listDir),
  readFile: bridge.buildProvider<IdeFileResult<ReadFileData>, ReadFileRequest>(IDE_FILE_CHANNELS.readFile),
  readFileBase64: bridge.buildProvider<IdeFileResult<string>, ReadFileRequest>(IDE_FILE_CHANNELS.readFileBase64),
  writeFile: bridge.buildProvider<IdeFileResult<boolean>, WriteFileRequest>(IDE_FILE_CHANNELS.writeFile),
  writeFileBase64: bridge.buildProvider<IdeFileResult<boolean>, WriteFileBase64Request>(
    IDE_FILE_CHANNELS.writeFileBase64
  ),
  watchStart: bridge.buildProvider<IdeFileResult<boolean>, IdeFileWatchStartRequest>(IDE_FILE_CHANNELS.watchStart),
  watchStop: bridge.buildProvider<IdeFileResult<boolean>, IdeFileWatchStopRequest>(IDE_FILE_CHANNELS.watchStop),
  changed: bridge.buildEmitter<IdeFileChangeEnvelope>(IDE_FILE_CHANNELS.changed),
  rulesLoad: bridge.buildProvider<IdeFileResult<string[]>, LoadRulesRequest>(IDE_FILE_CHANNELS.rulesLoad),
  createDir: bridge.buildProvider<IdeFileResult<boolean>, CreateDirRequest>(IDE_FILE_CHANNELS.createDir),
  renameFile: bridge.buildProvider<IdeFileResult<boolean>, RenameFileRequest>(IDE_FILE_CHANNELS.renameFile),
  deleteFile: bridge.buildProvider<IdeFileResult<boolean>, DeleteFileRequest>(IDE_FILE_CHANNELS.deleteFile),
};

/** Cap on entries returned for a single directory level (avoid pathological dirs). */
const MAX_DIR_ENTRIES = 2000;

type WatchHandle = {
  watcher: fs.FSWatcher;
  refCount: number;
};

const watchHandles = new Map<string, WatchHandle>();

const normalizeWatchRoot = (rootPath: string): string => {
  const trimmed = rootPath?.trim();
  if (!trimmed) throw new Error('A folder path is required.');
  return path.resolve(trimmed);
};

const emitFileChange = (rootPath: string, eventType: string, filename: string | Buffer | null): void => {
  if (filename === null) return;
  const relativePath = String(filename);
  if (relativePath.length === 0) return;
  const normalizedEventType = eventType === 'change' ? 'change' : 'rename';
  ideFileChannels.changed.emit({
    event: {
      rootPath,
      relativePath,
      path: path.join(rootPath, relativePath),
      eventType: normalizedEventType,
    },
  });
};

const createFileWatcher = (rootPath: string): fs.FSWatcher => {
  const listener = (eventType: string, filename: string | Buffer | null): void => {
    emitFileChange(rootPath, eventType, filename);
  };
  try {
    return fs.watch(rootPath, { recursive: true }, listener);
  } catch (error) {
    if (error instanceof Error && !error.message.toLowerCase().includes('recursive')) throw error;
    return fs.watch(rootPath, listener);
  }
};

const startFileWatch = async (rootPath: string): Promise<boolean> => {
  const normalizedRoot = normalizeWatchRoot(rootPath);
  const stat = await fsp.stat(normalizedRoot);
  if (!stat.isDirectory()) throw new Error('A folder path is required.');

  const existing = watchHandles.get(normalizedRoot);
  if (existing) {
    existing.refCount += 1;
    return true;
  }

  const watcher = createFileWatcher(normalizedRoot);
  watcher.on('error', (error) => {
    console.warn('[IdeFileBridge] file watch failed:', error);
    watchHandles.delete(normalizedRoot);
  });
  watchHandles.set(normalizedRoot, { watcher, refCount: 1 });
  return true;
};

const stopFileWatch = (rootPath: string): boolean => {
  const normalizedRoot = normalizeWatchRoot(rootPath);
  const existing = watchHandles.get(normalizedRoot);
  if (!existing) return true;
  existing.refCount -= 1;
  if (existing.refCount > 0) return true;
  existing.watcher.close();
  watchHandles.delete(normalizedRoot);
  return true;
};

/**
 * Default caps. These match the documented `ide_read_file` contract (2000 lines)
 * and exist only as a SAFETY VALVE for pathologically large files — a normal
 * source file reads WHOLE without the agent passing any range. Agents only need
 * `from`/`to` to read a *specific* window; omitting them reads from line 1 to the
 * default cap. To force a no-cap read of a huge file, pass `all: true`.
 */
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 200_000;

/**
 * Heuristic binary detection: sample up to 8 KB and flag as binary when more
 * than 0.3 % of bytes are NUL or other non-printable control bytes (mirrors
 * the MTUI `is_binary` check in Rust).
 */
const isBinaryBuffer = (buf: Buffer): boolean => {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let nonText = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0 || b < 8 || (b >= 14 && b < 32 && b !== 27)) nonText++;
  }
  return nonText / sample.length > 0.003;
};

/**
 * Read a UTF-8 file with the same options as `mtui read` / the built-in `Read` tool:
 * line range (`from`/`to`), line-number prefix, and line/char limits.
 *
 * Returns a {@link ReadFileData} envelope instead of a raw string so callers
 * can tell whether the result was truncated and which lines were returned.
 */
const readFileSliced = async (req: ReadFileRequest): Promise<ReadFileData> => {
  const buf = await fsp.readFile(req.path);
  const sizeBytes = buf.length;

  // Binary detection — mirrors the built-in `Read` tool's "(binary file, N bytes)" output.
  if (isBinaryBuffer(buf)) {
    return {
      text: `(binary file, ${sizeBytes} bytes)`,
      lineStart: 1,
      lineEnd: 1,
      totalLines: 0,
      returnedLines: 0,
      truncated: false,
      binary: true,
      sizeBytes,
    };
  }

  const raw = buf.toString('utf-8');
  // Normalise line endings so offset counting is consistent on Windows.
  const normalised = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const allLines = normalised.split('\n');
  const totalLines = allLines.length;

  const lineNumbers = req.lineNumbers !== false; // default true
  const all = req.all === true;
  const maxLines = all ? Infinity : (req.maxLines ?? DEFAULT_MAX_LINES);
  const maxBytes = all ? Infinity : (req.maxBytes ?? DEFAULT_MAX_BYTES);

  // Determine the 1-based window requested by `from` / `to`.
  const from = Math.max(1, req.from ?? 1);
  const to = Math.min(totalLines, req.to ?? totalLines);

  if (from > to) {
    throw new Error(`Invalid range: from (${from}) must be ≤ to (${to})`);
  }

  // Slice the requested window, then apply maxLines / maxBytes caps.
  const windowLines = allLines.slice(from - 1, to);

  let charCount = 0;
  let limitedLines: string[] = [];
  let truncated = false;

  for (const line of windowLines) {
    if (limitedLines.length >= maxLines) {
      truncated = true;
      break;
    }
    const candidate = lineNumbers ? `${from + limitedLines.length}: ${line}` : line;
    // Include the line even if it alone exceeds the byte cap (guarantees at least one line).
    if (charCount > 0 && charCount + candidate.length + 1 > maxBytes) {
      truncated = true;
      break;
    }
    limitedLines.push(candidate);
    charCount += candidate.length + 1; // +1 for the '\n' separator
  }

  if (!truncated && windowLines.length > limitedLines.length) {
    truncated = true;
  }

  return {
    text: limitedLines.join('\n'),
    lineStart: from,
    lineEnd: from + limitedLines.length - 1,
    totalLines,
    returnedLines: limitedLines.length,
    truncated,
    binary: false,
    sizeBytes,
  };
};

/** Directory names always skipped during recursive walks. */
const SKIP_DIRS = new Set([
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
  '.aionui',
  '.turbo',
]);

/**
 * List a directory with optional glob filtering and recursive walk.
 * - Single-level (default): mirrors the old behaviour, dirs first then files A→Z.
 * - Recursive + glob: walks all subdirectories (skipping SKIP_DIRS) and returns
 *   entries whose `relativePath` matches the glob pattern. Sorted by mtime desc
 *   (newest first) to mirror the `Glob` tool.
 */
const listDir = async (req: ListDirRequest): Promise<IdeDirEntry[]> => {
  const trimmed = req.dir?.trim();
  if (!trimmed) throw new Error('A folder path is required.');
  const maxResults = Math.min(req.maxResults ?? 100, 2000);

  if (!req.recursive && !req.glob) {
    // Fast path: original single-level listing.
    const dirents = await fsp.readdir(trimmed, { withFileTypes: true });
    const entries: IdeDirEntry[] = [];
    for (const d of dirents.slice(0, MAX_DIR_ENTRIES)) {
      let sizeBytes: number | undefined;
      let mtimeMs: number | undefined;
      try {
        const st = await fsp.stat(path.join(trimmed, d.name));
        if (!d.isDirectory()) sizeBytes = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        /* best-effort */
      }
      entries.push({ name: d.name, fullPath: path.join(trimmed, d.name), isDir: d.isDirectory(), sizeBytes, mtimeMs });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  // Recursive / glob walk.
  const collected: IdeDirEntry[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (collected.length >= maxResults) return;
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const d of dirents) {
      if (collected.length >= maxResults) break;
      const fullPath = path.join(dir, d.name);
      const relPath = path.relative(trimmed, fullPath).replace(/\\/g, '/');

      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) await walk(fullPath);
        // Include dir entries only when no glob or dir matches glob.
        if (req.glob && !matchGlob(relPath, req.glob)) continue;
        if (!req.glob || matchGlob(relPath, req.glob)) {
          collected.push({ name: d.name, fullPath, relativePath: relPath, isDir: true });
        }
      } else {
        if (req.glob && !matchGlob(relPath, req.glob)) continue;
        let sizeBytes: number | undefined;
        let mtimeMs: number | undefined;
        try {
          const st = await fsp.stat(fullPath);
          sizeBytes = st.size;
          mtimeMs = st.mtimeMs;
        } catch {
          /* best-effort */
        }
        collected.push({ name: d.name, fullPath, relativePath: relPath, isDir: false, sizeBytes, mtimeMs });
      }
    }
  };

  await walk(trimmed);

  // Sort by mtime desc (newest first) — mirrors the `Glob` tool's sort order.
  collected.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));
  return collected.slice(0, maxResults);
};

/** Create a directory (and any missing parents) at an absolute path. */
const createDir = async (dirPath: string): Promise<boolean> => {
  const trimmed = dirPath?.trim();
  if (!trimmed) throw new Error('A folder path is required.');
  await fsp.mkdir(trimmed, { recursive: true });
  return true;
};

/** Rename / move a file or directory, creating the destination's parent first. */
const renameFile = async (oldPath: string, newPath: string): Promise<boolean> => {
  const from = oldPath?.trim();
  const to = newPath?.trim();
  if (!from || !to) throw new Error('Both the source and destination paths are required.');
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return true;
};

/** Delete a file or directory (recursive). No-op when the path is already gone. */
const deleteFile = async (targetPath: string): Promise<boolean> => {
  const trimmed = targetPath?.trim();
  if (!trimmed) throw new Error('A file path is required.');
  await fsp.rm(trimmed, { recursive: true, force: true });
  return true;
};

/**
 * Register the IDE filesystem IPC handlers. Idempotent (re-registration replaces
 * the bound handlers). Intended to be called once during Main-process bootstrap.
 */
export function registerIdeFileBridge(): void {
  ideFileChannels.listDir.provider(async (req): Promise<IdeFileResult<IdeDirEntry[]>> => {
    try {
      return { ok: true, data: await listDir(req) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.readFile.provider(async (req): Promise<IdeFileResult<ReadFileData>> => {
    try {
      return { ok: true, data: await readFileSliced(req) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.readFileBase64.provider(async (req): Promise<IdeFileResult<string>> => {
    try {
      const buf = await fsp.readFile(req.path);
      return { ok: true, data: buf.toString('base64') };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.writeFile.provider(async (req): Promise<IdeFileResult<boolean>> => {
    try {
      const result = await writeTextFileWithMtui(req.path, req.data);
      return result.ok ? { ok: true, data: true } : { ok: false, error: String(result.message ?? 'MTUI write failed') };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.writeFileBase64.provider(async (req): Promise<IdeFileResult<boolean>> => {
    try {
      await fsp.writeFile(req.path, Buffer.from(req.dataBase64, 'base64'));
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.watchStart.provider(async (req): Promise<IdeFileResult<boolean>> => {
    try {
      return { ok: true, data: await startFileWatch(req.rootPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.watchStop.provider(async (req): Promise<IdeFileResult<boolean>> => {
    try {
      return { ok: true, data: stopFileWatch(req.rootPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.rulesLoad.provider(async (req): Promise<IdeFileResult<string[]>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    try {
      return { ok: true, data: await loadProjectRules(rootPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.createDir.provider(async (req): Promise<IdeFileResult<boolean>> => {
    try {
      return { ok: true, data: await createDir(req.path) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.renameFile.provider(async (req): Promise<IdeFileResult<boolean>> => {
    try {
      return { ok: true, data: await renameFile(req.oldPath, req.newPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.deleteFile.provider(async (req): Promise<IdeFileResult<boolean>> => {
    try {
      return { ok: true, data: await deleteFile(req.path) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
