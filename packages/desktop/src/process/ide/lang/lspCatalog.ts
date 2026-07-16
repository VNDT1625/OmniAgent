/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LSP server catalog — the on-demand install model. The app ships WITHOUT any
 * language server. When `mtui analyze type` reports a language whose
 * recommended engine is `lsp` and the user opts in, the app downloads that one
 * server into its own data dir (never touching the user's system) and marks it
 * installed. Languages the user never asks for cost nothing.
 *
 * This module is the pure, testable "brain" of that flow:
 *  - {@link LSP_CATALOG}: known servers per language (id, display, approx size,
 *    install method) — no URLs/exec here, just metadata.
 *  - {@link catalogForLanguage}: look up a server by Monaco language id.
 *  - {@link planLspPrompts}: given the analysis + already-installed set, decide
 *    which servers to OFFER the user (the "ask" step). It never auto-installs.
 *
 * The actual download/spawn (network + child process) lives in the install
 * manager + LSP runtime, kept separate so this decision layer stays pure.
 *
 * Process boundary: Main-process module, but pure (no Node APIs used here).
 */

/** How a server is obtained when the user opts in. */
export type InstallMethod =
  /** Downloaded as a standalone binary release (e.g. rust-analyzer, gopls). */
  | 'binary-release'
  /** Installed as an npm package into the app data dir (e.g. TS, pyright). */
  | 'npm';

/** Catalog metadata for one language server. */
export type LspServerInfo = {
  /** Stable server id (used as install dir name + state key). */
  id: string;
  /** Human-readable name (UI shows this; not localized — a proper noun). */
  displayName: string;
  /** Monaco language ids this server serves. */
  languages: string[];
  /** How the app fetches it. */
  installMethod: InstallMethod;
  /** npm package name when `installMethod === 'npm'`. */
  npmPackage?: string;
  /** Approximate download size in MB (for the opt-in prompt warning). */
  approxSizeMb: number;
  /** Approximate resident memory cost, mirroring `mtui analyze` cost tiers. */
  cost: 'light' | 'medium' | 'heavy';
};

/**
 * Known servers. Intentionally small and conservative: only servers we can
 * fetch reliably and that match `mtui analyze`'s `lsp`/`linter` suggestions.
 */
export const LSP_CATALOG: readonly LspServerInfo[] = [
  {
    id: 'typescript-language-server',
    displayName: 'TypeScript Language Server',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    installMethod: 'npm',
    npmPackage: 'typescript-language-server',
    approxSizeMb: 10,
    cost: 'light',
  },
  {
    id: 'pyright',
    displayName: 'Pyright (Python)',
    languages: ['python'],
    installMethod: 'npm',
    npmPackage: 'pyright',
    approxSizeMb: 15,
    cost: 'medium',
  },
  {
    id: 'rust-analyzer',
    displayName: 'rust-analyzer',
    languages: ['rust'],
    installMethod: 'binary-release',
    approxSizeMb: 45,
    cost: 'heavy',
  },
  {
    id: 'gopls',
    displayName: 'gopls (Go)',
    languages: ['go'],
    installMethod: 'binary-release',
    approxSizeMb: 30,
    cost: 'medium',
  },
  {
    id: 'clangd',
    displayName: 'clangd (C/C++)',
    languages: ['c', 'cpp'],
    installMethod: 'binary-release',
    approxSizeMb: 40,
    cost: 'heavy',
  },
];

/** Find the catalog server that serves a given Monaco language id. */
export const catalogForLanguage = (language: string): LspServerInfo | undefined =>
  LSP_CATALOG.find((server) => server.languages.includes(language));

/** Find a catalog server by its id. */
export const catalogById = (id: string): LspServerInfo | undefined => LSP_CATALOG.find((server) => server.id === id);

/** One analyzed language entry (subset of `mtui analyze type` output). */
export type AnalyzedLanguage = {
  language: string;
  fileCount: number;
  engine: { kind: 'monaco-builtin' | 'linter' | 'lsp' | 'syntax' };
};

/** A single "offer this server?" suggestion for the UI prompt. */
export type LspPrompt = {
  /** Server to offer. */
  server: LspServerInfo;
  /** Languages in the repo this server would serve. */
  languages: string[];
  /** Total files across those languages (helps the user judge value). */
  fileCount: number;
};

/**
 * Decide which servers to OFFER, given the analysis and the already-installed
 * server ids. Rules:
 *  - Only consider languages whose recommended engine is `lsp`.
 *  - Map each to its catalog server; group by server (one prompt per server).
 *  - Skip servers already installed.
 *  - Order by total file count desc (most relevant first).
 *
 * Pure: never installs anything. Returns the list a UI turns into "Enable X?"
 * cards the user can accept (→ triggers download) or dismiss.
 */
export const planLspPrompts = (
  languages: readonly AnalyzedLanguage[],
  installedIds: ReadonlySet<string> = new Set()
): LspPrompt[] => {
  const byServer = new Map<string, LspPrompt>();
  for (const entry of languages) {
    if (entry.engine.kind !== 'lsp') continue;
    const server = catalogForLanguage(entry.language);
    if (!server || installedIds.has(server.id)) continue;
    const existing = byServer.get(server.id);
    if (existing) {
      existing.languages.push(entry.language);
      existing.fileCount += entry.fileCount;
    } else {
      byServer.set(server.id, {
        server,
        languages: [entry.language],
        fileCount: entry.fileCount,
      });
    }
  }
  return [...byServer.values()].toSorted((a, b) => b.fileCount - a.fileCount);
};
