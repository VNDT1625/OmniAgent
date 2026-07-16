/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { buildGraphFromFiles, collectRepoFiles, type CollectRepoFilesDeps } from '../repoGraph';
import { findDeclarations, findReferences } from '../nav/symbolNav';
import { grepText } from '../search/grepCore';
import { createTeamEditService } from '../teamEdit/teamEditService';
import {
  createIdeServer,
  type GitAgentService,
  type IdeMcpService,
  type TeamEditAgentService,
  type IdeSearchHit,
  type IdeSymbolHit,
  type TerminalAgentService,
  type TerminalRunResult,
} from './ideServer';

const DEFAULT_SCAN_FILES = 4000;
const DEFAULT_SEARCH_RESULTS = 200;
const DEFAULT_SYMBOL_RESULTS = 200;
const DEFAULT_READ_LINES = 2000;
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

  readFile: async (filePath, opts) => {
    const trimmed = filePath?.trim();
    if (!trimmed) throw new Error('filePath is required.');
    const buf = await fsp.readFile(trimmed);
    const sizeBytes = buf.length;
    const raw = buf.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const allLines = raw.split('\n');
    const totalLines = allLines.length;
    const all = opts?.all === true;
    const lineNumbers = opts?.lineNumbers !== false;
    const maxLines = all ? Infinity : (opts?.maxLines ?? DEFAULT_READ_LINES);
    const maxBytes = all ? Infinity : (opts?.maxBytes ?? DEFAULT_READ_BYTES);
    const from = Math.max(1, opts?.from ?? 1);
    const to = Math.min(totalLines, opts?.to ?? totalLines);
    if (from > to) throw new Error(`Invalid range: from (${from}) > to (${to})`);

    const window = allLines.slice(from - 1, to);
    let charCount = 0;
    const limited: string[] = [];
    let truncated = false;

    for (const line of window) {
      if (limited.length >= maxLines) {
        truncated = true;
        break;
      }
      const candidate = lineNumbers ? `${from + limited.length}: ${line}` : line;
      if (charCount > 0 && charCount + candidate.length + 1 > maxBytes) {
        truncated = true;
        break;
      }
      limited.push(candidate);
      charCount += candidate.length + 1;
    }
    if (!truncated && window.length > limited.length) truncated = true;

    return {
      text: limited.join('\n'),
      lineStart: from,
      lineEnd: from + limited.length - 1,
      totalLines,
      returnedLines: limited.length,
      truncated,
      binary: false,
      sizeBytes,
    };
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

  understand: async (rootPath, target, kind, detailed) => {
    const base = path.resolve(rootPath);
    const fullPath = path.isAbsolute(target) ? target : path.join(base, target);
    const stat = await fsp.stat(fullPath);
    if (kind === 'file' || stat.isFile()) {
      const text = await fsp.readFile(fullPath, 'utf-8');
      const lineCount = text.split(/\r?\n/).length;
      return {
        summary: `File: ${path.relative(base, fullPath).replace(/\\/g, '/')}\nLines: ${lineCount}\nBytes: ${Buffer.byteLength(text, 'utf-8')}`,
        stale: true,
        details: detailed ? { kind: 'file', lineCount } : undefined,
      };
    }
    const files = await collectRepoFiles(fullPath, fsDeps(fullPath), { maxFiles: DEFAULT_SCAN_FILES });
    return {
      summary: `Folder: ${path.relative(base, fullPath).replace(/\\/g, '/') || '.'}\nFiles: ${files.length}`,
      stale: true,
      details: detailed ? { kind: 'folder', files: files.slice(0, 50).map((file) => file.relPath) } : undefined,
    };
  },

  compassRead: async (rootPath, filePath, query, maxLines) => {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(rootPath, filePath);
    const service = createNodeIdeMcpService();
    const result = await service.readFile(fullPath, { maxLines, maxBytes: DEFAULT_READ_BYTES });
    return {
      summary: query ? `Query: ${query}\n${result.text}` : result.text,
      stale: true,
      details: result,
    };
  },

  context: async (rootPath, intent, limit) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('rootPath is required.');
    const maxResults = limit && limit > 0 ? limit : 20;
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: DEFAULT_SCAN_FILES, codeOnly: false });
    const terms = intent
      .toLowerCase()
      .split(/\W+/)
      .filter((term) => term.length >= 3)
      .slice(0, 12);
    const ranked = files
      .map((file) => {
        const haystack = `${file.relPath}\n${file.content}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        return { file: file.relPath, score };
      })
      .filter((hit) => hit.score > 0)
      .toSorted((a, b) => b.score - a.score)
      .slice(0, maxResults);
    return {
      summary: ranked.length
        ? ranked.map((hit) => `${hit.file} (score ${hit.score})`).join('\n')
        : 'No relevant files found.',
      stale: true,
      details: { intent, ranked },
    };
  },

  map: async (rootPath, scope, target, limit) => {
    const base = path.resolve(rootPath);
    const scanRoot = scope === 'folder' && target ? (path.isAbsolute(target) ? target : path.join(base, target)) : base;
    const files = await collectRepoFiles(scanRoot, fsDeps(scanRoot), { maxFiles: limit ?? DEFAULT_SCAN_FILES });
    const byGroup = new Map<string, number>();
    for (const file of files) {
      const group = file.relPath.includes('/') ? file.relPath.split('/')[0] : '(root)';
      byGroup.set(group, (byGroup.get(group) ?? 0) + 1);
    }
    const groups = Array.from(byGroup.entries()).toSorted((a, b) => b[1] - a[1]);
    return {
      summary: groups.map(([group, count]) => `${group}: ${count} file(s)`).join('\n') || 'No files found.',
      stale: true,
      details: { scope, target, groups },
    };
  },

  analyze: async (rootPath, target) => {
    const base = path.resolve(rootPath);
    const scanRoot = target ? (path.isAbsolute(target) ? target : path.join(base, target)) : base;
    const files = await collectRepoFiles(scanRoot, fsDeps(scanRoot), { maxFiles: DEFAULT_SCAN_FILES, codeOnly: false });
    const extCounts = new Map<string, number>();
    for (const file of files) {
      const ext = path.extname(file.relPath).toLowerCase() || '(none)';
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
    }
    const languages = Array.from(extCounts.entries())
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 20);
    return {
      summary: `Files: ${files.length}\n${languages.map(([ext, count]) => `${ext}: ${count}`).join('\n')}`,
      stale: true,
      details: { target: target ?? '.', languages },
    };
  },

  compact: async (_rootPath, input, profile, maxLines) => {
    const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const interesting = lines.filter((line) => /error|fail|warn|exception|timeout/i.test(line));
    const selected = (interesting.length > 0 ? interesting : lines).slice(0, maxLines ?? 80);
    return {
      summary: selected.join('\n') || '(empty input)',
      stale: true,
      details: { profile, inputLines: lines.length, returnedLines: selected.length },
    };
  },

  runCommand: async (rootPath, command, opts) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : 'sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    const result = await runLocalCommand(shell, args, {
      cwd: opts?.cwd ?? rootPath,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      code: result.exitCode ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    };
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

let nodeTeamEditService: TeamEditAgentService | undefined;

export const createNodeTeamEditService = (): TeamEditAgentService => {
  if (!nodeTeamEditService) nodeTeamEditService = createTeamEditService();
  return nodeTeamEditService;
};

export const buildOmniNodeIdeServer = () => {
  const terminal = createTerminalAgentService();
  return createIdeServer({
    ide: createNodeIdeMcpService(),
    terminal,
    git: createGitAgentService(terminal),
    teamEdit: createNodeTeamEditService(),
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
