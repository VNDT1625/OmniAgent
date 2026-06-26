/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the agent-facing IDE MCP server for the Main process.
 * All new MTUI-backed tools (understand/compass/context/map/analyze/compact)
 * delegate to the MTUI CLI via runMtuiInRoot so the IDE plane and MTUI stay in sync.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { buildGraphFromFiles, collectRepoFiles, type CollectRepoFilesDeps } from '../repoGraph';
import { grepText, buildSearchRegExp } from '../search/grepCore';
import { findDeclarations, findReferences } from '../nav/symbolNav';
import {
  createIdeServer,
  type IdeMcpService,
  type IdeSearchHit,
  type IdeSymbolHit,
  type IdeReadResult,
  type IdeMtuiResult,
  type IdeDirEntry,
  type QuickTestRunner,
  type DbAgentService,
} from './ideServer';
import { createQuickTestService } from '../quickTestService';
import { openNativeLogStream } from '../quickTestNativeStream';
import { loadGraph } from '../quickTestBridgeHelpers';
import { getDbService } from '../db/dbWiring';
import { getSessionMemoryStore } from '../memory/sessionMemoryStore';
import { getTeamEditService } from '../teamEdit/teamEditService';
import { runMtuiInRoot } from '@process/terminal/mtuiBridge';
import { runCommand } from '../command/commandRunner';
import type { CdpWebContents } from '../quickTestTracer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const DEFAULT_SCAN_FILES = 4000;
const DEFAULT_SEARCH_RESULTS = 200;
const DEFAULT_SYMBOL_RESULTS = 200;
const DEFAULT_READ_LINES = 2000;

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

// ---------------------------------------------------------------------------
// Glob helpers
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
  return hasSlash ? re.test(norm) : re.test(norm.split('/').pop() ?? norm);
};

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------
const isBinaryBuffer = (buf: Buffer): boolean => {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let nonText = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0 || b < 8 || (b >= 14 && b < 32 && b !== 27)) nonText++;
  }
  return sample.length > 0 && nonText / sample.length > 0.003;
};

// ---------------------------------------------------------------------------
// MTUI helper
// ---------------------------------------------------------------------------
const runMtui = async (rootPath: string, args: string[]): Promise<Record<string, unknown>> => {
  const result = await runMtuiInRoot(['--json', ...args], rootPath);
  return result as Record<string, unknown>;
};

