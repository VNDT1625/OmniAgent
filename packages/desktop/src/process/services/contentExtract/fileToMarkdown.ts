/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File → Markdown extraction. Converts a local document (PDF, Word, PowerPoint,
 * Excel, HTML, CSV/JSON/XML, …) into clean Markdown so any AI surface gets a
 * structured, model-friendly representation instead of flat text.
 *
 * Strategy (first success wins):
 *  1. **markitdown** via `uvx markitdown <file>` — Microsoft's converter, the
 *     best general-purpose file → Markdown tool (keeps headings/tables/lists).
 *     Used when `uvx` is available, matching the project's `uvx` MCP convention;
 *     nothing is bundled.
 *  2. **Node fallbacks** (already project dependencies — no Python needed):
 *     - `.docx` → `mammoth` (→ HTML) → `turndown` (→ Markdown),
 *     - office/PDF → `officeparser` (→ text),
 *     - `.html/.htm` → `turndown`,
 *     - text-like (md/csv/json/xml/…) → read as UTF-8.
 *
 * Never throws: any failure resolves with `ok:false` so callers degrade.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs. Heavy
 * collaborators (uvx spawner, Node parsers) are lazily imported / injected so
 * the module loads cheaply and stays unit-testable.
 */

import { execFile } from 'node:child_process';
import { extname, basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { findExternalTool, envWithToolPaths } from './externalTools';
import type { ExtractOutcome, ExtractVia } from './contentExtractTypes';

/** Minimal spawner contract (injectable for tests). */
export type SpawnLike = (
  file: string,
  args: string[],
  options: { timeout?: number }
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Dependencies and tunables for {@link createFileToMarkdown}. */
export type FileToMarkdownDeps = {
  /** Locate `uvx`. Defaults to {@link findExternalTool}. Returns null when absent. */
  resolveUvx?: () => Promise<string | null>;
  /** Process spawner (for `uvx markitdown`). Defaults to an `execFile` wrapper. */
  spawn?: SpawnLike;
  /** Read a file as UTF-8 (injectable for tests). */
  readTextFile?: (path: string) => Promise<string>;
  /** Read a docx → Markdown via mammoth+turndown (injectable for tests). */
  readDocxMarkdown?: (path: string) => Promise<string>;
  /** Read an office/PDF → text via officeparser (injectable for tests). */
  readOfficeText?: (path: string) => Promise<string>;
  /** Read an HTML file → Markdown via turndown (injectable for tests). */
  readHtmlMarkdown?: (path: string) => Promise<string>;
  /** Max characters returned. Defaults to 100000. */
  maxChars?: number;
};

/** Public contract. */
export type IFileToMarkdown = {
  /** Convert a file to Markdown/text. Never rejects; `ok:false` on failure. */
  toMarkdown(filePath: string): Promise<ExtractOutcome>;
};

const DEFAULT_MAX_CHARS = 100000;

const OFFICE_EXTS = new Set(['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.odt', '.odp', '.ods']);
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.yaml', '.yml', '.log', '.xml']);
const HTML_EXTS = new Set(['.html', '.htm']);

/** Default `execFile`-based spawner. */
const defaultSpawn: SpawnLike = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: options.timeout ?? 120000, windowsHide: true, maxBuffer: 1024 * 1024 * 32, env: envWithToolPaths() },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });

/** Default docx → Markdown using project deps (mammoth → turndown). */
const defaultDocxMarkdown = async (path: string): Promise<string> => {
  const mammoth = (await import('mammoth')) as {
    convertToHtml?: (opts: { path: string }) => Promise<{ value: string }>;
  };
  if (typeof mammoth.convertToHtml !== 'function') throw new Error('mammoth unavailable');
  const { value: html } = await mammoth.convertToHtml({ path });
  const TurndownService = (await import('turndown')).default;
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return td.turndown(html);
};

