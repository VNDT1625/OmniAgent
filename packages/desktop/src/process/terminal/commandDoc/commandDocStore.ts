/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-backed store for docTerminal command records.
 *
 * Persists all learned commands as a single JSON document at
 * `<userData>/terminal/commandDoc.json`, using the same robustness conventions
 * as `rtkStore`/`memoryStore`: an injectable filesystem adapter (testable
 * against a temp dir) and an atomic write-to-tmp-then-rename.
 *
 * The command set is small (a user's distinct command lines), so a load-all /
 * save-all map is sufficient and keeps suggestion lookups cheap.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs. The
 * Electron `userData` directory is resolved lazily so injected dirs never touch
 * a live `app`.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandRecord } from './commandTypes';

const TERMINAL_DIR = 'terminal';
const COMMAND_DOC_FILE = 'commandDoc.json';
export const COMMAND_DOC_VERSION = 1;

type CommandDocDocument = {
  version: number;
  commands: CommandRecord[];
};

/** Minimal `fs/promises` subset (mirrors `RtkStoreFs`). */
export type CommandDocFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

export const defaultCommandDocFs: CommandDocFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

export type CommandDocStoreOptions = {
  /** Root dir holding the store. Defaults to `<userData>/terminal`. */
  rootDir?: string;
  /** Filesystem adapter. Injectable for tests. */
  fs?: CommandDocFs;
};

/** Public contract of the command-doc store. */
export type ICommandDocStore = {
  /** Load all command records (empty when the file does not exist). */
  readAll(): Promise<CommandRecord[]>;
  /** Replace the full record set (atomic tmp+rename). */
  writeAll(records: CommandRecord[]): Promise<void>;
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/**
 * Create an {@link ICommandDocStore}.
 *
 * @param options Root dir + fs adapter overrides (both optional).
 */
export const createCommandDocStore = (options: CommandDocStoreOptions = {}): ICommandDocStore => {
  const fsImpl = options.fs ?? defaultCommandDocFs;
  const resolveRoot = (): string => options.rootDir ?? path.join(app.getPath('userData'), TERMINAL_DIR);
  const docPath = (): string => path.join(resolveRoot(), COMMAND_DOC_FILE);

  const readAll = async (): Promise<CommandRecord[]> => {
    try {
      const raw = await fsImpl.readFile(docPath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<CommandDocDocument> | null;
      return parsed && Array.isArray(parsed.commands) ? parsed.commands : [];
    } catch (error) {
      if (isFileNotFound(error)) return [];
      throw error;
    }
  };

  const writeAll = async (records: CommandRecord[]): Promise<void> => {
    const target = docPath();
    const tmp = `${target}.tmp`;
    await fsImpl.mkdir(path.dirname(target), { recursive: true });
    const doc: CommandDocDocument = { version: COMMAND_DOC_VERSION, commands: records };
    await fsImpl.writeFile(tmp, JSON.stringify(doc, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmp, target);
  };

  return { readAll, writeAll };
};
