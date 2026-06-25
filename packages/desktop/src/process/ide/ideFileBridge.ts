/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
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
  /** True for a directory, false for a file. */
  isDir: boolean;
};

/** Always-resolving result envelope. */
export type IdeFileResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Request shapes. */
export type ListDirRequest = { dir: string };
export type ReadFileRequest = { path: string };
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
  readFile: bridge.buildProvider<IdeFileResult<string>, ReadFileRequest>(IDE_FILE_CHANNELS.readFile),
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

/** List one directory level: directories first (A→Z), then files (A→Z). */
const listDir = async (dir: string): Promise<IdeDirEntry[]> => {
  const trimmed = dir?.trim();
  if (!trimmed) throw new Error('A folder path is required.');
  const dirents = await fsp.readdir(trimmed, { withFileTypes: true });
  const entries: IdeDirEntry[] = dirents.slice(0, MAX_DIR_ENTRIES).map((d) => ({
    name: d.name,
    fullPath: path.join(trimmed, d.name),
    isDir: d.isDirectory(),
  }));
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
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
      return { ok: true, data: await listDir(req.dir) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideFileChannels.readFile.provider(async (req): Promise<IdeFileResult<string>> => {
    try {
      return { ok: true, data: await fsp.readFile(req.path, 'utf-8') };
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
