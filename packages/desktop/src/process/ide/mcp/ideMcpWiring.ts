/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the agent-facing IDE MCP server (IDE / repo-intelligence — Agent plane)
 * for the Main process. It assembles the real, fs-backed {@link IdeMcpService}
 * by reusing the SAME pure helpers the IDE UI bridges already use
 * (`repoGraph.collectRepoFiles`/`buildGraphFromFiles`, `search/grepCore`,
 * `nav/symbolNav`), so the Agent plane and the UI plane stay behaviourally
 * identical — an agent greps/navigates a repo exactly the way the IDE view does.
 *
 * ## One behaviour, two planes
 *
 * The IDE bridges (`ideFileBridge`, `ideBridge`, `ideSearchBridge`,
 * `ideNavBridge`) serve the renderer. This service is the agent-facing twin: it
 * walks the filesystem with Node `fs` and runs the same pure logic, so there is
 * no second implementation to drift.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { buildGraphFromFiles, collectRepoFiles, type CollectRepoFilesDeps } from '../repoGraph';
import { grepText } from '../search/grepCore';
import { findDeclarations, findReferences } from '../nav/symbolNav';
import { createIdeServer, type IdeMcpService, type IdeSearchHit, type IdeSymbolHit, type QuickTestRunner, type DbAgentService } from './ideServer';
import { createQuickTestService } from '../quickTestService';
import { openNativeLogStream } from '../quickTestNativeStream';
import { loadGraph } from '../quickTestBridgeHelpers';
import { getDbService } from '../db/dbWiring';
import { getSessionMemoryStore } from '../memory/sessionMemoryStore';
import type { CdpWebContents } from '../quickTestTracer';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Default cap on files walked for a repo-wide search / nav scan. */
const DEFAULT_SCAN_FILES = 4000;
/** Default cap on search matches returned. */
const DEFAULT_SEARCH_RESULTS = 200;
/** Default cap on symbol hits returned. */
const DEFAULT_SYMBOL_RESULTS = 200;
/** Default cap on bytes returned by a single file read. */
const DEFAULT_READ_BYTES = 200_000;

/** Build the fs primitives {@link collectRepoFiles} needs, rooted at `rootPath`. */
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

/** The real, fs-backed IDE service reusing the IDE plane's pure helpers. */
export const getIdeMcpService = (): IdeMcpService => ({
  listDir: async (dir) => {
    const trimmed = dir?.trim();
    if (!trimmed) throw new Error('A folder path is required.');
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
    if (!trimmed) throw new Error('A file path is required.');
    const text = await fsp.readFile(trimmed, 'utf-8');
    const cap = maxBytes && maxBytes > 0 ? maxBytes : DEFAULT_READ_BYTES;
    return text.length > cap ? `${text.slice(0, cap)}\n…[truncated at ${cap} bytes]` : text;
  },

  scanRepo: async (rootPath, maxFiles) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('A folder path is required.');
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: maxFiles ?? DEFAULT_SCAN_FILES });
    const graph = buildGraphFromFiles(trimmed, files);
    const byGroup = new Map<string, number>();
    for (const node of graph.nodes) byGroup.set(node.group, (byGroup.get(node.group) ?? 0) + 1);
    const topGroups = Array.from(byGroup.entries())
      .map(([group, count]) => ({ group, files: count }))
      .sort((a, b) => b.files - a.files)
      .slice(0, 12);
    return {
      fileCount: graph.fileCount,
      edgeCount: graph.edges.length,
      topGroups,
      truncated: graph.truncated || (maxFiles !== undefined && files.length >= maxFiles),
    };
  },

  search: async (rootPath, query, opts) => {
    const trimmed = rootPath?.trim();
    if (!trimmed) throw new Error('A folder path is required.');
    if (!query || query.length === 0) throw new Error('A search query is required.');
    const limit = opts?.maxResults && opts.maxResults > 0 ? opts.maxResults : DEFAULT_SEARCH_RESULTS;
    const files = await collectRepoFiles(trimmed, fsDeps(trimmed), { maxFiles: DEFAULT_SCAN_FILES, codeOnly: false });
    const hits: IdeSearchHit[] = [];
    for (const file of files) {
      if (file.content.length === 0) continue;
      for (const m of grepText(file.content, query, opts)) {
        hits.push({ file: file.relPath, line: m.line, text: m.text });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  },

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
});

/**
 * Build the agent-facing Quick Test runner. Resolves the focused browser tab for
 * the web tracer (via Electron's `webContents`), and uses the real native log
 * stream opener + KG loader. Returns null gracefully when Electron is not
 * available (e.g. a non-Electron test context).
 */
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

/**
 * Build the IDE MCP server bound to the real fs-backed service. Exposed for the
 * host and for any in-process consumer that wants a fresh server instance.
 */
export const buildIdeServer = (): McpServer =>
  createIdeServer({
    ide: getIdeMcpService(),
    quickTest: getQuickTestRunner(),
    db: getDbService() as DbAgentService,
    memory: getSessionMemoryStore(),
  });
