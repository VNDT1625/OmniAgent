import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (request: unknown) => unknown>() }));
vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: vi.fn((channel: string) => ({
      provider: vi.fn((handler: (request: unknown) => unknown) => handlers.set(channel, handler)),
    })),
  },
}));

import {
  QT_INSIGHTS_CHANNELS,
  registerQuickTestInsightsBridge,
  type RepeatReplayOutcome,
} from '@/process/ide/quickTestInsightsBridge';
import type { QuickTestAssetState } from '@/process/ide/quickTestAssetBridge';
import type { ReplayScenario } from '@/process/ide/quickTestReplay';
import type { RuntimeTrace } from '@/process/ide/quickTestTracer';
import type { UnderstandResult } from '@/process/ide/understandTypes';
import type { RetentionPolicy } from '@/process/services/quick-test/workflow';

const trace = (failed = false): RuntimeTrace => ({
  platform: 'web',
  rootPath: 'C:/repo',
  startedAt: 100,
  stoppedAt: 300,
  firstError: null,
  events: [
    {
      kind: 'network',
      method: 'GET',
      url: 'https://api.test/items?token=private',
      status: failed ? 500 : 200,
      requestId: 'request-1',
      responseBody: failed ? '{"error":true}' : '{"ok":true}',
      at: 150,
    },
    ...(failed ? ([{ kind: 'console', level: 'error', message: 'Failure 42', at: 200 }] as const) : []),
  ],
});

const scenario: ReplayScenario = {
  version: 1,
  id: 'scenario-1',
  name: 'Checkout',
  platform: 'web',
  rootPath: 'C:/repo',
  createdAt: 10,
  steps: [
    { id: 'navigate', kind: 'navigate', url: 'https://app.test', sourceAt: 10 },
    { id: 'click', kind: 'click', selector: '#buy', sourceAt: 20 },
  ],
};

const assetState = (): QuickTestAssetState => ({
  version: 1,
  scenarios: [structuredClone(scenario)],
  runs: [
    { id: 'failed', name: 'Failed', savedAt: 200, trace: trace(true) },
    { id: 'passed', name: 'Passed', savedAt: 100, trace: trace(false) },
  ],
  baselines: [],
});

const invoke = <T>(channel: string, request: unknown): Promise<UnderstandResult<T>> =>
  handlers.get(channel)?.(request) as Promise<UnderstandResult<T>>;

const retentionPolicy: RetentionPolicy = {
  categories: {
    run: { maxAgeMs: 1_000_000, maxCount: 1, maxBytes: 1_000_000 },
    baseline: { maxAgeMs: 1_000_000, maxCount: 10, maxBytes: 1_000_000 },
    media: { maxAgeMs: 1_000_000, maxCount: 10, maxBytes: 1_000_000 },
    report: { maxAgeMs: 1_000_000, maxCount: 10, maxBytes: 1_000_000 },
  },
  totalMaxBytes: 2_000_000,
};

beforeEach(() => handlers.clear());