const mtuiSummaryText = (env: Record<string, unknown>, ...keys: string[]): string => {
  for (const key of keys) {
    const v = env[key];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return JSON.stringify(env, null, 2);
};

// ---------------------------------------------------------------------------
// fsDeps helper
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Main service implementation
// ---------------------------------------------------------------------------
export const getIdeMcpService = (): IdeMcpService => ({
  // --- listDir: single-level + recursive + glob ----------------------------
  listDir: async (dir, opts) => {
    const trimmed = dir?.trim();
    if (!trimmed) throw new Error('A folder path is required.');
    const maxResults = Math.min(opts?.maxResults ?? 100, 2000);

    if (!opts?.recursive && !opts?.glob) {
      // Fast path: original single-level listing
      const dirents = await fsp.readdir(trimmed, { withFileTypes: true });
      const entries: IdeDirEntry[] = dirents.slice(0, 2000).map((d) => ({
        name: d.name,
        fullPath: path.join(trimmed, d.name),
        isDir: d.isDirectory(),
      }));
      entries.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
      return entries;
    }

    // Recursive / glob walk
    const collected: IdeDirEntry[] = [];
    const walk = async (cur: string): Promise<void> => {
      if (collected.length >= maxResults) return;
      let dirents: import('node:fs').Dirent[];
      try {
        dirents = await fsp.readdir(cur, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (collected.length >= maxResults) break;
        const full = path.join(cur, d.name);
        const rel = path.relative(trimmed, full).replace(/\\/g, '/');
        if (d.isDirectory()) {
          if (!SKIP_DIRS.has(d.name)) await walk(full);
        } else {
          if (opts?.glob && !matchGlob(rel, opts.glob)) continue;
          let sizeBytes: number | undefined;
          let mtimeMs: number | undefined;
          try {
            const st = await fsp.stat(full);
            sizeBytes = st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            /* ok */
          }
          collected.push({ name: d.name, fullPath: full, relativePath: rel, isDir: false, sizeBytes });
        }
      }
    };
    await walk(trimmed);
    return collected.slice(0, maxResults);
  },

  // --- readFile: full parity with Read tool — line range, all, line numbers
  readFile: async (filePath, opts) => {
    const trimmed = filePath?.trim();
    if (!trimmed) throw new Error('A file path is required.');
    const buf = await fsp.readFile(trimmed);
    const sizeBytes = buf.length;

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

    const raw = buf.toString('utf-8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const allLines = raw.split('\n');
    const totalLines = allLines.length;
    const all = opts?.all === true;
    const lineNumbers = opts?.lineNumbers !== false;
    const maxLines = all ? Infinity : (opts?.maxLines ?? DEFAULT_READ_LINES);
    const maxBytes = all ? Infinity : (opts?.maxBytes ?? Infinity);
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

  // --- scanRepo ------------------------------------------------------------
  scanRepo: async (rootPath, maxFiles) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('A folder path is required.');
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: maxFiles ?? DEFAULT_SCAN_FILES });
    const graph = buildGraphFromFiles(trimmed, files);
    const byGroup = new Map<string, number>();
    for (const node of graph.nodes) byGroup.set(node.group, (byGroup.get(node.group) ?? 0) + 1);
    const topGroups = Array.from(byGroup.entries())
      .map(([group, count]) => ({ group, files: count }))
      .toSorted((a, b) => b.files - a.files)
      .slice(0, 12);
    return {
      fileCount: graph.fileCount,
      edgeCount: graph.edges.length,
      topGroups,
      truncated: graph.truncated || (maxFiles !== undefined && files.length >= maxFiles),
    };
  },

  // --- search: + glob filter + column --------------------------------------
  search: async (rootPath, query, opts) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('A folder path is required.');
    if (!query || query.length === 0) throw new Error('A search query is required.');
    const limit = opts?.maxResults && opts.maxResults > 0 ? opts.maxResults : DEFAULT_SEARCH_RESULTS;
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: DEFAULT_SCAN_FILES, codeOnly: false });
    const re = buildSearchRegExp(query, opts ?? {});
    const hits: IdeSearchHit[] = [];
    for (const file of files) {
      if (opts?.glob && !matchGlob(file.relPath, opts.glob)) continue;
      if (file.content.length === 0) continue;
      for (const m of grepText(file.content, query, opts)) {
        const lineText = file.content.split('\n')[m.line - 1] ?? '';
        re.lastIndex = 0;
        const match = re.exec(lineText);
        hits.push({ file: file.relPath, line: m.line, column: match ? match.index + 1 : 1, text: m.text });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  },

  // --- findDefinition / findReferences -------------------------------------
  findDefinition: async (rootPath, name, maxResults) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('A folder path is required.');
    const limit = maxResults && maxResults > 0 ? maxResults : DEFAULT_SYMBOL_RESULTS;
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: DEFAULT_SCAN_FILES });
    const hits: IdeSymbolHit[] = [];
    for (const file of files) {
      for (const h of findDeclarations(file.content, name)) {
        hits.push({ file: file.relPath, line: h.line, column: h.column, text: h.text });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  },

  findReferences: async (rootPath, name, maxResults) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('A folder path is required.');
    const limit = maxResults && maxResults > 0 ? maxResults : DEFAULT_SYMBOL_RESULTS;
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: DEFAULT_SCAN_FILES });
    const hits: IdeSymbolHit[] = [];
    for (const file of files) {
      for (const h of findReferences(file.content, name)) {
        hits.push({ file: file.relPath, line: h.line, column: h.column, text: h.text });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  },

  // --- understand (summary / info) -----------------------------------------
  understand: async (rootPath, target, kind, detailed) => {
    const cmd = detailed ? 'info' : 'summary';
    const subCmd = kind === 'folder' ? 'folder' : 'file';
    const result = await runMtui(rootPath, [cmd, subCmd, target]);
    return {
      summary: mtuiSummaryText(result, 'summary'),
      details: detailed ? result : undefined,
      stale: result['stale'] === true,
    };
  },

  // --- compassRead ---------------------------------------------------------
  compassRead: async (rootPath, filePath, query, maxLines) => {
    const args = ['compass', 'read', filePath];
    if (query) args.push('--query', query);
    if (maxLines) args.push('--max-lines', String(maxLines));
    const result = await runMtui(rootPath, args);
    return {
      summary: mtuiSummaryText(result, 'text', 'output', 'summary'),
      stale: result['stale'] === true,
    };
  },

  // --- context -------------------------------------------------------------
  context: async (rootPath, intent, limit) => {
    const args = ['context', intent];
    if (limit) args.push('--limit', String(limit));
    const result = await runMtui(rootPath, args);
    const candidates = result['candidates'];
    let summary = mtuiSummaryText(result, 'summary');
    if (Array.isArray(candidates) && candidates.length > 0) {
      const lines = (candidates as Array<Record<string, unknown>>).map(
        (c) => `- ${c['path']} [${c['layer'] ?? c['role'] ?? ''}] — ${c['summary'] ?? c['reason'] ?? ''}`
      );
      summary = `${candidates.length} candidates:\n${lines.join('\n')}`;
    }
    return { summary, details: result, stale: result['stale'] === true };
  },

  // --- map -----------------------------------------------------------------
  // `mtui map` requires a subcommand: `repo`, `folder <path>`, or `intent <text>`.
  // `folder`/`intent` take their target as a positional argument (not a flag).
  map: async (rootPath, scope, target, limit) => {
    const effectiveScope = scope ?? 'repo';
    if (effectiveScope === 'folder' && !target?.trim()) {
      throw new Error('map scope "folder" requires a target folder path.');
    }
    if (effectiveScope === 'intent' && !target?.trim()) {
      throw new Error('map scope "intent" requires a target intent string.');
    }
    const args: string[] = ['map', effectiveScope];
    if ((effectiveScope === 'folder' || effectiveScope === 'intent') && target) {
      args.push(target);
    }
    if (limit) args.push('--limit', String(limit));
    const result = await runMtui(rootPath, args);
    return {
      summary: mtuiSummaryText(result, 'summary'),
      details: result,
      stale: result['stale'] === true,
    };
  },

  // --- analyze -------------------------------------------------------------
  analyze: async (rootPath, target) => {
    const args = target ? ['analyze', target] : ['analyze', 'type'];
    const result = await runMtui(rootPath, args);
    return { summary: mtuiSummaryText(result, 'summary', 'output') };
  },

  // --- compact -------------------------------------------------------------
  compact: async (rootPath, input, profile, maxLines) => {
    const args = ['compact'];
    if (profile) args.push('--profile', profile);
    if (maxLines) args.push('--max-lines', String(maxLines));
    const result = await runMtuiInRoot(['--json', ...args], rootPath);
    // compact accepts input via stdin — fallback: pass as --input flag if available
    // For now use the direct MTUI compact result
    const r = result as Record<string, unknown>;
    return { summary: mtuiSummaryText(r, 'text', 'output', 'summary') };
  },

  // --- runCommand: guarded arbitrary shell execution -----------------------
  runCommand: async (rootPath, command, opts) => {
    return runCommand(command, rootPath, { cwd: opts?.cwd, timeoutMs: opts?.timeoutMs });
  },
});

// ---------------------------------------------------------------------------
// Quick Test runner
// ---------------------------------------------------------------------------
export const getQuickTestRunner = (): QuickTestRunner => {
  const service = createQuickTestService({
    getWebContents: (): CdpWebContents | null => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { webContents } = require('electron') as typeof import('electron');
        const focused = webContents.getFocusedWebContents();
        return (focused as unknown as CdpWebContents | null) ?? null;
      } catch {
        return null;
      }
    },
    openNativeStream: openNativeLogStream,
    loadGraph,
  });
  return service as QuickTestRunner;
};

// ---------------------------------------------------------------------------
// Build the server
// ---------------------------------------------------------------------------
export const buildIdeServer = (): McpServer =>
  createIdeServer({
    ide: getIdeMcpService(),
    quickTest: getQuickTestRunner(),
    db: getDbService() as DbAgentService,
    memory: getSessionMemoryStore(),
    teamEdit: getTeamEditService(),
  });
