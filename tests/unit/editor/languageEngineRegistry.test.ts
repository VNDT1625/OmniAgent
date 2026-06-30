/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  defaultEngineFor,
  optInCandidates,
  resolveEngine,
  shouldUseMonacoTsWorker,
  type LanguageAnalysis,
} from '../../../packages/desktop/src/renderer/pages/editor/adapters/languageEngineRegistry';

const analysis: LanguageAnalysis = {
  languages: [
    { language: 'typescript', engine: { kind: 'monaco-builtin', server: null, cost: 'free', defaultOn: true } },
    { language: 'rust', engine: { kind: 'lsp', server: 'rust-analyzer', cost: 'heavy', defaultOn: false } },
    { language: 'shell', engine: { kind: 'linter', server: 'shellcheck', cost: 'light', defaultOn: false } },
    { language: 'markdown', engine: { kind: 'syntax', server: null, cost: 'free', defaultOn: true } },
  ],
};

describe('defaultEngineFor', () => {
  it('uses monaco-builtin for TS/JS/JSON/CSS/HTML', () => {
    for (const lang of ['typescript', 'javascript', 'json', 'css', 'html']) {
      expect(defaultEngineFor(lang).kind).toBe('monaco-builtin');
    }
  });

  it('falls back to syntax for everything else', () => {
    expect(defaultEngineFor('rust').kind).toBe('syntax');
    expect(defaultEngineFor('python').kind).toBe('syntax');
  });
});

describe('resolveEngine', () => {
  it('returns default when no analysis is available', () => {
    const engine = resolveEngine('typescript', null);
    expect(engine.kind).toBe('monaco-builtin');
    expect(engine.source).toBe('default');
    expect(engine.active).toBe(true);
  });

  it('honors a free engine from analysis as active', () => {
    const engine = resolveEngine('typescript', analysis);
    expect(engine.kind).toBe('monaco-builtin');
    expect(engine.source).toBe('analysis');
    expect(engine.active).toBe(true);
  });

  it('leaves a costly engine INACTIVE unless opted in', () => {
    const engine = resolveEngine('rust', analysis);
    expect(engine.kind).toBe('lsp');
    expect(engine.server).toBe('rust-analyzer');
    expect(engine.active).toBe(false);
    expect(engine.source).toBe('analysis');
  });

  it('activates a costly engine when the user opted in', () => {
    const engine = resolveEngine('rust', analysis, { enabledOverrides: new Set(['rust']) });
    expect(engine.active).toBe(true);
    expect(engine.source).toBe('override');
  });

  it('falls back to default for a language missing from the analysis', () => {
    const engine = resolveEngine('go', analysis);
    expect(engine.kind).toBe('syntax');
    expect(engine.source).toBe('default');
  });
});

describe('shouldUseMonacoTsWorker', () => {
  it('is true only for an active monaco-builtin engine', () => {
    expect(shouldUseMonacoTsWorker(resolveEngine('typescript', analysis))).toBe(true);
    expect(shouldUseMonacoTsWorker(resolveEngine('rust', analysis))).toBe(false);
    expect(shouldUseMonacoTsWorker(resolveEngine('markdown', analysis))).toBe(false);
  });
});

describe('optInCandidates', () => {
  it('lists costly engines not yet enabled', () => {
    const candidates = optInCandidates(analysis);
    const langs = candidates.map((entry) => entry.language).toSorted();
    expect(langs).toEqual(['rust', 'shell']);
  });

  it('excludes already-enabled languages', () => {
    const candidates = optInCandidates(analysis, new Set(['rust']));
    expect(candidates.map((entry) => entry.language)).toEqual(['shell']);
  });

  it('returns empty when there is no analysis', () => {
    expect(optInCandidates(null)).toEqual([]);
  });
});
