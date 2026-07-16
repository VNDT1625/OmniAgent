/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Clickable `file:line:col` links for the terminal — the VS Code behaviour where
 * a path printed by a compiler/linter/stack-trace becomes a link that opens the
 * file in the editor at the right position.
 *
 * Implemented as an xterm {@link ILinkProvider} that scans each rendered line for
 * path-like tokens with an optional `:line` / `:line:col` suffix and reports the
 * matched ranges. Activation calls back into the host (the IDE), which resolves
 * the path against the open folder and opens the editor. Pure renderer code —
 * the host owns the actual file opening.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import type { IBufferLine, ILink, ILinkProvider, IViewportRange, Terminal } from '@xterm/xterm';

/** Callback invoked when a file link is activated. */
export type OpenPathHandler = (path: string, line?: number, column?: number) => void;

/**
 * Matches path-like tokens optionally followed by `:line` or `:line:col`.
 * Examples it catches:
 *   src/app.ts:12:5            ./relative/file.tsx:40
 *   C:\repo\file.cs(120,8)     /abs/posix/path.py:7
 * Kept deliberately conservative (requires a path separator or a known file
 * extension) so prose with colons (e.g. "Error: foo") is not turned into links.
 */
const FILE_LINK_RE =
  // eslint-disable-next-line no-useless-escape
  /(?:[A-Za-z]:\\|\.{0,2}[\/\\])?(?:[\w.\-]+[\/\\])*[\w.\-]+\.[A-Za-z0-9]+(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\))?/g;

/** A parsed link candidate within a single terminal line. */
type Candidate = {
  /** 0-based start column within the line. */
  startCol: number;
  /** Exclusive end column. */
  endCol: number;
  text: string;
  path: string;
  line?: number;
  column?: number;
};

/** Read a buffer line's plain text (trimmed of trailing blanks). */
const lineText = (line: IBufferLine | undefined): string => (line ? line.translateToString(true) : '');

/** Parse all file-link candidates in a line's text. */
export const parseFileLinks = (text: string): Candidate[] => {
  const out: Candidate[] = [];
  FILE_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_LINK_RE.exec(text)) !== null) {
    const full = m[0];
    // Suffix groups: 1,2 = ":line:col"; 3,4 = "(line,col)".
    const line = m[1] ?? m[3];
    const column = m[2] ?? m[4];
    // Strip the position suffix from the path itself.
    let pathPart = full;
    const colonIdx = full.search(/(?::\d+(?::\d+)?|\(\d+(?:,\d+)?\))$/);
    if (colonIdx !== -1) pathPart = full.slice(0, colonIdx);
    if (pathPart.length === 0) continue;
    out.push({
      startCol: m.index,
      endCol: m.index + full.length,
      text: full,
      path: pathPart,
      line: line ? Number.parseInt(line, 10) : undefined,
      column: column ? Number.parseInt(column, 10) : undefined,
    });
  }
  return out;
};

/**
 * Register the file-link provider on a terminal. Returns a disposable that
 * removes the provider.
 */
export const registerFileLinks = (term: Terminal, onOpen: OpenPathHandler): { dispose: () => void } => {
  const provider: ILinkProvider = {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      const text = lineText(line);
      if (text.length === 0) {
        callback(undefined);
        return;
      }
      const candidates = parseFileLinks(text);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }
      const links: ILink[] = candidates.map((c) => {
        const range: IViewportRange = {
          start: { x: c.startCol + 1, y: bufferLineNumber },
          end: { x: c.endCol, y: bufferLineNumber },
        };
        return {
          range,
          text: c.text,
          activate: () => onOpen(c.path, c.line, c.column),
        };
      });
      callback(links);
    },
  };

  const disposable = term.registerLinkProvider(provider);
  return { dispose: () => disposable.dispose() };
};
