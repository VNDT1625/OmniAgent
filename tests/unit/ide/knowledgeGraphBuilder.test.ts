/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the "Understand Anything" knowledge-graph builder. Every case
 * injects fake `chat` + `collectFiles` deps, so the deterministic structural
 * pass and the semantic LLM pass are exercised in-memory — no network, no fs,
 * no wasm/tree-sitter.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  aggregateModules,
  createKnowledgeGraphBuilder,
  extractSymbols,
  fallbackSummary,
  fingerprintOf,
  inferLayer,
  parseSummaryBatch,
  resolveEffectiveSummaryConcurrency,
  type KnowledgeGraphBuilderDeps,
  resolveSummaryBatchSize,
  resolveSummaryConcurrency,
} from '@/process/ide/knowledgeGraphBuilder';
import { assessGraphFreshness } from '@/process/ide/graphFreshness';
import type { KnowledgeBuildPhase, KnowledgeEdge, KnowledgeGraph, KnowledgeNode } from '@/process/ide/understandTypes';

/** A fake `chat` that always returns the same canned reply. */
const constantChat = (reply: string): KnowledgeGraphBuilderDeps['chat'] => vi.fn(async () => reply);

/** A fake `collectFiles` returning a fixed file set. */
const filesFrom = (files: Array<{ relPath: string; content: string }>): KnowledgeGraphBuilderDeps['collectFiles'] =>
  vi.fn(async () => files);

const folderReply = (
  id: string,
  fileSummaries: Array<{ path: string; summary: string; tags?: string[]; layer?: string }>,
  summary = `${id} folder summary.`
): string =>
  JSON.stringify([
    {
      id,
      summary,
      fileSummaries: fileSummaries.map((entry) => ({ tags: [], ...entry })),
    },
  ]);

describe('extractSymbols', () => {
  it('finds a function, class, interface, and exported const in a TS snippet', () => {
    const content = [
      'export interface Config {',
      '  name: string;',
      '}',
      '',
      'export function loadConfig(): Config {',
      '  return { name: readName() };',
      '}',
      '',
      'class ConfigStore {',
      '  read() { return null; }',
      '}',
      '',
      'function readName() { return "x"; }',
      '',
      'export const DEFAULT_NAME = "aion";',
      '',
    ].join('\n');

    const symbols = extractSymbols(content, 'typescript');
    const byKind = (kind: string): string[] => symbols.filter((s) => s.kind === kind).map((s) => s.name);

    expect(byKind('interface')).toContain('Config');
    expect(byKind('function')).toContain('loadConfig');
    expect(byKind('class')).toContain('ConfigStore');
    expect(byKind('constant')).toContain('DEFAULT_NAME');
    expect(byKind('method')).toContain('read');
    expect(symbols.find((s) => s.name === 'loadConfig')?.endLine).toBeGreaterThan(5);
    expect(symbols.find((s) => s.name === 'loadConfig')?.calls).toContain('readName');
    // Line numbers are 1-based and ordered.
    expect(symbols[0].line).toBe(1);
    expect(symbols.every((s, i) => i === 0 || s.line >= symbols[i - 1].line)).toBe(true);
  });

  it('extracts polyglot symbols (Python def/class)', () => {
    const symbols = extractSymbols('class Foo:\n  pass\n\ndef bar():\n  return 1\n', 'python');
    expect(symbols.some((s) => s.kind === 'class' && s.name === 'Foo')).toBe(true);
    expect(symbols.some((s) => s.kind === 'function' && s.name === 'bar')).toBe(true);
  });

  it('extracts polyglot symbols (Rust fn/struct, Go func/type)', () => {
    const rust = extractSymbols('pub struct Server {}\npub fn start() {}\n', 'rust');
    expect(rust.some((s) => s.kind === 'class' && s.name === 'Server')).toBe(true);
    expect(rust.some((s) => s.kind === 'function' && s.name === 'start')).toBe(true);
    const go = extractSymbols('type Handler struct {}\nfunc Serve() {}\n', 'go');
    expect(go.some((s) => s.kind === 'class' && s.name === 'Handler')).toBe(true);
    expect(go.some((s) => s.kind === 'function' && s.name === 'Serve')).toBe(true);
  });

  it('returns no symbols for an unsupported language', () => {
    expect(extractSymbols('body { color: red; }', 'css')).toEqual([]);
  });
});

