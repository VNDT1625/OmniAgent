/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE Language-Engine IPC bridge — runs `mtui analyze type` for the open folder
 * and returns the per-language engine recommendation so the renderer's
 * Language Engine Registry can decide which intelligence engine (monaco-builtin
 * / linter / lsp / syntax) to enable per language.
 *
 * One channel: `ide.analyze-languages`. Always-resolving envelope so the
 * renderer never hangs; when MTUI is unavailable (not bundled / not on PATH) it
 * returns `ok: false` and the renderer falls back to its built-in defaults
 * (Monaco TS worker for TS/JS).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { runMtuiInRoot } from '@process/terminal/mtuiBridge';

/** IPC channel names for the IDE language-engine surface. */
export const IDE_LANG_CHANNELS = {
  analyzeLanguages: 'ide.analyze-languages',
} as const;

/** One language entry as emitted by `mtui analyze type`. */
export type LanguageEngineEntry = {
  language: string;
  fileCount: number;
  sharePercent: number;
  engine: {
    kind: 'monaco-builtin' | 'linter' | 'lsp' | 'syntax';
    server: string | null;
    cost: 'free' | 'light' | 'medium' | 'heavy';
    defaultOn: boolean;
    reason: string;
  };
};

/** Parsed analyze-type payload (subset of the MTUI JSON we consume). */
export type LanguageAnalysis = {
  totalFiles: number;
  languages: LanguageEngineEntry[];
  dominant: string[];
};

/** Always-resolving result envelope. */
export type IdeLangResult = { ok: true; data: LanguageAnalysis } | { ok: false; error: string };

/** Request for {@link IDE_LANG_CHANNELS.analyzeLanguages}. */
export type AnalyzeLanguagesRequest = {
  /** Absolute repo root analyzed by MTUI. */
  rootPath: string;
};

/** Typed channel. Exported for bootstrap registration wiring. */
export const ideLangChannels = {
  analyzeLanguages: bridge.buildProvider<IdeLangResult, AnalyzeLanguagesRequest>(IDE_LANG_CHANNELS.analyzeLanguages),
};

/** Narrow an unknown engine kind to our union, defaulting to `syntax`. */
const toEngineKind = (value: unknown): LanguageEngineEntry['engine']['kind'] =>
  value === 'monaco-builtin' || value === 'linter' || value === 'lsp' ? value : 'syntax';

/** Narrow an unknown cost to our union, defaulting to `free`. */
const toEngineCost = (value: unknown): LanguageEngineEntry['engine']['cost'] =>
  value === 'light' || value === 'medium' || value === 'heavy' ? value : 'free';

/**
 * Coerce a raw MTUI `analyze type` JSON object into a {@link LanguageAnalysis}.
 * Tolerant of missing/odd fields so a slightly different MTUI version still
 * yields usable data instead of throwing. Exported for unit testing.
 */
export const parseAnalyzeType = (raw: unknown): LanguageAnalysis => {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const rawLanguages = Array.isArray(obj.languages) ? obj.languages : [];
  const languages: LanguageEngineEntry[] = rawLanguages.map((item) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const engine = (entry.engine ?? {}) as Record<string, unknown>;
    return {
      language: typeof entry.language === 'string' ? entry.language : 'plaintext',
      fileCount: typeof entry.fileCount === 'number' ? entry.fileCount : 0,
      sharePercent: typeof entry.sharePercent === 'number' ? entry.sharePercent : 0,
      engine: {
        kind: toEngineKind(engine.kind),
        server: typeof engine.server === 'string' ? engine.server : null,
        cost: toEngineCost(engine.cost),
        defaultOn: engine.defaultOn !== false,
        reason: typeof engine.reason === 'string' ? engine.reason : '',
      },
    };
  });
  return {
    totalFiles: typeof obj.totalFiles === 'number' ? obj.totalFiles : 0,
    languages,
    dominant: Array.isArray(obj.dominant)
      ? obj.dominant.filter((value): value is string => typeof value === 'string')
      : [],
  };
};

/**
 * Register the IDE language-engine IPC handler. Idempotent. Intended to be
 * called once during Main-process bootstrap.
 */
export function registerIdeLangBridge(): void {
  ideLangChannels.analyzeLanguages.provider(async (req): Promise<IdeLangResult> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) {
      return { ok: false, error: 'rootPath is required' };
    }
    try {
      const response = await runMtuiInRoot(['--json', 'analyze', 'type'], rootPath);
      if (!response || response.ok !== true) {
        return { ok: false, error: 'mtui analyze unavailable' };
      }
      return { ok: true, data: parseAnalyzeType(response) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
