/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { buildGraphFromFiles, collectRepoFiles, type CollectRepoFilesDeps } from '../repoGraph';
import { findDeclarations, findReferences } from '../nav/symbolNav';
import { grepText } from '../search/grepCore';
import {
  createIdeServer,
  type GitAgentService,
  type IdeMcpService,
  type IdeSearchHit,
  type IdeSymbolHit,
  type TerminalAgentService,
  type TerminalRunResult,
} from './ideServer';

const DEFAULT_SCAN_FILES = 4000;
const DEFAULT_SEARCH_RESULTS = 200;
const DEFAULT_SYMBOL_RESULTS = 200;
const DEFAULT_READ_BYTES = 200_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;

const fsDeps = (rootPath: string): CollectRepoFilesDeps => ({
  listDir: async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      fullPath: path.join(dir, entry.name),
      isDir: entry.isDirectory(),
    }));
  },
  readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
  toRel: (full) => path.relative(rootPath, full).replace(/\\/g, '/'),
});

export const createNodeIdeMcpService = (): IdeMcpService => ({
  listDir: async (dir) => {
    const trimmed = dir?.trim();
    if (!trimmed) throw new Error('dir is required.');
    const dirents = await fsp.readdir(trimmed, { withFileTypes: true });
    const entries = dirents.map((d) => ({
      name: d.name,
      fullPath: path.join(trimmed, d.name),
      isDir: d.isDirectory(),
    }));
    entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    return entries;
  },

  readFile: async (filePath, maxBytes) => {
    const trimmed = filePath?.trim();
    if (!trimmed) throw new Error('filePath is required.');
    const text = await fsp.readFile(trimmed, 'utf-8');
    const cap = maxBytes && maxBytes > 0 ? maxBytes : DEFAULT_READ_BYTES;
    return text.length > cap ? `${text.slice(0, cap)}\n...[truncated at ${cap} bytes]` : text;
  },

  scanRepo: async (rootPath, maxFiles) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('rootPath is required.');
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: maxFiles ?? DEFAULT_SCAN_FILES });
    const graph = buildGraphFromFiles(trimmed, files);
    const byGroup = new Map<string, number>();
    for (const file of files) {
      const group = file.relPath.includes('/') ? file.relPath.split('/')[0] : '(root)';
      byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
    }
    return {
      fileCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      topGroups: Array.from(byGroup.entries())
        .map(([group, count]) => ({ group, files: count }))
        .toSorted((a, b) => b.files - a.files)
        .slice(0, 10),
      truncated: files.length >= (maxFiles ?? DEFAULT_SCAN_FILES),
    };
  },

  search: async (rootPath, query, opts) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('rootPath is required.');
    const limit = opts?.maxResults && opts.maxResults > 0 ? opts.maxResults : DEFAULT_SEARCH_RESULTS;
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: DEFAULT_SCAN_FILES, codeOnly: false });
    const hits: IdeSearchHit[] = [];
    for (const file of files) {
      const matches = grepText(file.content, query, opts);
      for (const match of matches) {
        hits.push({ file: file.relPath, line: match.line, text: match.text });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  },

  findDefinition: async (rootPath, name, maxResults) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('rootPath is required.');
    const limit = maxResults && maxResults > 0 ? maxResults : DEFAULT_SYMBOL_RESULTS;
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: DEFAULT_SCAN_FILES });
    const hits: IdeSymbolHit[] = [];
    for (const file of files) {
      for (const hit of findDeclarations(file.content, name)) {
        hits.push({ file: file.relPath, line: hit.line, column: hit.column, text: hit.text });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  },

  findReferences: async (rootPath, name, maxResults) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('rootPath is required.');
    const limit = maxResults && maxResults > 0 ? maxResults : DEFAULT_SYMBOL_RESULTS;
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: DEFAULT_SCAN_FILES });
    const hits: IdeSymbolHit[] = [];
    for (const file of files) {
      for (const hit of findReferences(file.content, name)) {
        hits.push({ file: file.relPath, line: hit.line, column: hit.column, text: hit.text });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  },
});

export const createTerminalAgentService = (): TerminalAgentService => ({
  run: (command, args = [], options = {}) => runLocalCommand(command, args, options),
});

export const createGitAgentService = (terminal = createTerminalAgentService()): GitAgentService => ({
  status: (rootPath) =>
    terminal.run('git', ['status', '--short', '--branch'], { cwd: rootPath, timeoutMs: DEFAULT_TIMEOUT_MS }),
  diff: (rootPath, opts = {}) => {
    const args = ['diff'];
    if (opts.staged) args.push('--staged');
    if (opts.path) args.push('--', opts.path);
    return terminal.run('git', args, { cwd: rootPath, timeoutMs: DEFAULT_TIMEOUT_MS });
  },
  log: (rootPath, maxCount = 10) =>
    terminal.run('git', ['log', `--max-count=${Math.max(1, Math.min(maxCount, 100))}`, '--oneline', '--decorate'], {
      cwd: rootPath,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }),
});

export const buildOmniNodeIdeServer = () => {
  const terminal = createTerminalAgentService();
  return createIdeServer({
    ide: createNodeIdeMcpService(),
    terminal,
    git: createGitAgentService(terminal),
  });
};

const runLocalCommand = async (
  command: string,
  args: string[] = [],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<TerminalRunResult> => {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const started = Date.now();

  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const err = error as (Error & { code?: number | string; signal?: string; killed?: boolean }) | null;
        const exitCode = typeof err?.code === 'number' ? err.code : err ? null : 0;
        const timedOut = Boolean(err?.killed || (err?.signal === 'SIGTERM' && durationMs >= timeoutMs));
        const errorText = err && typeof err.code !== 'number' ? `${stderr}${stderr ? '\n' : ''}${err.message}` : stderr;
        resolve({ command, args, cwd, exitCode, timedOut, durationMs, stdout, stderr: errorText });
      }
    );
  });
};