describe('inferLayer', () => {
  it('maps representative paths to layers', () => {
    expect(inferLayer('src/api/users.ts')).toBe('api');
    expect(inferLayer('src/services/orderService.ts')).toBe('service');
    expect(inferLayer('src/db/userRepository.ts')).toBe('data');
    expect(inferLayer('src/components/Button.tsx')).toBe('ui');
    expect(inferLayer('packages/desktop/src/process/ide/knowledgeGraphBuilder.ts')).toBe('service');
    expect(inferLayer('packages/desktop/src/process/bridge/applicationBridge.ts')).toBe('api');
    expect(inferLayer('packages/desktop/src/renderer/pages/browser/BrowserPage.tsx')).toBe('ui');
    expect(inferLayer('packages/desktop/src/common/config/constants.ts')).toBe('config');
    expect(inferLayer('src/utils/format.ts')).toBe('util');
    expect(inferLayer('vite.config.ts')).toBe('config');
    expect(inferLayer('tests/unit/foo.test.ts')).toBe('test');
    expect(inferLayer('src/random.ts')).toBe('unknown');
  });
});

describe('resolveSummaryConcurrency', () => {
  it('uses explicit options, env override, then model heuristics', () => {
    const previous = process.env.AIONUI_UNDERSTAND_SUMMARY_CONCURRENCY;
    try {
      expect(resolveSummaryConcurrency('claude-opus', 6)).toBe(6);
      expect(resolveSummaryConcurrency('claude-opus', 99)).toBe(12);
      process.env.AIONUI_UNDERSTAND_SUMMARY_CONCURRENCY = '9';
      expect(resolveSummaryConcurrency('claude-opus')).toBe(9);
      delete process.env.AIONUI_UNDERSTAND_SUMMARY_CONCURRENCY;
      expect(resolveSummaryConcurrency('claude-opus')).toBe(3);
      expect(resolveSummaryConcurrency('gemini-flash')).toBe(6);
      expect(resolveSummaryConcurrency('gpt-5')).toBe(4);
    } finally {
      if (previous === undefined) {
        delete process.env.AIONUI_UNDERSTAND_SUMMARY_CONCURRENCY;
      } else {
        process.env.AIONUI_UNDERSTAND_SUMMARY_CONCURRENCY = previous;
      }
    }
  });
});

describe('resolveEffectiveSummaryConcurrency', () => {
  it('scales worker count to batch count instead of always using the model limit', () => {
    expect(resolveEffectiveSummaryConcurrency(0, 4)).toBe(0);
    expect(resolveEffectiveSummaryConcurrency(1, 4)).toBe(1);
    expect(resolveEffectiveSummaryConcurrency(2, 4)).toBe(1);
    expect(resolveEffectiveSummaryConcurrency(5, 4)).toBe(2);
    expect(resolveEffectiveSummaryConcurrency(9, 4)).toBe(3);
    expect(resolveEffectiveSummaryConcurrency(20, 4)).toBe(4);
  });
});

describe('resolveSummaryBatchSize', () => {
  it('uses explicit options, env override, and a larger production default', () => {
    const previous = process.env.AIONUI_UNDERSTAND_SUMMARY_BATCH_SIZE;
    try {
      expect(resolveSummaryBatchSize(7)).toBe(7);
      expect(resolveSummaryBatchSize(99)).toBe(24);
      process.env.AIONUI_UNDERSTAND_SUMMARY_BATCH_SIZE = '16';
      expect(resolveSummaryBatchSize()).toBe(16);
      delete process.env.AIONUI_UNDERSTAND_SUMMARY_BATCH_SIZE;
      expect(resolveSummaryBatchSize()).toBe(12);
    } finally {
      if (previous === undefined) {
        delete process.env.AIONUI_UNDERSTAND_SUMMARY_BATCH_SIZE;
      } else {
        process.env.AIONUI_UNDERSTAND_SUMMARY_BATCH_SIZE = previous;
      }
    }
  });
});

