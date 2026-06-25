/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  catalogById,
  catalogForLanguage,
  LSP_CATALOG,
  planLspPrompts,
  type AnalyzedLanguage,
} from '../../../../packages/desktop/src/process/ide/lang/lspCatalog';

describe('catalog lookups', () => {
  it('maps languages to servers', () => {
    expect(catalogForLanguage('rust')?.id).toBe('rust-analyzer');
    expect(catalogForLanguage('typescript')?.id).toBe('typescript-language-server');
    expect(catalogForLanguage('python')?.id).toBe('pyright');
    expect(catalogForLanguage('cpp')?.id).toBe('clangd');
    expect(catalogForLanguage('cobol')).toBeUndefined();
  });

  it('finds servers by id', () => {
    expect(catalogById('gopls')?.displayName).toContain('gopls');
    expect(catalogById('nope')).toBeUndefined();
  });

  it('every catalog entry has a size and cost for the opt-in prompt', () => {
    for (const server of LSP_CATALOG) {
      expect(server.approxSizeMb).toBeGreaterThan(0);
      expect(['light', 'medium', 'heavy']).toContain(server.cost);
      if (server.installMethod === 'npm') {
        expect(server.npmPackage, `${server.id} needs npmPackage`).toBeTruthy();
      }
    }
  });
});

describe('planLspPrompts', () => {
  const analysis: AnalyzedLanguage[] = [
    { language: 'typescript', fileCount: 1000, engine: { kind: 'monaco-builtin' } },
    { language: 'rust', fileCount: 40, engine: { kind: 'lsp' } },
    { language: 'python', fileCount: 120, engine: { kind: 'lsp' } },
    { language: 'shell', fileCount: 12, engine: { kind: 'linter' } },
    { language: 'markdown', fileCount: 80, engine: { kind: 'syntax' } },
  ];

  it('offers only languages whose engine is lsp', () => {
    const prompts = planLspPrompts(analysis);
    const ids = prompts.map((prompt) => prompt.server.id);
    expect(ids).toContain('rust-analyzer');
    expect(ids).toContain('pyright');
    // monaco-builtin (TS), linter (shell), syntax (md) must NOT be offered as LSP.
    expect(ids).not.toContain('typescript-language-server');
  });

  it('orders prompts by file count descending (most relevant first)', () => {
    const prompts = planLspPrompts(analysis);
    expect(prompts[0].server.id).toBe('pyright'); // 120 > 40
    expect(prompts[1].server.id).toBe('rust-analyzer');
  });

  it('skips servers already installed', () => {
    const prompts = planLspPrompts(analysis, new Set(['pyright']));
    const ids = prompts.map((prompt) => prompt.server.id);
    expect(ids).toEqual(['rust-analyzer']);
  });

  it('groups multiple languages onto one server (c + cpp → clangd)', () => {
    const cpp: AnalyzedLanguage[] = [
      { language: 'c', fileCount: 10, engine: { kind: 'lsp' } },
      { language: 'cpp', fileCount: 30, engine: { kind: 'lsp' } },
    ];
    const prompts = planLspPrompts(cpp);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].server.id).toBe('clangd');
    expect(prompts[0].fileCount).toBe(40);
    expect(prompts[0].languages.sort()).toEqual(['c', 'cpp']);
  });

  it('returns nothing when no language needs an lsp', () => {
    const noLsp: AnalyzedLanguage[] = [{ language: 'typescript', fileCount: 100, engine: { kind: 'monaco-builtin' } }];
    expect(planLspPrompts(noLsp)).toEqual([]);
  });
});
