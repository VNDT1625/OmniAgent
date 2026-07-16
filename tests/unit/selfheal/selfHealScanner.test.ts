/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  scanInvalidIcons,
  scanMissingDependencies,
  scanMissingRouteModules,
  scanMissingLocaleFiles,
  runTier0Scan,
  packageNameOf,
} from '@process/selfheal/selfHealScanner';

const ICONS = new Set(['Branch', 'BranchTwo', 'Bug', 'Cat', 'Terminal', 'FileEditing']);

describe('scanInvalidIcons', () => {
  it('flags GitBranch and suggests the nearest valid export (Branch)', () => {
    const files = [{ path: 'a.tsx', content: "import { Bug, GitBranch, Cat } from '@icon-park/react';" }];
    const findings = scanInvalidIcons({ files, validIcons: ICONS });
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe('invalid-icon-import');
    expect(findings[0].fix).toEqual({ kind: 'rename-identifier', filePath: 'a.tsx', from: 'GitBranch', to: 'Branch' });
  });

  it('handles aliased imports using the original (library) name', () => {
    const files = [{ path: 'b.tsx', content: "import { Terminal as TerminalIcon } from '@icon-park/react';" }];
    const findings = scanInvalidIcons({ files, validIcons: ICONS });
    expect(findings).toHaveLength(0); // Terminal IS valid
  });

  it('returns a manual fix when nothing is close enough', () => {
    const files = [{ path: 'c.tsx', content: "import { Xyzzy } from '@icon-park/react';" }];
    const findings = scanInvalidIcons({ files, validIcons: ICONS });
    expect(findings).toHaveLength(1);
    expect(findings[0].fix.kind).toBe('manual');
  });

  it('does not flag valid icons', () => {
    const files = [{ path: 'd.tsx', content: "import { Bug, Cat, Branch } from '@icon-park/react';" }];
    expect(scanInvalidIcons({ files, validIcons: ICONS })).toHaveLength(0);
  });
});

describe('packageNameOf', () => {
  it('resolves scoped and plain package names', () => {
    expect(packageNameOf('@icon-park/react')).toBe('@icon-park/react');
    expect(packageNameOf('@icon-park/react/es/map')).toBe('@icon-park/react');
    expect(packageNameOf('react-dom/client')).toBe('react-dom');
    expect(packageNameOf('classnames')).toBe('classnames');
  });
});

describe('scanMissingDependencies', () => {
  const installed = new Set(['react', '@arco-design/web-react']);
  it('flags a bare import not in the installed set', () => {
    const files = [{ path: 'a.tsx', content: "import x from 'left-pad';\nimport React from 'react';" }];
    const findings = scanMissingDependencies({ files, installedPackages: installed });
    expect(findings).toHaveLength(1);
    expect(findings[0].fix).toEqual({ kind: 'install-package', packageName: 'left-pad' });
  });

  it('ignores path aliases, relative and node builtins', () => {
    const files = [
      { path: 'a.tsx', content: "import a from '@/common';\nimport b from './x';\nimport c from 'node:fs';" },
    ];
    expect(scanMissingDependencies({ files, installedPackages: installed })).toHaveLength(0);
  });

  it('dedups the same missing package across files', () => {
    const files = [
      { path: 'a.tsx', content: "import x from 'missing-pkg';" },
      { path: 'b.tsx', content: "import y from 'missing-pkg';" },
    ];
    expect(scanMissingDependencies({ files, installedPackages: installed })).toHaveLength(1);
  });
});

describe('scanMissingRouteModules', () => {
  it('flags a lazy route whose module does not resolve', () => {
    const routes = [
      { importerPath: 'Router.tsx', specifier: '@renderer/pages/git' },
      { importerPath: 'Router.tsx', specifier: '@renderer/pages/studio' },
    ];
    const resolveModule = (_i: string, spec: string) => (spec.endsWith('studio') ? '/abs/studio/index.tsx' : undefined);
    const findings = scanMissingRouteModules({ routes, resolveModule });
    expect(findings).toHaveLength(1);
    expect(findings[0].signature).toContain('@renderer/pages/git');
    expect(findings[0].fix.kind).toBe('manual');
  });
});

describe('scanMissingLocaleFiles', () => {
  it('proposes copying the base file when a locale json is missing', () => {
    const imports = [
      { indexPath: '/l/ru-RU/index.ts', jsonFile: 'git.json', exists: false, baseFallbackPath: '/l/en-US/git.json' },
      { indexPath: '/l/en-US/index.ts', jsonFile: 'git.json', exists: true },
    ];
    const findings = scanMissingLocaleFiles({ imports });
    expect(findings).toHaveLength(1);
    expect(findings[0].fix).toEqual({
      kind: 'copy-locale-file',
      fromPath: '/l/en-US/git.json',
      toPath: '/l/ru-RU/git.json',
    });
  });

  it('falls back to manual when no base file exists', () => {
    const imports = [{ indexPath: '/l/ru-RU/index.ts', jsonFile: 'new.json', exists: false }];
    expect(scanMissingLocaleFiles({ imports })[0].fix.kind).toBe('manual');
  });
});

describe('runTier0Scan', () => {
  it('aggregates findings and counts auto-fixable ones', () => {
    const report = runTier0Scan({
      icons: {
        files: [{ path: 'a.tsx', content: "import { GitBranch } from '@icon-park/react';" }],
        validIcons: ICONS,
      },
      locales: {
        imports: [
          {
            indexPath: '/l/ru-RU/index.ts',
            jsonFile: 'git.json',
            exists: false,
            baseFallbackPath: '/l/en-US/git.json',
          },
        ],
      },
    });
    expect(report.findings).toHaveLength(2);
    expect(report.autoFixable).toBe(2);
  });
});