describe('aggregateModules', () => {
  const node = (id: string, importedBy = 0): KnowledgeNode => ({
    id,
    label: id.split('/').pop() ?? id,
    group: id.split('/').slice(0, -1).join('/') || '(root)',
    path: id,
    summary: `Summary for ${id}`,
    tags: [],
    symbols: [],
    language: 'typescript',
    size: 10,
    importedBy,
    layer: inferLayer(id),
    fingerprint: `${id}:fingerprint`,
    summarySource: 'fallback',
  });

  it('adds folder entry files and module relationships', () => {
    const nodes = [
      node('src/core/index.ts'),
      node('src/core/service.ts', 1),
      node('src/ui/Button.tsx', 1),
      node('src/ui/hooks/useTheme.ts'),
    ];
    const edges: KnowledgeEdge[] = [
      { from: 'src/core/service.ts', to: 'src/ui/Button.tsx', kind: 'import', weight: 1 },
    ];

    const graph = aggregateModules(nodes, edges);
    const byId = new Map(graph.modules.map((mod) => [mod.id, mod]));
    const core = byId.get('src/core');
    const ui = byId.get('src/ui');

    expect(core?.entryFiles).toContain('src/core/index.ts');
    expect(core?.relatedModuleIds).toContain('src/ui');
    expect(ui?.relatedModuleIds).toContain('src/core');
    expect(graph.moduleEdges).toEqual([{ from: 'src/core', to: 'src/ui', weight: 1 }]);
  });

  it('keeps large repo module maps legible instead of maximizing depth indefinitely', () => {
    const nodes = Array.from({ length: 180 }, (_value, index) =>
      node(`packages/pkg${index}/src/features/feature${index}/index.ts`)
    );

    const graph = aggregateModules(nodes, []);

    expect(graph.modules.length).toBeLessThanOrEqual(96);
    expect(graph.modules.some((mod) => mod.id === 'packages')).toBe(true);
  });

  it('preserves high-signal responsibility folders in a large repo instead of collapsing everything to src', () => {
    const important = [
      node('packages/desktop/src/process/ide/knowledgeGraphBuilder.ts', 8),
      node('packages/desktop/src/process/ide/contextBuilder.ts', 4),
      node('packages/desktop/src/process/ide/graphFreshness.ts', 2),
      node('packages/desktop/src/renderer/pages/browser/BrowserPage.tsx', 3),
      node('packages/desktop/src/process/browser/browserBridge.ts', 3),
    ];
    const noisy = Array.from({ length: 180 }, (_value, index) =>
      node(`packages/pkg${index}/src/features/feature${index}/index.ts`)
    );

    const graph = aggregateModules([...important, ...noisy], []);
    const ids = graph.modules.map((mod) => mod.id);

    expect(graph.modules.length).toBeLessThanOrEqual(96);
    expect(ids).toContain('packages/desktop/src/process/ide');
    expect(ids).toContain('packages/desktop/src/renderer/pages/browser');
    expect(ids).not.toContain('packages/desktop/src');
  });
});

describe('parseSummaryBatch', () => {
  it('tolerates fenced JSON and surrounding garbage (defensive)', () => {
    const reply = [
      'Sure! Here is the analysis:',
      '```json',
      '[',
      '  { "path": "a.ts", "summary": "Entry point.", "tags": ["entry", "boot"], "layer": "service" }',
      ']',
      '```',
      'Hope that helps.',
    ].join('\n');

    const parsed = parseSummaryBatch(reply);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].summary).toBe('Entry point.');
    expect(parsed[0].tags).toEqual(['entry', 'boot']);
    expect(parsed[0].layer).toBe('service');
  });

  it('returns [] on unparseable / non-array output', () => {
    expect(parseSummaryBatch('no json here at all')).toEqual([]);
    expect(parseSummaryBatch('{ "not": "an array" }')).toEqual([]);
    expect(parseSummaryBatch('[ {bad json ')).toEqual([]);
  });

  it('drops an invalid layer but keeps the summary', () => {
    const parsed = parseSummaryBatch('[{ "path": "a.ts", "summary": "S", "tags": [], "layer": "bogus" }]');
    expect(parsed[0].summary).toBe('S');
    expect(parsed[0].layer).toBeUndefined();
  });
});

