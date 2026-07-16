/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the file-tree "Run in terminal" quick-command menu — the
 * right-click-a-folder/file → pick a relevant command → it runs in a fresh IDE
 * terminal at the right cwd flow.
 *
 * Kept free of `fs`/IPC/React so it is fully unit-testable: the caller supplies
 * the right-clicked node + any npm scripts it already read from the nearest
 * `package.json`, and this module decides which commands to offer and where to
 * run them. The command strings are plain shell text the terminal executes.
 *
 * Process boundary: renderer-safe (no Node APIs used here).
 */

/** One runnable command offered for a file-tree node. */
export type QuickCommand = {
  /** Stable id (used as the menu key + lookup at click time). */
  id: string;
  /** Short label shown in the menu (the command, mono). */
  label: string;
  /** The shell command to run. */
  command: string;
  /** Working directory the command runs in. */
  cwd: string;
};

/** Input for {@link buildQuickCommands}. */
export type QuickCommandInput = {
  /** Absolute path of the right-clicked node. */
  path: string;
  /** Whether the node is a directory. */
  isDir: boolean;
  /** Workspace root (cwd for repo-wide tools like MTUI). */
  rootPath: string;
  /** npm script names discovered in the nearest `package.json` (may be empty). */
  scripts?: string[];
  /** Absolute dir of the `package.json` the scripts came from (cwd for npm). */
  scriptsCwd?: string;
};

/** Pick the path separator for a path's style (Windows backslash vs POSIX). */
export const sepOf = (p: string): string => (p.includes('\\') && !p.includes('/') ? '\\' : '/');

/** Parent directory of an absolute path (separator-agnostic). */
export const dirOf = (p: string): string => {
  const trimmed = p.replace(/[/\\]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i > 0 ? trimmed.slice(0, i) : trimmed;
};

/** The cwd a command for `node` should run in: the dir itself, or a file's parent. */
export const cwdForNode = (path: string, isDir: boolean): string => (isDir ? path.replace(/[/\\]+$/, '') : dirOf(path));

/** Extract the runnable npm script names from a `package.json` text (tolerant). */
export const parseScripts = (jsonText: string): string[] => {
  try {
    const parsed = JSON.parse(jsonText) as { scripts?: Record<string, unknown> };
    const scripts = parsed?.scripts;
    if (!scripts || typeof scripts !== 'object') return [];
    return Object.keys(scripts).filter((name) => typeof scripts[name] === 'string');
  } catch {
    return [];
  }
};

/** Double-quote a path so spaces survive the shell. */
const quote = (p: string): string => `"${p}"`;

/**
 * Decide which commands to offer for a right-clicked node, in priority order:
 *  1. npm scripts from the nearest package.json (`npm run <name>`) — the most
 *     useful "runnable" actions a project exposes.
 *  2. MTUI: map a folder / compass-read a file (repo intelligence at the path).
 *  3. `git status` for the path's directory.
 *
 * Pure: never runs anything. The caller wires each result to a terminal.
 */
export const buildQuickCommands = (input: QuickCommandInput): QuickCommand[] => {
  const cwd = cwdForNode(input.path, input.isDir);
  const out: QuickCommand[] = [];

  if (input.scripts && input.scripts.length > 0 && input.scriptsCwd) {
    for (const name of input.scripts) {
      out.push({ id: `npm:${name}`, label: `npm run ${name}`, command: `npm run ${name}`, cwd: input.scriptsCwd });
    }
  }

  if (input.isDir) {
    out.push({
      id: 'mtui-map',
      label: 'mtui map folder',
      command: `mtui --json map folder ${quote(input.path)}`,
      cwd: input.rootPath,
    });
  } else {
    out.push({
      id: 'mtui-read',
      label: 'mtui compass read',
      command: `mtui --json compass read ${quote(input.path)}`,
      cwd: input.rootPath,
    });
  }

  out.push({ id: 'git-status', label: 'git status', command: 'git status', cwd });

  return out;
};
