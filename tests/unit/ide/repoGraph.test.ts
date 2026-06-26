/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the pure intra-repo import-graph builder. Every case exercises
 * `buildGraphFromFiles` directly with in-memory files — no fs, no network — so
 * the parser/resolver behavior is fully deterministic.
 */

import { describe, expect, it } from 'vitest';
import { buildGraphFromFiles, collectRepoFiles } from '@/process/ide/repoGraph';
import type { GraphEdge } from '@/process/ide/repoGraph';

/** Find an edge by from/to (helper for assertions). */
const hasEdge = (edges: GraphEdge[], from: string, to: string): boolean =>
  edges.some((e) => e.from === from && e.to === to);

describe('buildGraphFromFiles', () => {
  it('builds a node for every provided file', () => {
    const graph = buildGraphFromFiles('/repo', [
      { relPath: 'src/a.ts', content: '' },
      { relPath: 'src/b.ts', content: '' },
      { relPath: 'README.md', content: '# hi' },
    ]);

    expect(graph.nodes).toHaveLength(3);
    expect(graph.fileCount).toBe(3);
    expect(graph.rootPath).toBe('/repo');
    expect(graph.truncated).toBe(false);
    const ids = graph.nodes.map((n) => n.id).toSorted();
    expect(ids).toEqual(['README.md', 'src/a.ts', 'src/b.ts']);
    // label is the basename, group is the top-level folder (or extension at root)
    const a = graph.nodes.find((n) => n.id === 'src/a.ts');
    expect(a?.label).toBe('a.ts');
    expect(a?.group).toBe('src');
    const readme = graph.nodes.find((n) => n.id === 'README.md');
    expect(readme?.group).toBe('.md');
  });

  it('resolves a relative `./a` import to a.ts', () => {
    const graph = buildGraphFromFiles('/repo', [
      { relPath: 'src/index.ts', content: "import { a } from './a';" },
      { relPath: 'src/a.ts', content: 'export const a = 1;' },
    ]);

    expect(hasEdge(graph.edges, 'src/index.ts', 'src/a.ts')).toBe(true);
    expect(graph.edges).toHaveLength(1);
  });

  it('resolves a directory specifier `./dir` to ./dir/index.ts', () => {
    const graph = buildGraphFromFiles('/repo', [
      { relPath: 'src/main.ts', content: "import helpers from './dir';" },
      { relPath: 'src/dir/index.ts', content: 'export default {};' },
    ]);

    expect(hasEdge(graph.edges, 'src/main.ts', 'src/dir/index.ts')).toBe(true);
    expect(graph.edges).toHaveLength(1);
  });

  it('ignores bare/package imports (no edge to react)', () => {
    const graph = buildGraphFromFiles('/repo', [
      {
        relPath: 'src/app.ts',
        content: "import React from 'react';\nimport x from '@scope/x';\nimport { b } from './b';",
      },
      { relPath: 'src/b.ts', content: 'export const b = 2;' },
    ]);

    // No node and no edge for bare packages.
    expect(graph.nodes.some((n) => n.id === 'react')).toBe(false);
    expect(graph.edges.some((e) => e.to === 'react')).toBe(false);
    expect(graph.edges.some((e) => e.to === '@scope/x')).toBe(false);
    // The intra-repo edge is still captured.
    expect(hasEdge(graph.edges, 'src/app.ts', 'src/b.ts')).toBe(true);
    expect(graph.edges).toHaveLength(1);
  });

  it('handles require() and dynamic import()', () => {
    const graph = buildGraphFromFiles('/repo', [
      { relPath: 'src/cjs.ts', content: "const dep = require('./dep');" },
      { relPath: 'src/dep.ts', content: 'module.exports = {};' },
      { relPath: 'src/lazy.ts', content: "const load = () => import('./dep');" },
    ]);

    expect(hasEdge(graph.edges, 'src/cjs.ts', 'src/dep.ts')).toBe(true);
    expect(hasEdge(graph.edges, 'src/lazy.ts', 'src/dep.ts')).toBe(true);
  });

  it('dedupes repeated edges and drops self-edges', () => {
    const graph = buildGraphFromFiles('/repo', [
      {
        relPath: 'src/a.ts',
        // duplicate import of ./b, plus a self require of ./a
        content: "import { b } from './b';\nconst again = require('./b');\nconst me = require('./a');",
      },
      { relPath: 'src/b.ts', content: 'export const b = 1;' },
    ]);

    const aToB = graph.edges.filter((e) => e.from === 'src/a.ts' && e.to === 'src/b.ts');
    expect(aToB).toHaveLength(1);
    // self-edge removed
    expect(graph.edges.some((e) => e.from === e.to)).toBe(false);
  });

  it('keeps every provided file so retrieval can see the whole repo', () => {
    const many = Array.from({ length: 450 }, (_v, i) => ({ relPath: `src/f${i}.ts`, content: '' }));
    const graph = buildGraphFromFiles('/repo', many);

    expect(graph.truncated).toBe(false);
    expect(graph.nodes).toHaveLength(450);
    expect(graph.fileCount).toBe(450);
  });

  it('handles posix path resolution across nested directories', () => {
    const graph = buildGraphFromFiles('/repo', [
      {
        relPath: 'src/features/auth/login.ts',
        content: "import { token } from '../shared/token';\nimport { util } from '../../utils/util';",
      },
      { relPath: 'src/features/shared/token.ts', content: 'export const token = "";' },
      { relPath: 'src/utils/util.ts', content: 'export const util = 1;' },
    ]);

    expect(hasEdge(graph.edges, 'src/features/auth/login.ts', 'src/features/shared/token.ts')).toBe(true);
    expect(hasEdge(graph.edges, 'src/features/auth/login.ts', 'src/utils/util.ts')).toBe(true);
    expect(graph.edges).toHaveLength(2);
  });
});