/** Default office/PDF → text using officeparser. */
const defaultOfficeText = async (path: string): Promise<string> => {
  const officeparser = (await import('officeparser')) as { parseOfficeAsync?: (p: string) => Promise<string> };
  if (typeof officeparser.parseOfficeAsync !== 'function') throw new Error('officeparser unavailable');
  const text = await officeparser.parseOfficeAsync(path);
  return typeof text === 'string' ? text : '';
};

/** Default HTML → Markdown using turndown. */
const defaultHtmlMarkdown = async (path: string): Promise<string> => {
  const html = await readFile(path, 'utf-8');
  const TurndownService = (await import('turndown')).default;
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  return td.turndown(html);
};

/**
 * Create an {@link IFileToMarkdown}.
 *
 * @param deps Injected uvx locator / spawner / Node parsers + tunables.
 */
export const createFileToMarkdown = (deps: FileToMarkdownDeps = {}): IFileToMarkdown => {
  const resolveUvx = deps.resolveUvx ?? (() => findExternalTool('uvx'));
  const spawn = deps.spawn ?? defaultSpawn;
  const readTextFile = deps.readTextFile ?? ((p) => readFile(p, 'utf-8'));
  const readDocxMarkdown = deps.readDocxMarkdown ?? defaultDocxMarkdown;
  const readOfficeText = deps.readOfficeText ?? defaultOfficeText;
  const readHtmlMarkdown = deps.readHtmlMarkdown ?? defaultHtmlMarkdown;
  const maxChars = deps.maxChars ?? DEFAULT_MAX_CHARS;

  /** Strategy 1: `uvx markitdown <file>` → Markdown on stdout. */
  const viaMarkitdown = async (filePath: string, tried: string[]): Promise<string> => {
    const uvx = await resolveUvx();
    if (!uvx) {
      tried.push('uvx not installed');
      return '';
    }
    try {
      const { code, stdout, stderr } = await spawn(uvx, ['markitdown', filePath], { timeout: 120000 });
      if (code !== 0) {
        tried.push(`markitdown exit ${code}${stderr ? ': ' + stderr.replace(/\s+/g, ' ').trim().slice(0, 120) : ''}`);
        return '';
      }
      const text = stdout.trim();
      if (!text) tried.push('markitdown empty output');
      return text;
    } catch (e) {
      tried.push('markitdown err ' + (e instanceof Error ? e.message : String(e)));
      return '';
    }
  };

  /** Strategy 2: Node-only fallbacks by extension. */
  const viaNode = async (
    filePath: string,
    ext: string,
    tried: string[]
  ): Promise<{ text: string; via: ExtractVia }> => {
    try {
      if (ext === '.docx') return { text: await readDocxMarkdown(filePath), via: 'node-mammoth' };
      if (OFFICE_EXTS.has(ext)) return { text: await readOfficeText(filePath), via: 'node-officeparser' };
      if (HTML_EXTS.has(ext)) return { text: await readHtmlMarkdown(filePath), via: 'node-turndown' };
      if (TEXT_EXTS.has(ext) || ext === '') return { text: await readTextFile(filePath), via: 'node-text' };
      // Unknown: best-effort UTF-8 read.
      return { text: await readTextFile(filePath), via: 'node-text' };
    } catch (e) {
      tried.push('node ' + ext + ' err ' + (e instanceof Error ? e.message : String(e)));
      return { text: '', via: 'none' };
    }
  };

  const toMarkdown = async (filePath: string): Promise<ExtractOutcome> => {
    const ext = extname(filePath).toLowerCase();
    const title = basename(filePath);
    const tried: string[] = [];

    const md = await viaMarkitdown(filePath, tried);
    if (md) return { ok: true, text: md.slice(0, maxChars), via: 'markitdown', title };

    const node = await viaNode(filePath, ext, tried);
    const text = node.text.trim();
    if (text) return { ok: true, text: text.slice(0, maxChars), via: node.via, title };

    return { ok: false, reason: tried.join('; ') || 'no extractor produced content' };
  };

  return { toMarkdown };
};
