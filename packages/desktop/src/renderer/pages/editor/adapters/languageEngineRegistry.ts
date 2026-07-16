/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Language Engine Registry — the renderer-side decision layer that maps a
 * Monaco language id to the intelligence engine the editor should use, driven
 * by `mtui analyze type` (via the `ide.analyze-languages` bridge).
 *
 * The editor asks {@link resolveEngine} "what engine for this language?" instead
 * of hardcoding the Monaco TS worker. When no analysis is available (MTUI not
 * bundled / not yet run) it falls back to {@link defaultEngineFor}: Monaco's
 * bundled service for TS/JS/JSON/CSS/HTML, syntax-only otherwise. Heavy LSP
 * engines are never auto-enabled — they stay opt-in (see `enabledOverrides`).
 *
 * Pure module; no Monaco/IPC imports, fully unit-testable. Renderer-only.
 */

/** The engine kinds, mirroring `mtui analyze` output. */
export type EngineKind = 'monaco-builtin' | 'linter' | 'lsp' | 'syntax';

/** A resolved engine decision for one language. */
export type ResolvedEngine = {
  language: string;
  kind: EngineKind;
  server: string | null;
  /** Whether the editor should actually activate it now. */
  active: boolean;
  /** `default` | `analysis` | `override` — where the decision came from. */
  source: 'default' | 'analysis' | 'override';
};

/** One language entry from the analyze bridge (structural subset). */
export type AnalysisEntry = {
  language: string;
  engine: {
    kind: EngineKind;
    server: string | null;
    cost: 'free' | 'light' | 'medium' | 'heavy';
    defaultOn: boolean;
  };
};

/** The analyze payload the registry consumes. */
export type LanguageAnalysis = {
  languages: AnalysisEntry[];
};

/** Monaco language ids served by Monaco's bundled language service. */
const MONACO_BUILTIN = new Set([
  'typescript',
  'javascript',
  'typescriptreact',
  'javascriptreact',
  'json',
  'css',
  'html',
]);

/**
 * The default engine for a language with no analysis: Monaco's bundled service
 * for the languages it covers, otherwise syntax highlight only.
 */
export const defaultEngineFor = (language: string): ResolvedEngine => {
  if (MONACO_BUILTIN.has(language)) {
    return { language, kind: 'monaco-builtin', server: null, active: true, source: 'default' };
  }
  return { language, kind: 'syntax', server: null, active: true, source: 'default' };
};

/** Options influencing resolution (user opt-ins for costly engines). */
export type ResolveOptions = {
  /**
   * Languages the user explicitly enabled a costly engine for (LSP/linter).
   * Only these may activate a non-free engine; everything else stays free.
   */
  enabledOverrides?: ReadonlySet<string>;
};

/**
 * Resolve the engine for `language`, given an optional analysis and user
 * overrides. Rules:
 *  - No analysis → {@link defaultEngineFor}.
 *  - Analysis says `monaco-builtin`/`syntax` (free) → use it, active.
 *  - Analysis says `linter`/`lsp` (costly) → only active if the user opted in
 *    via `enabledOverrides`; otherwise recorded but inactive (so the UI can
 *    offer to enable it) and the editor falls back to a free engine.
 */
export const resolveEngine = (
  language: string,
  analysis: LanguageAnalysis | null,
  options: ResolveOptions = {}
): ResolvedEngine => {
  if (!analysis) return defaultEngineFor(language);
  const entry = analysis.languages.find((item) => item.language === language);
  if (!entry) return defaultEngineFor(language);

  const { kind, server } = entry.engine;
  // Free engines: always honor the analysis.
  if (kind === 'monaco-builtin' || kind === 'syntax') {
    return { language, kind, server, active: true, source: 'analysis' };
  }
  // Costly engines (linter/lsp): opt-in only.
  const optedIn = options.enabledOverrides?.has(language) ?? false;
  if (optedIn) {
    return { language, kind, server, active: true, source: 'override' };
  }
  // Not opted in: surface the recommendation but stay inactive; the editor
  // falls back to a free engine so the file is still usable.
  return { language, kind, server, active: false, source: 'analysis' };
};

/** Whether a resolved engine means "turn on the Monaco TS worker". */
export const shouldUseMonacoTsWorker = (engine: ResolvedEngine): boolean =>
  engine.active && engine.kind === 'monaco-builtin';

/**
 * List costly engines (linter/lsp) the analysis recommends but that are not yet
 * enabled — i.e. the opt-in candidates a UI would present to the user.
 */
export const optInCandidates = (
  analysis: LanguageAnalysis | null,
  enabledOverrides: ReadonlySet<string> = new Set()
): AnalysisEntry[] => {
  if (!analysis) return [];
  return analysis.languages.filter(
    (entry) => (entry.engine.kind === 'linter' || entry.engine.kind === 'lsp') && !enabledOverrides.has(entry.language)
  );
};
