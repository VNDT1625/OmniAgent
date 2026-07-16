/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the renderer-side pure graph derivations: C4-level projection
 * (Context / Container / Component / Code) and diff-impact traversal. No React,
 * no IPC — these are pure functions of their inputs.
 */

import { describe, expect, it } from 'vitest';
import { computeImpact, deriveC4, liftChangedToView } from '@/renderer/pages/studio/ide/graphModel';
import type { KnowledgeGraph } from '@/process/ide/understandTypes';

/** A small but representative graph spanning two top folders + externals. */
const graph: KnowledgeGraph = {
  rootPath: '/repo',
  version: 2,
  builtAt: 1,
  nodes: [
    {
      id: 'src/api/users.ts',
      label: 'users.ts',
      group: 'src',
      layer: 'api',
      summary: 'API',
      summarySource: 'llm',
      tags: [],
      symbols: [],
      language: 'typescript',
      importedBy: 0,
      fingerprint: 'a',
    },
    {
      id: 'src/service/userService.ts',
      label: 'userService.ts',
      group: 'src',
      layer: 'service',
      summary: 'Svc',
      summarySource: 'llm',
      tags: [],
      symbols: [],
      language: 'typescript',
      importedBy: 1,
      fingerprint: 'b',
    },
    {
      id: 'src/data/userRepo.ts',
      label: 'userRepo.ts',
      group: 'src',
      layer: 'data',
      summary: 'Repo',
      summarySource: 'llm',
      tags: [],
      symbols: [],
      language: 'typescript',
      importedBy: 1,
      fingerprint: 'c',
    },
    {
      id: 'lib/util/log.ts',
      label: 'log.ts',
      group: 'lib',
      layer: 'util',
      summary: 'Log',
      summarySource: 'fallback',
      tags: [],
      symbols: [],
      language: 'typescript',
      importedBy: 2,
      fingerprint: 'd',
    },
  ],
  edges: [
    { from: 'src/api/users.ts', to: 'src/service/userService.ts' },
    { from: 'src/service/userService.ts', to: 'src/data/userRepo.ts' },
    { from: 'src/service/userService.ts', to: 'lib/util/log.ts' },
    { from: 'src/data/userRepo.ts', to: 'lib/util/log.ts' },
  ],
  tours: [],
  modules: [
    { id: 'src/api', label: 'api', layer: 'api', summary: '', fileCount: 1, files: ['src/api/users.ts'] },
    {
      id: 'src/service',
      label: 'service',
      layer: 'service',
      summary: '',
      fileCount: 1,
      files: ['src/service/userService.ts'],
    },
    { id: 'src/data', label: 'data', layer: 'data', summary: '', fileCount: 1, files: ['src/data/userRepo.ts'] },
    { id: 'lib/util', label: 'util', layer: 'util', summary: '', fileCount: 1, files: ['lib/util/log.ts'] },
  ],
  moduleEdges: [
    { from: 'src/api', to: 'src/service', weight: 1 },
    { from: 'src/service', to: 'src/data', weight: 1 },
    { from: 'src/service', to: 'lib/util', weight: 1 },
    { from: 'src/data', to: 'lib/util', weight: 1 },
  ],
  externals: [
    { name: 'react', usedBy: 3 },
    { name: 'zod', usedBy: 1 },
  ],
  truncated: false,
  fileCount: 4,
};

describe('deriveC4', () => {
  it('code level → one node per file', () => {
    const view = deriveC4(graph, 'code');
    expect(view.level).toBe('code');
    expect(view.nodes).toHaveLength(4);
    expect(view.edges).toHaveLength(4);
    expect(view.nodes.every((n) => n.kind === 'file')).toBe(true);
  });

  it('component level → one node per module (reuses builder modules)', () => {
    const view = deriveC4(graph, 'component');
    expect(view.nodes).toHaveLength(4);
    expect(view.nodes.every((n) => n.kind === 'module')).toBe(true);
    expect(view.nodes.map((n) => n.id)).toContain('src/service');
  });

  it('container level → one node per top-level folder, weighted edges', () => {
    const view = deriveC4(graph, 'container');
    const ids = view.nodes.map((n) => n.id).toSorted();
    expect(ids).toEqual(['lib', 'src']);
    expect(view.nodes.every((n) => n.kind === 'container')).toBe(true);
    // src → lib aggregates the service→log + data→log file edges (weight 2).
    const srcToLib = view.edges.find((e) => e.from === 'src' && e.to === 'lib');
    expect(srcToLib?.weight).toBe(2);
  });

  it('context level → user actor + system + externals', () => {
    const view = deriveC4(graph, 'context');
    const kinds = new Set(view.nodes.map((n) => n.kind));
    expect(kinds.has('actor')).toBe(true);
    expect(kinds.has('system')).toBe(true);
    expect(kinds.has('external')).toBe(true);
    expect(view.nodes.filter((n) => n.kind === 'external').map((n) => n.label)).toContain('react');
    // The system node carries every file so selecting it still maps to code.
    const system = view.nodes.find((n) => n.kind === 'system');
    expect(system?.files).toHaveLength(4);
  });
});

describe('computeImpact', () => {
  it('marks changed files + their transitive dependents', () => {
    // log.ts changed → everything that (in)directly imports it is impacted.
    const result = computeImpact(graph.edges, ['lib/util/log.ts']);
    expect(result.changed).toEqual(['lib/util/log.ts']);
    expect(new Set(result.impacted)).toEqual(
      new Set(['src/service/userService.ts', 'src/data/userRepo.ts', 'src/api/users.ts'])
    );
  });

  it('a leaf change with no dependents impacts nothing', () => {
    const result = computeImpact(graph.edges, ['src/api/users.ts']);
    expect(result.impacted).toEqual([]);
  });

  it('is cycle-safe', () => {
    const cyclic = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    const result = computeImpact(cyclic, ['a']);
    expect(result.impacted).toEqual(['b']);
  });
});

describe('liftChangedToView', () => {
  it('lifts a changed file id up to its module node id', () => {
    const view = deriveC4(graph, 'component');
    const lifted = liftChangedToView(view, ['src/service/userService.ts']);
    expect(lifted.has('src/service')).toBe(true);
    expect(lifted.has('src/api')).toBe(false);
  });
});