describe('createKnowledgeGraphBuilder.build', () => {
  const sampleFiles = [
    { relPath: 'src/index.ts', content: "import { run } from './service';\nrun();\n" },
    {
      relPath: 'src/service.ts',
      content: "import { read } from './data';\nexport function run() { return read(); }\n",
    },
    { relPath: 'src/data.ts', content: 'export function read() { return 42; }\n' },
  ];

  it('emits phases in order (scanning → parsing → summarizing → modules → overview → done)', async () => {
    const phases: KnowledgeBuildPhase[] = [];
    const builder = createKnowledgeGraphBuilder({
      chat: constantChat('[]'),
      collectFiles: filesFrom(sampleFiles),
      now: () => 1000,
    });

    await builder.build('/repo', 'gpt', undefined, { onPhase: (phase) => phases.push(phase) });

    // De-duplicate consecutive repeats (summarizing emits progress sub-updates).
    const ordered = phases.filter((p, i) => i === 0 || p !== phases[i - 1]);
    expect(ordered).toEqual(['scanning', 'parsing', 'summarizing', 'modules', 'overview', 'done']);
  });

  it('produces one node per file with importedBy computed from edges', async () => {
    const builder = createKnowledgeGraphBuilder({
      chat: constantChat('[]'),
      collectFiles: filesFrom(sampleFiles),
      now: () => 1000,
    });

    const graph = await builder.build('/repo', 'gpt');

    expect(graph.nodes).toHaveLength(3);
    expect(graph.fileCount).toBe(3);
    expect(graph.builtAt).toBe(1000);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    // data.ts is imported by service.ts; service.ts by index.ts; index.ts by none.
    expect(byId.get('src/data.ts')?.importedBy).toBe(1);
    expect(byId.get('src/service.ts')?.importedBy).toBe(1);
    expect(byId.get('src/index.ts')?.importedBy).toBe(0);
    // Structural symbols were extracted deterministically.
    expect(byId.get('src/data.ts')?.symbols.some((s) => s.name === 'read')).toBe(true);
  });

  it('applies parsed summaries from the fake chat (semantic pass)', async () => {
    const reply = folderReply('src', [
      { path: 'src/index.ts', summary: 'Bootstraps the app.', tags: ['entry'], layer: 'service' },
      { path: 'src/service.ts', summary: 'Core run logic.', tags: ['logic'], layer: 'service' },
      { path: 'src/data.ts', summary: 'Reads raw data.', tags: ['io'], layer: 'data' },
    ]);
    const builder = createKnowledgeGraphBuilder({
      chat: constantChat(reply),
      collectFiles: filesFrom(sampleFiles),
      now: () => 1,
    });

    const graph = await builder.build('/repo', 'gpt');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    expect(byId.get('src/index.ts')?.summary).toBe('Bootstraps the app.');
    expect(byId.get('src/data.ts')?.summary).toBe('Reads raw data.');
    expect(byId.get('src/data.ts')?.tags).toEqual(['io']);
    expect(byId.get('src/data.ts')?.layer).toBe('data');
  });

  it('does not spend a model call on guided tours', async () => {
    const chat = vi.fn(async (_model: string, _system: string) => {
      return '[]';
    });
    const builder = createKnowledgeGraphBuilder({ chat, collectFiles: filesFrom(sampleFiles), now: () => 1 });

    const graph = await builder.build('/repo', 'gpt');
    expect(graph.tours).toEqual([]);
    expect(chat.mock.calls.some((call) => String(call[1]).includes('guided tours'))).toBe(false);
  });

  it('stores semantic module summaries instead of copying a file summary', async () => {
    const chat = vi.fn(async (_model: string, system: string) => {
      if (system.includes('codebase folders')) {
        return JSON.stringify([{ id: 'src', summary: 'The src folder coordinates the app entry and data flow.' }]);
      }
      return JSON.stringify([{ path: 'src/index.ts', summary: 'Bootstraps the app.', tags: [], layer: 'service' }]);
    });
    const builder = createKnowledgeGraphBuilder({ chat, collectFiles: filesFrom(sampleFiles), now: () => 1 });

    const graph = await builder.build('/repo', 'gpt');

    expect(graph.modules?.find((mod) => mod.id === 'src')?.summary).toBe(
      'The src folder coordinates the app entry and data flow.'
    );
  });

  it('returns a partial graph when aborted (no throw)', async () => {
    const controller = new AbortController();
    // Abort as soon as the parsing phase begins, before the semantic passes.
    const onPhase = (phase: KnowledgeBuildPhase): void => {
      if (phase === 'parsing') {
        controller.abort();
      }
    };
    const chat = vi.fn(async () => '[]');
    const builder = createKnowledgeGraphBuilder({ chat, collectFiles: filesFrom(sampleFiles), now: () => 1 });

    const graph = await builder.build('/repo', 'gpt', undefined, { onPhase, signal: controller.signal });

    // Structural nodes are present, but the semantic passes were skipped.
    expect(graph.nodes).toHaveLength(3);
    expect(graph.tours).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('keeps lightweight nodes for a large repo while capping semantic summaries', async () => {
    const many = Array.from({ length: 450 }, (_v, i) => ({
      relPath: `src/file${i}.ts`,
      content: `export const v${i} = ${i};\n`,
    }));
    const chat = vi.fn(async () => '[]');
    const builder = createKnowledgeGraphBuilder({
      chat,
      collectFiles: filesFrom(many),
      now: () => 1,
    });

    const graph = await builder.build('/repo', 'gpt', { summaryCap: 4 });

    expect(graph.nodes).toHaveLength(450);
    expect(graph.truncated).toBe(false);
    const summaryCalls = chat.mock.calls.filter((call) => String(call[1]).includes('codebase folders'));
    expect(summaryCalls).toHaveLength(1);
    const summaryPrompt = String(summaryCalls[0]?.[2] ?? '');
    expect(summaryPrompt).toContain('src/file0.ts');
    expect((summaryPrompt.match(/path: src\/file/g) ?? []).length).toBe(4);
    expect(summaryPrompt).not.toContain('src/file4.ts');
  });

  it('summarizes module batches concurrently to speed up large builds', async () => {
    const files = Array.from({ length: 9 }, (_v, i) => ({
      relPath: `packages/pkg${i}/src/feature${i}/index.ts`,
      content: `export const feature${i} = ${i};\n`,
    }));
    let active = 0;
    let maxActive = 0;
    const chat = vi.fn(async (_model: string, system: string) => {
      if (system.includes('codebase folders')) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return '[]';
      }
      return '{}';
    });
    const builder = createKnowledgeGraphBuilder({
      chat,
      collectFiles: filesFrom(files),
      now: () => 1,
    });

    await builder.build('/repo', 'gpt', { summaryCap: 99, batchSize: 1, summaryConcurrency: 3 });

    expect(maxActive).toBe(3);
  });

  it('uses fewer summary workers for small rebuilds even when the model allows more', async () => {
    const files = Array.from({ length: 5 }, (_v, i) => ({
      relPath: `packages/pkg${i}/src/feature${i}/index.ts`,
      content: `export const feature${i} = ${i};\n`,
    }));
    let active = 0;
    let maxActive = 0;
    const chat = vi.fn(async (_model: string, system: string) => {
      if (system.includes('codebase folders')) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return '[]';
      }
      return '{}';
    });
    const builder = createKnowledgeGraphBuilder({
      chat,
      collectFiles: filesFrom(files),
      now: () => 1,
    });

    await builder.build('/repo', 'gpt', { summaryCap: 99, batchSize: 1, summaryConcurrency: 4 });

    expect(maxActive).toBe(2);
  });

  it('fails fast and reports the CLI problem when a summary batch fails', async () => {
    const events: Array<{ phase: KnowledgeBuildPhase; detail?: string }> = [];
    const chat = vi.fn(async (_model: string, system: string) => {
      if (system.includes('codebase folders')) {
        throw new Error('cli unavailable');
      }
      return '{}';
    });
    const builder = createKnowledgeGraphBuilder({
      chat,
      collectFiles: filesFrom(sampleFiles),
      now: () => 1,
    });

    await expect(
      builder.build('/repo', 'gpt', undefined, {
        onPhase: (phase, detail) => {
          events.push({ phase, detail });
        },
      })
    ).rejects.toThrow('Summary CLI failed for src');

    expect(events).toContainEqual({
      phase: 'error',
      detail: 'Summary CLI failed for src: cli unavailable',
    });
  });

  it('keeps deterministic fallback for malformed summary output that is not a CLI failure', async () => {
    const chat = vi.fn(async (_model: string, system: string) => {
      if (system.includes('codebase folders')) {
        return 'not json';
      }
      return '{}';
    });
    const builder = createKnowledgeGraphBuilder({
      chat,
      collectFiles: filesFrom(sampleFiles),
      now: () => 1,
    });

    const graph = await builder.build('/repo', 'gpt');

    expect(graph.nodes.every((node) => node.summarySource === 'fallback')).toBe(true);
  });

  it('spends folder-first summary budget on high-relationship modules with a hard context cap', async () => {
    const files = [
      { relPath: 'src/core/hub.ts', content: "import '../shared/a';\nexport const hub = 1;" },
      { relPath: 'src/core/worker.ts', content: 'export const worker = 1;' },
      { relPath: 'src/browser/BrowserPage.tsx', content: 'export const BrowserPage = () => null;' },
      { relPath: 'src/contentExtract/ytDlpTranscript.ts', content: 'export const transcript = () => null;' },
      { relPath: 'src/music/engine.ts', content: 'export const engine = () => null;' },
    ];
    const chat = vi.fn(async () => '[]');
    const builder = createKnowledgeGraphBuilder({
      chat,
      collectFiles: filesFrom(files),
      now: () => 1,
    });

    await builder.build('/repo', 'gpt', { summaryCap: 4 });

    const summaryCall = chat.mock.calls.find((call) => String(call[1]).includes('codebase folders'));
    const summaryPrompt = String(summaryCall?.[2] ?? '');
    expect(summaryPrompt).toContain('id: src/core');
    expect(summaryPrompt).toContain('src/core/hub.ts');
    expect((summaryPrompt.match(/path: src\//g) ?? []).length).toBeLessThanOrEqual(4);
  });

  it('prioritizes source modules over test-only modules when semantic budget is tight', async () => {
    const files = [
      { relPath: 'src/core/index.ts', content: 'export const start = () => null;' },
      { relPath: 'src/core/service.ts', content: 'export const service = () => null;' },
      { relPath: 'tests/unit/core/service.test.ts', content: 'test("service", () => {});' },
      { relPath: 'tests/unit/core/index.test.ts', content: 'test("index", () => {});' },
    ];
    const chat = vi.fn(async () => '[]');
    const builder = createKnowledgeGraphBuilder({
      chat,
      collectFiles: filesFrom(files),
      now: () => 1,
    });

    await builder.build('/repo', 'gpt', { summaryCap: 2 });

    const summaryCall = chat.mock.calls.find((call) => String(call[1]).includes('codebase folders'));
    const summaryPrompt = String(summaryCall?.[2] ?? '');
    expect(summaryPrompt).toContain('id: src/core');
    expect(summaryPrompt).not.toContain('id: tests/unit/core');
  });
});

describe('fingerprintOf', () => {
  it('is stable for identical content and differs for changed content', () => {
    expect(fingerprintOf('hello world')).toBe(fingerprintOf('hello world'));
    expect(fingerprintOf('hello world')).not.toBe(fingerprintOf('hello worle'));
    expect(fingerprintOf('')).toBe(fingerprintOf(''));
  });
});

describe('fallbackSummary', () => {
  it('produces a readable sentence from name + layer + symbols', () => {
    const summary = fallbackSummary({
      label: 'userService.ts',
      layer: 'service',
      language: 'typescript',
      importedBy: 3,
      symbols: [{ name: 'getUser', kind: 'function', line: 1 }],
    });
    expect(summary).toContain('userService.ts');
    expect(summary).toContain('business logic');
    expect(summary).toContain('getUser');
    expect(summary).toContain('imported by 3');
  });

  it('localizes the fallback to the requested display language', () => {
    const viSummary = fallbackSummary(
      {
        label: 'userService.ts',
        layer: 'service',
        language: 'typescript',
        importedBy: 2,
        symbols: [{ name: 'getUser', kind: 'function', line: 1 }],
      },
      'vi-VN'
    );
    expect(viSummary).toContain('userService.ts');
    expect(viSummary).toContain('getUser');
    expect(viSummary).toContain('nghiệp vụ');
    expect(vi).not.toContain('business logic');
  });
});

describe('build — fallback summary + externals', () => {
  const sampleFiles = [
    { relPath: 'src/index.ts', content: "import { run } from './service';\nimport React from 'react';\nrun();\n" },
    {
      relPath: 'src/service.ts',
      content: "import { read } from './data';\nimport { z } from 'zod';\nexport function run() { return read(); }\n",
    },
    { relPath: 'src/data.ts', content: 'export function read() { return 42; }\n' },
  ];

  it('fills every node with a summary (LLM where available, else fallback)', async () => {
    // chat returns a summary ONLY for index.ts; the rest must fall back.
    const reply = folderReply('src', [
      { path: 'src/index.ts', summary: 'The entry point.', tags: ['entry'], layer: 'service' },
    ]);
    const builder = createKnowledgeGraphBuilder({
      chat: constantChat(reply),
      collectFiles: filesFrom(sampleFiles),
      now: () => 1,
    });
    const graph = await builder.build('/repo', 'gpt');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    expect(byId.get('src/index.ts')?.summary).toBe('The entry point.');
    expect(byId.get('src/index.ts')?.summarySource).toBe('llm');
    // data.ts had no LLM summary → deterministic fallback, never empty.
    expect(byId.get('src/data.ts')?.summary.length).toBeGreaterThan(0);
    expect(byId.get('src/data.ts')?.summarySource).toBe('fallback');
    // Every node carries a fingerprint for incremental rebuilds.
    expect(graph.nodes.every((n) => typeof n.fingerprint === 'string' && n.fingerprint.length > 0)).toBe(true);
  });

  it('extracts external packages ranked by usage', async () => {
    const builder = createKnowledgeGraphBuilder({
      chat: constantChat('[]'),
      collectFiles: filesFrom(sampleFiles),
      now: () => 1,
    });
    const graph = await builder.build('/repo', 'gpt');
    const names = (graph.externals ?? []).map((e) => e.name);
    expect(names).toContain('react');
    expect(names).toContain('zod');
  });

  it('detects run commands and stores Mermaid diagrams', async () => {
    const files = [
      {
        relPath: 'package.json',
        content: JSON.stringify({ scripts: { start: 'bun start', test: 'vitest' }, packageManager: 'bun@1.2.0' }),
      },
      { relPath: 'src/server.ts', content: 'const port = process.env.PORT || 5173;\nserver.listen(port);\n' },
    ];
    const builder = createKnowledgeGraphBuilder({
      chat: constantChat('[]'),
      collectFiles: filesFrom(files),
      now: () => 1,
    });

    const graph = await builder.build('/repo', 'gpt');

    expect(graph.runbook?.packageManager).toBe('bun');
    expect(graph.runbook?.commands.map((command) => command.command)).toContain('bun start');
    expect(graph.runbook?.env).toContain('PORT');
    expect(graph.runbook?.ports).toContain(5173);
    expect(graph.diagrams?.map((diagram) => diagram.id)).toEqual(['c4-context', 'module-flow', 'runbook-flow']);
    expect(graph.diagrams?.[0]?.mermaid).toContain('C4Context');
  });
});

describe('build — incremental reuse', () => {
  const files = [
    { relPath: 'src/a.ts', content: "import { b } from './b';\nexport const a = b;\n" },
    { relPath: 'src/b.ts', content: 'export const b = 1;\n' },
  ];

  it('reuses an LLM summary for an unchanged file and re-summarizes a changed one', async () => {
    const first = folderReply('src', [
      { path: 'src/a.ts', summary: 'A first.', tags: [], layer: 'util' },
      { path: 'src/b.ts', summary: 'B first.', tags: [], layer: 'data' },
    ]);
    const builder1 = createKnowledgeGraphBuilder({
      chat: constantChat(first),
      collectFiles: filesFrom(files),
      now: () => 1,
    });
    const previous = await builder1.build('/repo', 'gpt');

    // Second run: a.ts unchanged, b.ts changed content. chat should only be
    // asked about b.ts now; a.ts must keep its prior summary verbatim.
    const changedFiles = [files[0], { relPath: 'src/b.ts', content: 'export const b = 999;\n' }];
    const chat = vi.fn(async (_m: string, system: string, user: string) => {
      if (system.includes('codebase folders') && user.includes('src/b.ts')) {
        return folderReply('src', [{ path: 'src/b.ts', summary: 'B second.', tags: [], layer: 'data' }]);
      }
      return '[]';
    });
    const builder2 = createKnowledgeGraphBuilder({ chat, collectFiles: filesFrom(changedFiles), now: () => 2 });
    const graph = await builder2.build('/repo', 'gpt', { previous });
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));

    expect(byId.get('src/a.ts')?.summary).toBe('A first.');
    expect(byId.get('src/b.ts')?.summary).toBe('B second.');
    // The summary prompt must NOT have included the unchanged a.ts.
    const summaryCalls = chat.mock.calls.filter((c) => String(c[1]).includes('codebase folders'));
    expect(summaryCalls.every((c) => !String(c[2]).includes('src/a.ts'))).toBe(true);
  });

  it('emits the reusing phase when files carry over', async () => {
    const first = folderReply('src', [
      { path: 'src/a.ts', summary: 'A.', tags: [], layer: 'util' },
      { path: 'src/b.ts', summary: 'B.', tags: [], layer: 'data' },
    ]);
    const previous = await createKnowledgeGraphBuilder({
      chat: constantChat(first),
      collectFiles: filesFrom(files),
      now: () => 1,
    }).build('/repo', 'gpt');

    const phases: KnowledgeBuildPhase[] = [];
    await createKnowledgeGraphBuilder({ chat: constantChat('[]'), collectFiles: filesFrom(files), now: () => 2 }).build(
      '/repo',
      'gpt',
      { previous: previous as KnowledgeGraph },
      { onPhase: (p) => phases.push(p) }
    );
    expect(phases).toContain('reusing');
  });

  it('reuses unchanged module summaries without another folder summary call', async () => {
    const first = folderReply('src', [
      { path: 'src/a.ts', summary: 'A.', tags: [], layer: 'util' },
      { path: 'src/b.ts', summary: 'B.', tags: [], layer: 'data' },
    ]);
    const previous = await createKnowledgeGraphBuilder({
      chat: constantChat(first),
      collectFiles: filesFrom(files),
      now: () => 1,
    }).build('/repo', 'gpt');
    const previousSummary = previous.modules?.find((mod) => mod.id === 'src')?.summary;
    const chat = vi.fn(async () => '[]');

    const graph = await createKnowledgeGraphBuilder({ chat, collectFiles: filesFrom(files), now: () => 2 }).build(
      '/repo',
      'gpt',
      { previous }
    );

    expect(graph.modules?.find((mod) => mod.id === 'src')?.summary).toBe(previousSummary);
    expect(chat.mock.calls.some((call) => String(call[1]).includes('codebase folders'))).toBe(false);
  });
});

describe('graph freshness', () => {
  const files = [
    { relPath: 'src/a.ts', content: 'export const a = 1;\n' },
    { relPath: 'src/b.ts', content: 'export const b = 1;\n' },
  ];

  it('detects whether a persisted graph still matches repo files', async () => {
    const graph = await createKnowledgeGraphBuilder({
      chat: constantChat('[]'),
      collectFiles: filesFrom(files),
      now: () => 1,
    }).build('/repo', 'gpt');

    await expect(assessGraphFreshness(graph, { collectFiles: filesFrom(files) })).resolves.toMatchObject({
      fresh: true,
      changed: [],
      removed: [],
      added: [],
      staleMarker: false,
      markerChanged: [],
    });

    await expect(
      assessGraphFreshness(graph, {
        collectFiles: filesFrom([
          { relPath: 'src/a.ts', content: 'export const a = 2;\n' },
          { relPath: 'src/c.ts', content: 'export const c = 1;\n' },
        ]),
      })
    ).resolves.toMatchObject({
      fresh: false,
      changed: ['src/a.ts'],
      removed: ['src/b.ts'],
      added: ['src/c.ts'],
      staleMarker: false,
      markerChanged: [],
    });
  });

  it('marks a matching graph stale when MTUI left a stale marker', async () => {
    const root = await import('node:fs/promises').then(async (fs) => {
      const os = await import('node:os');
      const path = await import('node:path');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-graph-freshness-'));
      await fs.mkdir(path.join(dir, '.aionui', 'understand'), { recursive: true });
      await fs.writeFile(
        path.join(dir, '.aionui', 'understand', 'stale.json'),
        JSON.stringify({ updatedAt: '2026-06-06T00:00:00.000Z', paths: ['src/b.ts', 'src/a.ts', 'src/a.ts'] })
      );
      return dir;
    });
    const graph = await createKnowledgeGraphBuilder({
      chat: constantChat('[]'),
      collectFiles: filesFrom(files),
      now: () => 1,
    }).build(root, 'gpt');

    await expect(assessGraphFreshness(graph, { collectFiles: filesFrom(files) })).resolves.toMatchObject({
      fresh: false,
      changed: [],
      removed: [],
      added: [],
      staleMarker: true,
      markerChanged: ['src/a.ts', 'src/b.ts'],
      markerUpdatedAt: '2026-06-06T00:00:00.000Z',
    });
  });

  it('ignores malformed MTUI stale markers instead of failing freshness checks', async () => {
    const root = await import('node:fs/promises').then(async (fs) => {
      const os = await import('node:os');
      const path = await import('node:path');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-graph-freshness-'));
      await fs.mkdir(path.join(dir, '.aionui', 'understand'), { recursive: true });
      await fs.writeFile(path.join(dir, '.aionui', 'understand', 'stale.json'), '{not-json');
      return dir;
    });
    const graph = await createKnowledgeGraphBuilder({
      chat: constantChat('[]'),
      collectFiles: filesFrom(files),
      now: () => 1,
    }).build(root, 'gpt');

    await expect(assessGraphFreshness(graph, { collectFiles: filesFrom(files) })).resolves.toMatchObject({
      fresh: true,
      staleMarker: false,
      markerChanged: [],
    });
  });
});

describe('build — display language', () => {
  const files = [
    { relPath: 'src/a.ts', content: "import { b } from './b';\nexport const a = b;\n" },
    { relPath: 'src/b.ts', content: 'export const b = 1;\n' },
  ];

  it('records the language on the graph and instructs the model to write in it', async () => {
    const chat = vi.fn(async () => '[]');
    const builder = createKnowledgeGraphBuilder({ chat, collectFiles: filesFrom(files), now: () => 1 });
    const graph = await builder.build('/repo', 'gpt', { language: 'vi-VN' });

    expect(graph.language).toBe('vi-VN');
    // The summary prompt must instruct the model to write in Vietnamese.
    const userMsgs = chat.mock.calls.map((c) => String(c[2]));
    expect(userMsgs.some((m) => m.includes('Vietnamese'))).toBe(true);
  });

  it('does NOT instruct a language for English (default prompts)', async () => {
    const chat = vi.fn(async () => '[]');
    const builder = createKnowledgeGraphBuilder({ chat, collectFiles: filesFrom(files), now: () => 1 });
    await builder.build('/repo', 'gpt', { language: 'en-US' });
    const userMsgs = chat.mock.calls.map((c) => String(c[2]));
    expect(userMsgs.every((m) => !m.includes('Write every human-readable text value'))).toBe(true);
  });

  it('re-summarizes (does not reuse) when the display language changed', async () => {
    const first = folderReply('src', [
      { path: 'src/a.ts', summary: 'A in English.', tags: [], layer: 'util' },
      { path: 'src/b.ts', summary: 'B in English.', tags: [], layer: 'data' },
    ]);
    const previous = await createKnowledgeGraphBuilder({
      chat: constantChat(first),
      collectFiles: filesFrom(files),
      now: () => 1,
    }).build('/repo', 'gpt', { language: 'en-US' });

    // Same files (unchanged fingerprints) but a NEW language → must re-summarize.
    const chat = vi.fn(async () =>
      folderReply('src', [{ path: 'src/a.ts', summary: 'A tiếng Việt.', tags: [], layer: 'util' }])
    );
    const graph = await createKnowledgeGraphBuilder({ chat, collectFiles: filesFrom(files), now: () => 2 }).build(
      '/repo',
      'gpt',
      { previous, language: 'vi-VN' }
    );

    expect(graph.language).toBe('vi-VN');
    // chat WAS called for the summary pass (no language-mismatched reuse).
    const summaryCalls = chat.mock.calls.filter((c) => String(c[1]).includes('codebase folders'));
    expect(summaryCalls.length).toBeGreaterThan(0);
  });
});
