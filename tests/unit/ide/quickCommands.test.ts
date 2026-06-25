/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildQuickCommands,
  cwdForNode,
  dirOf,
  parseScripts,
  sepOf,
} from '@/renderer/pages/studio/ide/quickCommands';

describe('sepOf', () => {
  it('detects windows backslash vs posix slash', () => {
    expect(sepOf('C:\\a\\b')).toBe('\\');
    expect(sepOf('/a/b')).toBe('/');
    expect(sepOf('a/b\\c')).toBe('/'); // mixed → posix (has a forward slash)
  });
});

describe('dirOf', () => {
  it('returns the parent directory across separators', () => {
    expect(dirOf('/a/b/c.ts')).toBe('/a/b');
    expect(dirOf('C:\\a\\b\\c.ts')).toBe('C:\\a\\b');
    expect(dirOf('/a/b/')).toBe('/a'); // trailing sep ignored
  });
});

describe('cwdForNode', () => {
  it('uses the dir itself for a directory, the parent for a file', () => {
    expect(cwdForNode('/repo/src', true)).toBe('/repo/src');
    expect(cwdForNode('/repo/src/', true)).toBe('/repo/src');
    expect(cwdForNode('/repo/src/a.ts', false)).toBe('/repo/src');
  });
});

describe('parseScripts', () => {
  it('returns string-valued script names', () => {
    const json = JSON.stringify({ scripts: { build: 'tsc', test: 'vitest', bad: 123 } });
    expect(parseScripts(json).sort()).toEqual(['build', 'test']);
  });

  it('returns [] for missing scripts or invalid JSON', () => {
    expect(parseScripts('{}')).toEqual([]);
    expect(parseScripts('{ not json')).toEqual([]);
    expect(parseScripts(JSON.stringify({ scripts: null }))).toEqual([]);
  });
});

describe('buildQuickCommands', () => {
  const root = '/repo';

  it('offers npm scripts (running in the package dir) for a folder', () => {
    const cmds = buildQuickCommands({
      path: '/repo/pkg',
      isDir: true,
      rootPath: root,
      scripts: ['build', 'dev'],
      scriptsCwd: '/repo/pkg',
    });
    const npm = cmds.filter((c) => c.id.startsWith('npm:'));
    expect(npm.map((c) => c.command)).toEqual(['npm run build', 'npm run dev']);
    expect(npm.every((c) => c.cwd === '/repo/pkg')).toBe(true);
  });

  it('offers mtui map + git status for a directory', () => {
    const cmds = buildQuickCommands({ path: '/repo/src', isDir: true, rootPath: root });
    const ids = cmds.map((c) => c.id);
    expect(ids).toContain('mtui-map');
    expect(ids).toContain('git-status');
    expect(ids).not.toContain('mtui-read');
    const map = cmds.find((c) => c.id === 'mtui-map')!;
    expect(map.command).toContain('map folder');
    expect(map.command).toContain('"/repo/src"');
    expect(map.cwd).toBe(root); // repo-wide tool runs at the root
  });

  it('offers mtui compass read for a file (cwd = file dir)', () => {
    const cmds = buildQuickCommands({ path: '/repo/src/a.ts', isDir: false, rootPath: root });
    const read = cmds.find((c) => c.id === 'mtui-read')!;
    expect(read.command).toContain('compass read');
    expect(read.command).toContain('"/repo/src/a.ts"');
    const git = cmds.find((c) => c.id === 'git-status')!;
    expect(git.cwd).toBe('/repo/src');
  });

  it('omits npm entries when there are no scripts', () => {
    const cmds = buildQuickCommands({ path: '/repo/src', isDir: true, rootPath: root, scripts: [] });
    expect(cmds.some((c) => c.id.startsWith('npm:'))).toBe(false);
  });
});
