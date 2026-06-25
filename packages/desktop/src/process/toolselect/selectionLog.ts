/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `selectionLog` — records which tool/skill was chosen for each request so that
 * similar future requests can reuse the choice quickly (Yêu cầu 7, criterion
 * 7.7). Backed by a small JSON file (`selection-log.json`) via an injected fs
 * layer, mirroring `resourceState.ts` / `memoryStore.ts`.
 *
 * Requests are keyed by a stable hash of their normalised text, so a repeated or
 * near-identical request (`tools.recall`) can look up prior successful choices.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A single recorded selection outcome for a request. */
export type SelectionLogEntry = {
  /** Stable hash of the normalised request text. */
  requestHash: string;
  /** A short snippet of the original request (for human inspection). */
  requestSnippet: string;
  /** Ids of the chosen catalog entries, in the order they were applied. */
  chosen: string[];
  /** Whether the chosen tools ultimately succeeded for this request. */
  succeeded: boolean;
  /** Unix-ms timestamp of the record. */
  at: number;
};

/** Minimal fs surface used by the log (injectable for tests). */
export type SelectionLogFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Default fs adapter backed by `fs/promises`. */
const defaultFs: SelectionLogFs = {
  readFile: (p, enc) => fs.promises.readFile(p, enc),
  writeFile: (p, data, opts) => fs.promises.writeFile(p, data, opts),
  rename: (a, b) => fs.promises.rename(a, b),
  mkdir: (p, opts) => fs.promises.mkdir(p, opts),
};

/** Options for {@link createSelectionLog}. */
export type SelectionLogOptions = {
  /** Absolute path of the JSON log file. */
  filePath: string;
  /** fs implementation. Defaults to `fs/promises`. */
  fs?: SelectionLogFs;
  /** Max entries retained (oldest dropped). Defaults to 500. */
  maxEntries?: number;
  /** Clock source. Defaults to `Date.now`. */
  now?: () => number;
};

/** Public contract of the selection log. */
export type ISelectionLog = {
  /** Normalise + hash a request the same way the log keys entries. */
  hashRequest(request: string): string;
  /** Record the chosen tools for a request (most-recent-wins per hash). */
  record(request: string, chosen: string[], succeeded: boolean): Promise<SelectionLogEntry>;
  /** Recall the most recent SUCCESSFUL selection for a matching request, if any. */
  recall(request: string): Promise<SelectionLogEntry | undefined>;
  /** Return all entries (most recent first). */
  all(): Promise<SelectionLogEntry[]>;
};

/** Normalise request text: trim, collapse whitespace, lowercase. */
const normaliseRequest = (request: string): string => request.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Create a file-backed {@link ISelectionLog}.
 *
 * @param options File path + injectable fs/clock/limits.
 * @returns A selection log keyed by request hash.
 */
export const createSelectionLog = (options: SelectionLogOptions): ISelectionLog => {
  const fsImpl = options.fs ?? defaultFs;
  const maxEntries = options.maxEntries ?? 500;
  const now = options.now ?? (() => Date.now());

  const hashRequest = (request: string): string =>
    crypto.createHash('sha256').update(normaliseRequest(request)).digest('hex').slice(0, 32);

  const read = async (): Promise<SelectionLogEntry[]> => {
    try {
      const raw = await fsImpl.readFile(options.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SelectionLogEntry[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        console.warn('[ToolSelect] Failed to read selection-log; starting empty:', error);
      }
      return [];
    }
  };

  const write = async (entries: SelectionLogEntry[]): Promise<void> => {
    const dir = path.dirname(options.filePath);
    const tmp = `${options.filePath}.tmp`;
    await fsImpl.mkdir(dir, { recursive: true });
    await fsImpl.writeFile(tmp, JSON.stringify(entries, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmp, options.filePath);
  };

  const record: ISelectionLog['record'] = async (request, chosen, succeeded) => {
    const entry: SelectionLogEntry = {
      requestHash: hashRequest(request),
      requestSnippet: request.trim().slice(0, 120),
      chosen,
      succeeded,
      at: now(),
    };
    const existing = await read();
    // Keep newest-first; a new record for the same hash supersedes prior ones.
    const next = [entry, ...existing.filter((e) => e.requestHash !== entry.requestHash)].slice(0, maxEntries);
    await write(next);
    return entry;
  };

  const recall: ISelectionLog['recall'] = async (request) => {
    const hash = hashRequest(request);
    const entries = await read();
    return entries.find((e) => e.requestHash === hash && e.succeeded);
  };

  const all: ISelectionLog['all'] = async () => {
    const entries = await read();
    return [...entries].toSorted((a, b) => b.at - a.at);
  };

  return { hashRequest, record, recall, all };
};
