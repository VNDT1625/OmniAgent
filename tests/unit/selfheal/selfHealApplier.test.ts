/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { createSelfHealApplier, rewriteIdentifier, type SelfHealFs } from '@process/selfheal/selfHealApplier';
import type { SelfHealFinding } from '@process/selfheal/selfHealTypes';

describe('rewriteIdentifier', () => {
  it('replaces whole-word identifiers only', () => {
    const src = "import { GitBranch } from 'x';\n<GitBranch />;\nconst gitBranchName = 1;";
    const { text, count } = rewriteIdentifier(src, 'GitBranch', 'Branch');
    expect(count).toBe(2);
    expect(text).toContain("import { Branch } from 'x';");
    expect(text).toContain('<Branch />');
    expect(text).toContain('gitBranchName'); // not touched
  });

  it('does not corrupt longer identifiers that contain the target', () => {
    const { text, count } = rewriteIdentifier('Branch BranchTwo', 'Branch', 'Fork');
    expect(count).toBe(1);
    expect(text).toBe('Fork BranchTwo');
  });
});

/** Build an in-memory fs over a map of path → content. */
const memFs = (files: Record<string, string>): SelfHealFs => ({
  readFile: async (p) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
    return files[p];
  },
  writeFile: async (p, data) => {
    files[p] = data;
  },
  access: async (p) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`);
  },
  mkdir: async () => {},
});

describe('createSelfHealApplier — rename-identifier', () => {
  it('rewrites the file and snapshots the original', async () => {
    const files = { 'a.tsx': "import { GitBranch } from '@icon-park/react';\n<GitBranch />;" };
    const snapshots: Array<{ path: string; original: string }> = [];
    const applier = createSelfHealApplier({
      fs: memFs(files),
      onSnapshot: async (path, original) => void snapshots.push({ path, original }),
    });
    const finding: SelfHealFinding = {
      ruleId: 'invalid-icon-import',
      tier: 'tier0',
      severity: 'critical',
      signature: 'sig',
      summary: '',
      fix: { kind: 'rename-identifier', filePath: 'a.tsx', from: 'GitBranch', to: 'Branch' },
    };
    const result = await applier.apply(finding);
    expect(result.applied).toBe(true);
    expect(files['a.tsx']).toContain('Branch');
    expect(files['a.tsx']).not.toContain('GitBranch');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].original).toContain('GitBranch');
  });

  it('reports not-applied when the identifier is absent', async () => {
    const applier = createSelfHealApplier({ fs: memFs({ 'a.tsx': 'nothing here' }) });
    const result = await applier.apply({
      ruleId: 'invalid-icon-import',
      tier: 'tier0',
      severity: 'critical',
      signature: 'sig',
      summary: '',
      fix: { kind: 'rename-identifier', filePath: 'a.tsx', from: 'GitBranch', to: 'Branch' },
    });
    expect(result.applied).toBe(false);
  });
});

describe('createSelfHealApplier — copy-locale-file', () => {
  it('creates the missing file from the base, never overwrites', async () => {
    const files: Record<string, string> = { '/l/en-US/git.json': '{"a":1}' };
    const applier = createSelfHealApplier({ fs: memFs(files) });
    const ok = await applier.apply({
      ruleId: 'missing-locale-file',
      tier: 'tier0',
      severity: 'critical',
      signature: 'sig',
      summary: '',
      fix: { kind: 'copy-locale-file', fromPath: '/l/en-US/git.json', toPath: '/l/ru-RU/git.json' },
    });
    expect(ok.applied).toBe(true);
    expect(files['/l/ru-RU/git.json']).toBe('{"a":1}');

    // Second run: target now exists → must NOT overwrite.
    const again = await applier.apply({
      ruleId: 'missing-locale-file',
      tier: 'tier0',
      severity: 'critical',
      signature: 'sig',
      summary: '',
      fix: { kind: 'copy-locale-file', fromPath: '/l/en-US/git.json', toPath: '/l/ru-RU/git.json' },
    });
    expect(again.applied).toBe(false);
  });
});

describe('createSelfHealApplier — install-package', () => {
  it('delegates to the injected installer', async () => {
    const installer = { install: vi.fn(async () => ({ ok: true })) };
    const applier = createSelfHealApplier({ fs: memFs({}), installer });
    const res = await applier.apply({
      ruleId: 'missing-dependency',
      tier: 'tier0',
      severity: 'critical',
      signature: 'sig',
      summary: '',
      fix: { kind: 'install-package', packageName: 'left-pad' },
    });
    expect(res.applied).toBe(true);
    expect(installer.install).toHaveBeenCalledWith('left-pad');
  });

  it('reports not-applied when no installer is configured', async () => {
    const applier = createSelfHealApplier({ fs: memFs({}) });
    const res = await applier.apply({
      ruleId: 'missing-dependency',
      tier: 'tier0',
      severity: 'critical',
      signature: 'sig',
      summary: '',
      fix: { kind: 'install-package', packageName: 'left-pad' },
    });
    expect(res.applied).toBe(false);
  });
});

describe('createSelfHealApplier — applyAll', () => {
  it('skips manual findings', async () => {
    const applier = createSelfHealApplier({ fs: memFs({ 'a.tsx': 'GitBranch' }) });
    const results = await applier.applyAll([
      {
        ruleId: 'missing-route-module',
        tier: 'tier0',
        severity: 'critical',
        signature: 'manual-sig',
        summary: '',
        fix: { kind: 'manual', hint: 'do it yourself' },
      },
      {
        ruleId: 'invalid-icon-import',
        tier: 'tier0',
        severity: 'critical',
        signature: 'rename-sig',
        summary: '',
        fix: { kind: 'rename-identifier', filePath: 'a.tsx', from: 'GitBranch', to: 'Branch' },
      },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].applied).toBe(true);
  });
});
