/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `codeContextProvider` — gathers the source snippets relevant to a bug report
 * so the {@link IRootCauseAnalyzer}'s agent can reason about the actual code
 * (Yêu cầu 6, criterion 6.3: "dò mã nguồn"). It parses file paths out of the
 * report's stack trace, reads the referenced files (best-effort), and returns a
 * window of lines around each referenced location.
 *
 * Safety: it ONLY reads files inside the configured `roots` (the app source
 * dir). A path that escapes the roots — or any unreadable/oversized file — is
 * skipped silently; gathering context must never throw or read arbitrary disk.
 *
 * The fs layer is injected so this module is unit-testable without real files.
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BugReport } from './monitorTypes';
import type { CodeContextProvider } from './rootCauseAnalyzer';

/** Minimal fs surface used by the provider (injectable for tests). */
export type CodeContextFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
};

const defaultFs: CodeContextFs = {
  readFile: (p, enc) => fs.promises.readFile(p, enc),
};

/** Options for {@link createCodeContextProvider}. */
export type CodeContextProviderOptions = {
  /** Absolute directories the provider is allowed to read from. */
  roots: string[];
  /** fs implementation. Defaults to `fs/promises`. */
  fs?: CodeContextFs;
  /** Lines of context to include around a referenced line. Defaults to 40. */
  windowLines?: number;
  /** Max number of distinct files to gather. Defaults to 4. */
  maxFiles?: number;
  /** Max characters returned per file snippet. Defaults to 6000. */
  maxCharsPerFile?: number;
};

/** A single parsed stack reference. */
type StackRef = { file: string; line?: number };

/** Default window of lines gathered around a stack location. */
const DEFAULT_WINDOW = 40;
/** Default cap on distinct files gathered. */
const DEFAULT_MAX_FILES = 4;
/** Default cap on snippet size per file. */
const DEFAULT_MAX_CHARS = 6000;

/**
 * Extract `(file:line:col)` / `at file:line` style references from a stack.
 * Tolerates both Unix and Windows paths and the common `file://` prefix.
 */
export const parseStackRefs = (stack: string): StackRef[] => {
  const refs: StackRef[] = [];
  const seen = new Set<string>();
  // Matches: optional "file://", a path (no spaces/parens), then :line[:col].
  const re = /(?:file:\/\/)?((?:[a-zA-Z]:\\|\/|\.\/|[\w.@-]+\/)[^\s():]+\.[a-zA-Z]+):(\d+)(?::\d+)?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stack)) !== null) {
    const file = match[1];
    const line = Number.parseInt(match[2], 10);
    const key = `${file}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ file, line: Number.isFinite(line) ? line : undefined });
  }
  return refs;
};

/** Resolve a stack file path against a root and confirm it stays inside it. */
const resolveWithinRoot = (root: string, file: string): string | undefined => {
  // A stack path may be absolute or relative; try both against the root.
  const candidate = path.isAbsolute(file) ? file : path.resolve(root, file);
  const normalisedRoot = path.resolve(root);
  const normalised = path.resolve(candidate);
  const rel = path.relative(normalisedRoot, normalised);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return normalised;
};

/**
 * Create a {@link CodeContextProvider} that reads stack-referenced source files
 * within the configured roots.
 *
 * @param options Allowed roots + injectable fs + window/limits.
 * @returns A best-effort code-context gatherer.
 */
export const createCodeContextProvider = (options: CodeContextProviderOptions): CodeContextProvider => {
  const fsImpl = options.fs ?? defaultFs;
  const windowLines = options.windowLines ?? DEFAULT_WINDOW;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxChars = options.maxCharsPerFile ?? DEFAULT_MAX_CHARS;
  const roots = options.roots.map((r) => path.resolve(r));

  const sliceAroundLine = (content: string, line?: number): string => {
    if (!line) return content.slice(0, maxChars);
    const lines = content.split('\n');
    const from = Math.max(0, line - 1 - Math.floor(windowLines / 2));
    const to = Math.min(lines.length, from + windowLines);
    const numbered = lines.slice(from, to).map((text, i) => `${from + i + 1}\t${text}`);
    return numbered.join('\n').slice(0, maxChars);
  };

  const gather: CodeContextProvider['gather'] = async (report: BugReport) => {
    const stack = report.stack ?? '';
    const refs = parseStackRefs(stack);
    const out: Array<{ path: string; content: string }> = [];
    const usedPaths = new Set<string>();

    for (const ref of refs) {
      if (out.length >= maxFiles) break;
      let resolved: string | undefined;
      for (const root of roots) {
        resolved = resolveWithinRoot(root, ref.file);
        if (resolved) break;
      }
      if (!resolved || usedPaths.has(resolved)) continue;

      try {
        const content = await fsImpl.readFile(resolved, 'utf-8');
        usedPaths.add(resolved);
        out.push({ path: resolved, content: sliceAroundLine(content, ref.line) });
      } catch {
        // Unreadable / missing / outside-root file — skip silently.
      }
    }

    return out;
  };

  return { gather };
};