describe('collectRepoFiles', () => {
  it('skips generated/cache folders and returns files in stable order', async () => {
    const dirs = new Map<string, Array<{ name: string; fullPath: string; isDir: boolean }>>([
      [
        '/repo',
        [
          { name: 'z.ts', fullPath: '/repo/z.ts', isDir: false },
          { name: '.aionui', fullPath: '/repo/.aionui', isDir: true },
          { name: 'src', fullPath: '/repo/src', isDir: true },
          { name: 'target', fullPath: '/repo/target', isDir: true },
          { name: '.mtui', fullPath: '/repo/.mtui', isDir: true },
        ],
      ],
      [
        '/repo/src',
        [
          { name: 'b.ts', fullPath: '/repo/src/b.ts', isDir: false },
          { name: 'a.ts', fullPath: '/repo/src/a.ts', isDir: false },
          { name: '.turbo', fullPath: '/repo/src/.turbo', isDir: true },
        ],
      ],
      ['/repo/.aionui', [{ name: 'ignored.ts', fullPath: '/repo/.aionui/ignored.ts', isDir: false }]],
      ['/repo/.mtui', [{ name: 'ignored.ts', fullPath: '/repo/.mtui/ignored.ts', isDir: false }]],
      ['/repo/target', [{ name: 'ignored.ts', fullPath: '/repo/target/ignored.ts', isDir: false }]],
      ['/repo/src/.turbo', [{ name: 'ignored.ts', fullPath: '/repo/src/.turbo/ignored.ts', isDir: false }]],
    ]);

    const files = await collectRepoFiles('/repo', {
      listDir: async (dir) => dirs.get(dir) ?? [],
      readFile: async (filePath) => `// ${filePath}`,
      toRel: (full) => full.replace('/repo/', ''),
    });

    expect(files.map((file) => file.relPath)).toEqual(['z.ts', 'src/a.ts', 'src/b.ts']);
  });

  it('unwraps a duplicated single parent folder before collecting files', async () => {
    const dirs = new Map<string, Array<{ name: string; fullPath: string; isDir: boolean }>>([
      [
        '/repo/AI_Education-main',
        [{ name: 'AI_Education-main', fullPath: '/repo/AI_Education-main/AI_Education-main', isDir: true }],
      ],
      [
        '/repo/AI_Education-main/AI_Education-main',
        [{ name: 'frontend', fullPath: '/repo/AI_Education-main/AI_Education-main/frontend', isDir: true }],
      ],
      [
        '/repo/AI_Education-main/AI_Education-main/frontend',
        [{ name: 'lib', fullPath: '/repo/AI_Education-main/AI_Education-main/frontend/lib', isDir: true }],
      ],
      [
        '/repo/AI_Education-main/AI_Education-main/frontend/lib',
        [
          {
            name: 'client.ts',
            fullPath: '/repo/AI_Education-main/AI_Education-main/frontend/lib/client.ts',
            isDir: false,
          },
        ],
      ],
    ]);

    const files = await collectRepoFiles('/repo/AI_Education-main', {
      listDir: async (dir) => dirs.get(dir) ?? [],
      readFile: async (filePath) => `// ${filePath}`,
      toRel: (full) => full.replace('/repo/AI_Education-main/', ''),
    });

    expect(files).toEqual([
      {
        relPath: 'frontend/lib/client.ts',
        content: '// /repo/AI_Education-main/AI_Education-main/frontend/lib/client.ts',
      },
    ]);
  });

  it('reads selected non-code text files when collecting repository metadata', async () => {
    const files = await collectRepoFiles(
      '/repo',
      {
        listDir: async () => [
          { name: 'README.md', fullPath: '/repo/README.md', isDir: false },
          { name: 'logo.png', fullPath: '/repo/logo.png', isDir: false },
        ],
        readFile: async (filePath) => `content:${filePath}`,
        toRel: (full) => full.replace('/repo/', ''),
      },
      { codeOnly: false, readContent: (relPath) => relPath.endsWith('.md') }
    );

    expect(files).toEqual([
      { relPath: 'logo.png', content: '' },
      { relPath: 'README.md', content: 'content:/repo/README.md' },
    ]);
  });
});
