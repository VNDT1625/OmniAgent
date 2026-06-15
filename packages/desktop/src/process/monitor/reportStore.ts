/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `reportStore` — the bug-report repository (Yêu cầu 6, criteria 6.2 & 6.9).
 * Stores each {@link BugReport} as JSON and DEDUPLICATES by `signature`: a new
 * error with a known signature bumps the existing report's `occurrences` /
 * `lastSeen` instead of creating a duplicate, so a recurring error can be looked
 * up (and its known fix recalled) without re-analysing from scratch (criterion
 * 6.9 — same idea as `selectionLog` in Yêu cầu 7).
 *
 * Backed by a JSON file via an injected fs layer (mirrors `resourceState.ts` /
 * `selectionLog.ts`). Process boundary: Main-process (Node.js) module — no DOM.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugReport, BugSource } from './monitorTypes';

/** Minimal fs surface used by the store (injectable for tests). */
export type ReportStoreFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

const defaultFs: ReportStoreFs = {
  readFile: (p, enc) => fs.promises.readFile(p, enc),
  writeFile: (p, data, opts) => fs.promises.writeFile(p, data, opts),
  rename: (a, b) => fs.promises.rename(a, b),
  mkdir: (p, opts) => fs.promises.mkdir(p, opts),
};

/** Input for filing a new bug sighting. */
export type BugInput = {
  /** Where the report came from. */
  source: BugSource;
  /** Short title. */
  title: string;
  /** Error message. */
  message: string;
  /** Stack trace, if any. */
  stack?: string;
  /** Recent actions / breadcrumbs. */
  breadcrumbs?: string[];
  /** Free-text situation / user description. */
  description?: string;
  /**
   * Explicit signature; when omitted one is derived from the message + the head
   * of the stack so identical errors group together.
   */
  signature?: string;
};

/** Options for {@link createReportStore}. */
export type ReportStoreOptions = {
  /** Absolute path of the JSON repository file. */
  filePath: string;
  /** fs implementation. Defaults to `fs/promises`. */
  fs?: ReportStoreFs;
  /** Clock source. Defaults to `Date.now`. */
  now?: () => number;
};

/** Public contract of the report store. */
export type IReportStore = {
  /** Derive the dedup signature for an input the same way the store does. */
  computeSignature(input: BugInput): string;
  /** File a bug sighting: bump an existing signature, or create a new report. */
  record(input: BugInput): Promise<BugReport>;
  /** Find an existing report by signature (criterion 6.9 — recall similar errors). */
  findBySignature(signature: string): Promise<BugReport | undefined>;
  /** Attach an accepted fix id to a report's signature (so future sightings recall it). */
  attachKnownFix(signature: string, fixId: string): Promise<void>;
  /** List all reports (most recently seen first). */
  list(): Promise<BugReport[]>;
};

/** Normalise a stack/message into a stable signature key. */
const deriveSignature = (input: BugInput): string => {
  if (input.signature && input.signature.trim().length > 0) return input.signature.trim();
  // Use the message + the first stack frame, stripping volatile bits (numbers,
  // hex addresses, absolute paths) so the same logical error groups together.
  const head = (input.stack ?? input.message).split('\n').slice(0, 2).join(' ');
  const normalised = head
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, '')
    .replace(/:\d+:\d+/g, '')
    .replace(/\d+/g, '#')
    .replace(/[a-z]:\\[^\s)]+|\/[^\s)]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 32);
};

/**
 * Create a file-backed {@link IReportStore}.
 *
 * @param options File path + injectable fs/clock.
 * @returns A report store that deduplicates by signature.
 */
export const createReportStore = (options: ReportStoreOptions): IReportStore => {
  const fsImpl = options.fs ?? defaultFs;
  const now = options.now ?? (() => Date.now());

  const read = async (): Promise<BugReport[]> => {
    try {
      const raw = await fsImpl.readFile(options.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as BugReport[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        console.warn('[Monitor] Failed to read bug-reports; starting empty:', error);
      }
      return [];
    }
  };

  const write = async (reports: BugReport[]): Promise<void> => {
    const dir = path.dirname(options.filePath);
    const tmp = `${options.filePath}.tmp`;
    await fsImpl.mkdir(dir, { recursive: true });
    await fsImpl.writeFile(tmp, JSON.stringify(reports, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmp, options.filePath);
  };

  const computeSignature = (input: BugInput): string => deriveSignature(input);

  const record: IReportStore['record'] = async (input) => {
    const signature = deriveSignature(input);
    const ts = now();
    const reports = await read();
    const existing = reports.find((r) => r.signature === signature);

    if (existing) {
      // Dedup: same logical error → bump counters instead of duplicating (6.9).
      existing.occurrences += 1;
      existing.lastSeen = ts;
      if (input.description && !existing.description) existing.description = input.description;
      if (input.breadcrumbs && input.breadcrumbs.length > 0) existing.breadcrumbs = input.breadcrumbs;
      await write(reports);
      return { ...existing };
    }

    const report: BugReport = {
      id: crypto.randomUUID(),
      source: input.source,
      signature,
      title: input.title,
      message: input.message,
      stack: input.stack,
      breadcrumbs: input.breadcrumbs ?? [],
      description: input.description,
      occurrences: 1,
      firstSeen: ts,
      lastSeen: ts,
    };
    await write([report, ...reports]);
    return { ...report };
  };

  const findBySignature: IReportStore['findBySignature'] = async (signature) => {
    const reports = await read();
    const found = reports.find((r) => r.signature === signature);
    return found ? { ...found } : undefined;
  };

  const attachKnownFix: IReportStore['attachKnownFix'] = async (signature, fixId) => {
    const reports = await read();
    const target = reports.find((r) => r.signature === signature);
    if (!target) return;
    target.knownFixId = fixId;
    await write(reports);
  };

  const list: IReportStore['list'] = async () => {
    const reports = await read();
    return [...reports].toSorted((a, b) => b.lastSeen - a.lastSeen);
  };

  return { computeSignature, record, findBySignature, attachKnownFix, list };
};