describe('Quick Test insights bridge', () => {
  it('summarizes the latest stored run with secret-safe network evidence', async () => {
    registerQuickTestInsightsBridge({ readAssets: async () => assetState() });

    const result = await invoke<{ network: { requests: Array<{ url: string }> } }>(QT_INSIGHTS_CHANNELS.observability, {
      rootPath: 'C:/repo',
    });

    expect(result.ok && result.data.network.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('collects live performance and network evidence through injected tab diagnostics', async () => {
    registerQuickTestInsightsBridge({
      collectTabObservability: async () => ({
        network: [{ id: 'live', method: 'GET', url: '/live', startedAt: 0, finishedAt: 20, status: 200 }],
        performance: [{ kind: 'largest-contentful-paint', startTime: 2_200 }],
      }),
    });

    const result = await invoke<{ source: string; performance: { metrics: { lcpMs: { value: number } } } }>(
      QT_INSIGHTS_CHANNELS.observability,
      { rootPath: 'C:/repo', source: 'tab', tabId: 'tab-1' }
    );

    expect(result.ok && result.data.source).toBe('tab');
    expect(result.ok && result.data.performance.metrics.lcpMs.value).toBe(2_200);
  });

  it('classifies archived outcomes and clusters equivalent failures', async () => {
    const state = assetState();
    state.runs.push({ id: 'failed-2', name: 'Failed again', savedAt: 300, trace: trace(true) });
    registerQuickTestInsightsBridge({ readAssets: async () => state });

    const result = await invoke<{ summary: { classification: string }; clusters: unknown[] }>(
      QT_INSIGHTS_CHANNELS.reliability,
      { rootPath: 'C:/repo', testId: 'checkout' }
    );

    expect(result.ok && result.data.summary.classification).toBe('flaky');
    expect(result.ok && result.data.clusters).toHaveLength(2);
  });

  it('builds a redacted environment snapshot even when one collector fails', async () => {
    registerQuickTestInsightsBridge({
      environment: {
        git: () => {
          throw new Error('git unavailable');
        },
        environment: () => ({ API_TOKEN: 'private', MODE: 'test' }),
      },
      now: () => 500,
    });

    const result = await invoke<{ environment: Record<string, string>; warnings: string[]; capturedAt: number }>(
      QT_INSIGHTS_CHANNELS.environment,
      { rootPath: 'C:/repo' }
    );

    expect(result.ok && result.data.environment.API_TOKEN).toBe('[REDACTED]');
    expect(result.ok && result.data.warnings).toContain('git');
  });

  it('persists safe mock rules and supplies them to repeated replay', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'qt-insights-'));
    const statuses = ['passed', 'failed', 'passed'] as const;
    const replay = vi.fn(async (): Promise<RepeatReplayOutcome> => {
      const status = statuses[replay.mock.calls.length - 1] ?? 'passed';
      return {
        runId: `run-${replay.mock.calls.length}`,
        status,
        startedAt: replay.mock.calls.length * 10,
        finishedAt: replay.mock.calls.length * 10 + 5,
        errors: status === 'failed' ? [{ message: 'sometimes fails' }] : [],
      };
    });
    try {
      registerQuickTestInsightsBridge({ replay });
      const saved = await invoke(QT_INSIGHTS_CHANNELS.saveMock, {
        rootPath,
        rule: {
          id: 'items',
          match: { method: 'GET', url: { kind: 'exact', value: 'https://api.test/items' } },
          response: { status: 200, body: '{"items":[]}' },
        },
      });
      expect(saved.ok).toBe(true);

      const result = await invoke<{ summary: { classification: string }; runs: unknown[] }>(
        QT_INSIGHTS_CHANNELS.repeatReplay,
        { rootPath, scenarioId: 'scenario-1', repetitions: 3, useMocks: true }
      );
      expect(result.ok && result.data.summary.classification).toBe('flaky');
      expect(replay.mock.calls[0]?.[0].mockRules).toHaveLength(1);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('rejects mock rules that would persist credentials', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'qt-insights-'));
    try {
      registerQuickTestInsightsBridge();
      const result = await invoke(QT_INSIGHTS_CHANNELS.saveMock, {
        rootPath,
        rule: {
          id: 'unsafe',
          match: { url: { kind: 'exact', value: '/api' } },
          response: { status: 200, headers: { Authorization: 'Bearer private' } },
        },
      });

      expect(result.ok).toBe(false);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('exports bounded JSON and Markdown diagnostics to report files', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'qt-report-'));
    try {
      registerQuickTestInsightsBridge({
        readAssets: async () => assetState(),
        randomId: () => 'fixed',
        now: () => 500,
      });
      const result = await invoke<{ jsonPath: string; markdownPath: string }>(QT_INSIGHTS_CHANNELS.exportReport, {
        rootPath,
        runId: 'failed',
        scenarioId: 'scenario-1',
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(await readFile(result.data.markdownPath, 'utf8')).toContain('# Failed');
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('previews and applies the same bounded retention decision', async () => {
    let state = assetState();
    const writeAssets = vi.fn(async (_rootPath: string, next: QuickTestAssetState) => {
      state = structuredClone(next);
    });
    registerQuickTestInsightsBridge({ readAssets: async () => structuredClone(state), writeAssets, now: () => 400 });

    const preview = await invoke<{ delete: Array<{ asset: { id: string } }> }>(QT_INSIGHTS_CHANNELS.previewCleanup, {
      rootPath: 'C:/repo',
      policy: retentionPolicy,
    });
    const applied = await invoke<{ delete: Array<{ asset: { id: string } }> }>(QT_INSIGHTS_CHANNELS.applyCleanup, {
      rootPath: 'C:/repo',
      policy: retentionPolicy,
    });

    expect(preview.ok && preview.data.delete.map((item) => item.asset.id)).toEqual(['run:passed']);
    expect(applied.ok && applied.data.delete.map((item) => item.asset.id)).toEqual(['run:passed']);
    expect(state.runs.map((run) => run.id)).toEqual(['failed']);
  });

  it('reorders and edits replay steps with optimistic revision checking', async () => {
    let state = assetState();
    registerQuickTestInsightsBridge({
      readAssets: async () => structuredClone(state),
      writeAssets: async (_rootPath, next) => {
        state = structuredClone(next);
      },
      now: () => 900,
    });
    const result = await invoke<{ scenario: { revision: number; steps: Array<{ id: string }> } }>(
      QT_INSIGHTS_CHANNELS.editScenario,
      {
        rootPath: 'C:/repo',
        scenarioId: 'scenario-1',
        expectedRevision: 1,
        operations: [
          { type: 'reorder', stepId: 'click', toIndex: 0 },
          {
            type: 'edit',
            stepId: 'click',
            step: { id: 'click', kind: 'action', action: 'click', target: '#checkout' },
          },
        ],
      }
    );

    expect(result.ok && result.data.scenario.steps.map((step) => step.id)).toEqual(['click', 'navigate']);
    expect(result.ok && result.data.scenario.revision).toBe(2);
    expect(state.scenarios[0]?.steps[0]).toMatchObject({ kind: 'click', selector: '#checkout' });
  });

  it('returns structured errors for an empty root and unavailable replay', async () => {
    registerQuickTestInsightsBridge();

    const invalid = await invoke(QT_INSIGHTS_CHANNELS.listMocks, { rootPath: '  ' });
    const unavailable = await invoke(QT_INSIGHTS_CHANNELS.repeatReplay, {
      rootPath: 'C:/repo',
      scenarioId: 'scenario-1',
    });

    expect(invalid.ok).toBe(false);
    expect(unavailable.ok).toBe(false);
  });
});
