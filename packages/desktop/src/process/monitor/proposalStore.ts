/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `proposalStore` — persists {@link PatchProposal}s produced by the
 * {@link IRootCauseAnalyzer} so they survive restarts and can be recalled by id
 * (Yêu cầu 6, criterion 6.9 — "nhớ để tái dùng"). It satisfies the analyzer's
 * {@link KnownFixProvider} contract (`get(fixId)`), closing the recall loop:
 * `reportStore.knownFixId` → `proposalStore.get(id)` → skip re-analysis.
 *
 * Backed by a JSON file via an injected fs layer (mirrors `reportStore.ts`).
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PatchProposal } from './monitorTypes';
import type { KnownFixProvider } from './rootCauseAnalyzer';

/** Minimal fs surface used by the store (injectable for tests). */
export type ProposalStoreFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

const defaultFs: ProposalStoreFs = {
  readFile: (p, enc) => fs.promises.readFile(p, enc),
  writeFile: (p, data, opts) => fs.promises.writeFile(p, data, opts),
  rename: (a, b) => fs.promises.rename(a, b),
  mkdir: (p, opts) => fs.promises.mkdir(p, opts),
};

/** Options for {@link createProposalStore}. */
export type ProposalStoreOptions = {
  /** Absolute path of the JSON repository file. */
  filePath: string;
  /** fs implementation. Defaults to `fs/promises`. */
  fs?: ProposalStoreFs;
};

/** Public contract of the proposal store (a superset of {@link KnownFixProvider}). */
export type IProposalStore = KnownFixProvider & {
  /** Persist (or overwrite) a proposal by its id. */
  save(proposal: PatchProposal): Promise<void>;
  /** Most-recent proposal for a signature, if any (used to recall a known fix). */
  findBySignature(signature: string): Promise<PatchProposal | undefined>;
  /** All persisted proposals (newest first). */
  list(): Promise<PatchProposal[]>;
};

/**
 * Create a file-backed {@link IProposalStore}.
 *
 * @param options File path + injectable fs.
 * @returns A proposal store that persists + recalls proposals by id/signature.
 */
export const createProposalStore = (options: ProposalStoreOptions): IProposalStore => {
  const fsImpl = options.fs ?? defaultFs;

  const read = async (): Promise<PatchProposal[]> => {
    try {
      const raw = await fsImpl.readFile(options.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PatchProposal[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
        console.warn('[Monitor] Failed to read patch-proposals; starting empty:', error);
      }
      return [];
    }
  };

  const write = async (proposals: PatchProposal[]): Promise<void> => {
    const dir = path.dirname(options.filePath);
    const tmp = `${options.filePath}.tmp`;
    await fsImpl.mkdir(dir, { recursive: true });
    await fsImpl.writeFile(tmp, JSON.stringify(proposals, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmp, options.filePath);
  };

  const save: IProposalStore['save'] = async (proposal) => {
    const proposals = await read();
    const next = proposals.filter((p) => p.id !== proposal.id);
    next.unshift(proposal);
    await write(next);
  };

  const get: IProposalStore['get'] = async (fixId) => {
    const proposals = await read();
    const found = proposals.find((p) => p.id === fixId);
    return found ? { ...found } : undefined;
  };

  const findBySignature: IProposalStore['findBySignature'] = async (signature) => {
    const proposals = await read();
    // `read()` returns newest-first (save unshifts), so the first match is latest.
    const found = proposals.find((p) => p.signature === signature);
    return found ? { ...found } : undefined;
  };

  const list: IProposalStore['list'] = async () => {
    return await read();
  };

  return { save, get, findBySignature, list };
};
