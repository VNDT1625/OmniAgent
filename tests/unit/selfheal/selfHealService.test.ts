/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { createSelfHealService, DEFAULT_AUTO_RULES } from '@process/selfheal/selfHealService';
import type { ISelfHealCollector } from '@process/selfheal/selfHealCollector';
import type { ISelfHealApplier } from '@process/selfheal/selfHealApplier';

const ICONS = new Set(['Branch', 'Bug', 'Terminal']);

/** A collector that yields fixed inputs reproducing the real bugs we hit. */
const stubCollector = (): ISelfHealCollector => ({
  collectIcons: async () => ({
    files: [{ path: 'SettingsSider.tsx', content: "import { GitBranch, Bug } from '@icon-park/react';" }],
    validIcons: ICONS,
  }),
  collectDependencies: async () => ({ files: [], installedPackages: new Set<string>() }),
  collectRoutes: () => ({
    routes: [{ importerPath: 'Router.tsx', specifier: '@renderer/pages/git' }],
    resolveModule: () => undefined, // git route module missing → manual finding
  }),
  collectLocales: () => ({
    imports: [
      { indexPath: '/l/ru-RU/index.ts', jsonFile: 'git.json', exists: false, baseFallbackPath: '/l/en-US/git.json' },
    ],
  }),
});

describe('createSelfHealService.scan', () => {
  it('collects and reports findings from every detector without writing', async () => {
    const applier: ISelfHealApplier = { apply: vi.fn(), applyAll: vi.fn(async () => []) };
    const service = createSelfHealService({
      collector: stubCollector(),
      applier,
      routerRelPath: 'Router.tsx',
      localesRelPath: 'l',
    });
    const report = await service.scan();
    // invalid icon (GitBranch) + missing route (git) + missing locale (git.json)
    expect(report.findings).toHaveLength(3);
    expect(applier.applyAll).not.toHaveBeenCalled();
  });
});

describe('createSelfHealService.healAuto', () => {
  it('auto-applies allow-listed fixes and defers manual/route ones', async () => {
    const applyAll = vi.fn(async (findings: unknown[]) =>
      (findings as { signature: string }[]).map((f) => ({ signature: f.signature, applied: true }))
    );
    const applier: ISelfHealApplier = { apply: vi.fn(), applyAll };
    const service = createSelfHealService({
      collector: stubCollector(),
      applier,
      routerRelPath: 'Router.tsx',
      localesRelPath: 'l',
    });

    const result = await service.healAuto();
    // icon rename + locale copy are allow-listed; route-module (manual) deferred.
    expect(result.attempted.map((f) => f.ruleId).toSorted()).toEqual(['invalid-icon-import', 'missing-locale-file']);
    expect(result.deferred.map((f) => f.ruleId)).toContain('missing-route-module');
    expect(result.results.every((r) => r.applied)).toBe(true);
  });

  it('respects a custom allow-list (icons only)', async () => {
    const applier: ISelfHealApplier = {
      apply: vi.fn(),
      applyAll: vi.fn(async () => []),
    };
    const service = createSelfHealService({
      collector: stubCollector(),
      applier,
      routerRelPath: 'Router.tsx',
      localesRelPath: 'l',
    });
    const result = await service.healAuto({ autoRules: new Set(['invalid-icon-import']) });
    expect(result.attempted).toHaveLength(1);
    expect(result.attempted[0].ruleId).toBe('invalid-icon-import');
  });

  it('default allow-list excludes package installs', () => {
    expect(DEFAULT_AUTO_RULES.has('missing-dependency')).toBe(false);
    expect(DEFAULT_AUTO_RULES.has('invalid-icon-import')).toBe(true);
  });
});
