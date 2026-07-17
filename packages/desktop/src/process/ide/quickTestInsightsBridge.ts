import { bridge } from '@office-ai/platform';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import {
  buildNetworkInspection,
  buildPerformanceTimeline,
  type ApiMockRule,
  type NetworkInspection,
  type NetworkRequestSample,
  type PerformanceSample,
  type PerformanceTimeline,
} from '../services/quick-test/observability';
import {
  analyzeRepeatedRuns,
  buildEnvironmentSnapshot,
  clusterReliabilityErrors,
  type EnvironmentSnapshot,
  type EnvironmentSnapshotProviders,
  type ErrorCluster,
  type ReliabilityRun,
  type ReliabilitySummary,
} from '../services/quick-test/reliability';
import {
  applyScenarioEdits,
  buildDiagnosticReport,
  planRetentionCleanup,
  type DiagnosticReportBundle,
  type EditableScenario,
  type RetentionAsset,
  type RetentionCleanupPlan,
  type RetentionPolicy,
  type ScenarioEditOperation,
  type ScenarioStep,
} from '../services/quick-test/workflow';
import {
  readQuickTestAssetState,
  writeQuickTestAssetState,
  type QuickTestAssetState,
  type StoredQuickTestRun,
} from './quickTestAssetBridge';
import { isSensitiveReplaySelector, type ReplayScenario, type ReplayStep } from './quickTestReplay';
import type { RuntimeTrace, TraceEvent } from './quickTestTracer';
import type { UnderstandResult } from './understandTypes';

export const QT_INSIGHTS_CHANNELS = {
  observability: 'ide.qt-insights-observability',
  reliability: 'ide.qt-insights-reliability',
  environment: 'ide.qt-insights-environment',
  repeatReplay: 'ide.qt-insights-repeat-replay',
  listMocks: 'ide.qt-insights-list-mocks',
  saveMock: 'ide.qt-insights-save-mock',
  removeMock: 'ide.qt-insights-remove-mock',
  exportReport: 'ide.qt-insights-export-report',
  previewCleanup: 'ide.qt-insights-preview-cleanup',
  applyCleanup: 'ide.qt-insights-apply-cleanup',
  editScenario: 'ide.qt-insights-edit-scenario',
} as const;

export type InsightsRootRequest = { rootPath: string };
export type ObservabilityRequest = InsightsRootRequest & { source?: 'latest-run' | 'tab'; tabId?: string };
export type ObservabilityResult = {
  network: NetworkInspection;
  performance: PerformanceTimeline;
  source: 'run' | 'tab';
};
export type ReliabilityRequest = InsightsRootRequest & { testId?: string };
export type ReliabilityResult = { summary: ReliabilitySummary; clusters: ErrorCluster[] };
export type EnvironmentRequest = InsightsRootRequest;
export type RepeatReplayRequest = InsightsRootRequest & {
  scenarioId: string;
  repetitions?: number;
  tabId?: string;
  useMocks?: boolean;
};
export type RepeatReplayOutcome = {
  runId: string;
  status: 'passed' | 'failed' | 'cancelled' | 'timed-out';
  startedAt: number;
  finishedAt: number;
  errors?: Array<{ kind?: string; message: string; source?: string }>;
};
export type RepeatReplayResult = ReliabilityResult & { runs: RepeatReplayOutcome[] };
export type ListMocksRequest = InsightsRootRequest;
export type SaveMockRequest = InsightsRootRequest & { rule: ApiMockRule };
export type RemoveMockRequest = InsightsRootRequest & { ruleId: string };
export type MockRuleState = { version: 1; rules: ApiMockRule[] };
export type ExportReportRequest = InsightsRootRequest & { runId: string; scenarioId?: string; title?: string };
export type ExportReportResult = DiagnosticReportBundle & { jsonPath: string; markdownPath: string };
export type RetentionRequest = InsightsRootRequest & { policy: RetentionPolicy };
export type ApplyRetentionRequest = RetentionRequest;
export type EditScenarioRequest = InsightsRootRequest & {
  scenarioId: string;
  operations: readonly ScenarioEditOperation[];
  expectedRevision?: number;
};
export type EditScenarioResult = { scenario: EditableScenario; replayScenario: ReplayScenario };

export type TabObservabilitySnapshot = {
  network?: readonly NetworkRequestSample[];
  performance?: readonly PerformanceSample[];
};
export type QuickTestInsightsBridgeDeps = {
  collectTabObservability?: (tabId?: string) => Promise<TabObservabilitySnapshot>;
  replay?: (request: {
    rootPath: string;
    scenarioId: string;
    tabId?: string;
    mockRules: readonly ApiMockRule[];
  }) => Promise<RepeatReplayOutcome>;
  environment?: EnvironmentSnapshotProviders;
  now?: () => number;
  randomId?: () => string;
  readAssets?: (rootPath: string) => Promise<QuickTestAssetState>;
  writeAssets?: (rootPath: string, state: QuickTestAssetState) => Promise<void>;
};

export const quickTestInsightsChannels = {
  observability: bridge.buildProvider<UnderstandResult<ObservabilityResult>, ObservabilityRequest>(
    QT_INSIGHTS_CHANNELS.observability
  ),
  reliability: bridge.buildProvider<UnderstandResult<ReliabilityResult>, ReliabilityRequest>(
    QT_INSIGHTS_CHANNELS.reliability
  ),
  environment: bridge.buildProvider<UnderstandResult<EnvironmentSnapshot>, EnvironmentRequest>(
    QT_INSIGHTS_CHANNELS.environment
  ),
  repeatReplay: bridge.buildProvider<UnderstandResult<RepeatReplayResult>, RepeatReplayRequest>(
    QT_INSIGHTS_CHANNELS.repeatReplay
  ),
  listMocks: bridge.buildProvider<UnderstandResult<MockRuleState>, ListMocksRequest>(QT_INSIGHTS_CHANNELS.listMocks),
  saveMock: bridge.buildProvider<UnderstandResult<ApiMockRule>, SaveMockRequest>(QT_INSIGHTS_CHANNELS.saveMock),
  removeMock: bridge.buildProvider<UnderstandResult<boolean>, RemoveMockRequest>(QT_INSIGHTS_CHANNELS.removeMock),
  exportReport: bridge.buildProvider<UnderstandResult<ExportReportResult>, ExportReportRequest>(
    QT_INSIGHTS_CHANNELS.exportReport
  ),
  previewCleanup: bridge.buildProvider<UnderstandResult<RetentionCleanupPlan>, RetentionRequest>(
    QT_INSIGHTS_CHANNELS.previewCleanup
  ),
  applyCleanup: bridge.buildProvider<UnderstandResult<RetentionCleanupPlan>, ApplyRetentionRequest>(
    QT_INSIGHTS_CHANNELS.applyCleanup
  ),
  editScenario: bridge.buildProvider<UnderstandResult<EditScenarioResult>, EditScenarioRequest>(
    QT_INSIGHTS_CHANNELS.editScenario
  ),
};

const root = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error('A folder path is required.');
  return normalized;
};
const errorResult = (error: unknown): UnderstandResult<never> => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
  code: 'error',
});
const insightsDir = (rootPath: string): string => path.join(rootPath, '.omni', 'quick-test');
const mocksPath = (rootPath: string): string => path.join(insightsDir(rootPath), 'mock-rules.json');

const readMocks = async (rootPath: string): Promise<MockRuleState> => {
  const raw = await fsp.readFile(mocksPath(rootPath), 'utf8').catch((): null => null);
  if (!raw) return { version: 1, rules: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<MockRuleState>;
    return { version: 1, rules: Array.isArray(parsed.rules) ? parsed.rules.slice(0, 100) : [] };
  } catch {
    return { version: 1, rules: [] };
  }
};
const writeMocks = async (rootPath: string, state: MockRuleState): Promise<void> => {
  await fsp.mkdir(insightsDir(rootPath), { recursive: true });
  const target = mocksPath(rootPath);
  await fsp.writeFile(`${target}.tmp`, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(`${target}.tmp`, target);
};
const SECRET_PATTERN = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|bearer\s+)/i;
const validateMockRule = (rule: ApiMockRule): ApiMockRule => {
  const id = rule.id.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error('Mock rule id is invalid.');
  const url = rule.match.url.value.trim();
  if (!url || url.length > 2_048 || !(url.startsWith('/') || /^https?:\/\//i.test(url))) {
    throw new Error('Mock URLs must be relative or use HTTP(S).');
  }
  if (!Number.isInteger(rule.response.status) || rule.response.status < 100 || rule.response.status > 599) {
    throw new Error('Mock response status is invalid.');
  }
  const sensitive = [
    ...Object.entries(rule.match.headers ?? {}).flat(),
    ...Object.entries(rule.response.headers ?? {}).flat(),
    rule.match.bodyIncludes ?? '',
    rule.response.body ?? '',
  ].some((value) => SECRET_PATTERN.test(value));
  if (sensitive) throw new Error('Mock rules cannot persist credentials or secret-bearing payloads.');
  return {
    ...rule,
    id,
    match: { ...rule.match, url: { ...rule.match.url, value: url } },
    response: { ...rule.response, delayMs: Math.min(60_000, Math.max(0, rule.response.delayMs ?? 0)) },
  };
};

const traceNetwork = (trace: RuntimeTrace): NetworkRequestSample[] =>
  trace.events.flatMap((event, index) =>
    event.kind === 'network'
      ? [
          {
            id: event.requestId ?? `network-${index}`,
            method: event.method,
            url: event.url,
            startedAt: event.at,
            responseAt: event.at,
            finishedAt: event.at,
            status: event.status,
            resourceType: event.resourceType,
            requestBody: event.requestBody,
            responseHeaders: event.responseHeaders,
            responseBody: event.responseBody,
            error: event.error,
          },
        ]
      : []
  );

const traceErrors = (trace: RuntimeTrace): ReliabilityRun['errors'] =>
  trace.events.flatMap((event) => {
    if (event.kind === 'exception')
      return [{ kind: 'exception', message: event.message, stack: event.stack, source: event.url }];
    if (event.kind === 'console' && event.level === 'error') return [{ kind: 'console', message: event.message }];
    if (event.kind === 'network' && (event.error || event.status >= 400)) {
      return [
        {
          kind: 'network',
          message: event.error ?? `${event.method} ${event.url} returned ${event.status}`,
          source: event.url,
        },
      ];
    }
    return [];
  });
const storedReliabilityRun = (run: StoredQuickTestRun, testId: string): ReliabilityRun => {
  const errors = traceErrors(run.trace);
  return {
    runId: run.id,
    testId,
    status: errors.length > 0 ? 'failed' : 'passed',
    startedAt: run.trace.startedAt,
    finishedAt: run.trace.stoppedAt,
    errors,
  };
};

const eventDetail = (event: TraceEvent): string => {
  if (event.kind === 'navigate') return event.url;
  if (event.kind === 'click') return event.selector;
  if (event.kind === 'input') return event.selector;
  if (event.kind === 'console' || event.kind === 'exception') return event.message;
  return `${event.method} ${event.url} ${event.status}`;
};

const editableScenario = (scenario: ReplayScenario): EditableScenario => {
  const metadata = scenario as ReplayScenario & { revision?: number; updatedAt?: number };
  return {
    id: scenario.id,
    name: scenario.name,
    revision: metadata.revision ?? 1,
    updatedAt: metadata.updatedAt ?? scenario.createdAt,
    steps: scenario.steps.map((step): ScenarioStep => {
      if (step.kind === 'navigate') return { id: step.id, kind: 'action', action: 'navigate', target: step.url };
      if (step.kind === 'click') return { id: step.id, kind: 'action', action: 'click', target: step.selector };
      return { id: step.id, kind: 'action', action: 'input', target: step.selector, value: step.value };
    }),
  };
};
const replayFromEditable = (edited: EditableScenario, original: ReplayScenario): ReplayScenario => {
  const byId = new Map(original.steps.map((step) => [step.id, step]));
  const steps = edited.steps.map((step): ReplayStep => {
    if (step.kind !== 'action' || step.action === 'wait')
      throw new Error('Saved replay scenarios support navigate, click and input actions only.');
    const sourceAt = byId.get(step.id)?.sourceAt ?? edited.updatedAt;
    if (step.action === 'navigate') return { id: step.id, kind: 'navigate', url: step.target ?? '', sourceAt };
    if (step.action === 'click') return { id: step.id, kind: 'click', selector: step.target ?? '', sourceAt };
    const selector = step.target ?? '';
    const previous = byId.get(step.id);
    const redacted = (previous?.kind === 'input' && previous.redacted) || isSensitiveReplaySelector(selector);
    return {
      id: step.id,
      kind: 'input',
      selector,
      value: redacted ? '[REDACTED]' : (step.value ?? ''),
      redacted,
      sourceAt,
    };
  });
  return {
    ...original,
    name: edited.name,
    steps,
    revision: edited.revision,
    updatedAt: edited.updatedAt,
  } as ReplayScenario;
};

const fileAssets = async (directory: string, category: 'media' | 'report'): Promise<RetentionAsset[]> => {
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((): [] => []);
  const assets: RetentionAsset[] = [];
  for (const entry of entries.slice(0, 500)) {
    if (!entry.isFile()) continue;
    const target = path.join(directory, entry.name);
    // eslint-disable-next-line no-await-in-loop -- bounded filesystem metadata scan.
    const stat = await fsp.stat(target).catch((): null => null);
    if (stat) assets.push({ id: `${category}:${entry.name}`, category, createdAt: stat.mtimeMs, sizeBytes: stat.size });
  }
  return assets;
};
const retentionAssets = async (rootPath: string, state: QuickTestAssetState): Promise<RetentionAsset[]> => {
  const runs = state.runs.map((run) => ({
    id: `run:${run.id}`,
    category: 'run' as const,
    createdAt: run.savedAt,
    sizeBytes: Buffer.byteLength(JSON.stringify(run)),
  }));
  const baselines = await Promise.all(
    state.baselines.map(async (baseline): Promise<RetentionAsset> => {
      const stat = await fsp.stat(baseline.checkpoint.screenshotPath).catch((): null => null);
      return {
        id: `baseline:${baseline.checkpoint.id}`,
        category: 'baseline',
        createdAt: baseline.checkpoint.capturedAt,
        sizeBytes: stat?.size ?? 0,
      };
    })
  );
  const [media, reports] = await Promise.all([
    fileAssets(path.join(insightsDir(rootPath), 'media'), 'media'),
    fileAssets(path.join(insightsDir(rootPath), 'reports'), 'report'),
  ]);
  return [...runs, ...baselines, ...media, ...reports];
};

export const registerQuickTestInsightsBridge = (deps: QuickTestInsightsBridgeDeps = {}): void => {
  const readAssets = deps.readAssets ?? readQuickTestAssetState;
  const writeAssets = deps.writeAssets ?? writeQuickTestAssetState;
  const now = deps.now ?? Date.now;
  const id = deps.randomId ?? randomUUID;

  quickTestInsightsChannels.observability.provider(async (request) => {
    try {
      const rootPath = root(request.rootPath);
      if (request.source === 'tab') {
        if (!deps.collectTabObservability) throw new Error('Live tab observability is unavailable.');
        const snapshot = await deps.collectTabObservability(request.tabId);
        return {
          ok: true,
          data: {
            network: buildNetworkInspection(snapshot.network ?? []),
            performance: buildPerformanceTimeline(snapshot.performance ?? []),
            source: 'tab',
          },
        };
      }
      const latest = (await readAssets(rootPath)).runs[0];
      return {
        ok: true,
        data: {
          network: buildNetworkInspection(latest ? traceNetwork(latest.trace) : []),
          performance: buildPerformanceTimeline([]),
          source: 'run',
        },
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  quickTestInsightsChannels.reliability.provider(async (request) => {
    try {
      const testId = request.testId?.trim() || 'workspace';
      const runs = (await readAssets(root(request.rootPath))).runs.map((run) => storedReliabilityRun(run, testId));
      return {
        ok: true,
        data: { summary: analyzeRepeatedRuns(testId, runs), clusters: clusterReliabilityErrors(runs) },
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  quickTestInsightsChannels.environment.provider(async (request) => {
    try {
      root(request.rootPath);
      const defaults: EnvironmentSnapshotProviders = {
        platform: () => ({ os: process.platform, arch: process.arch, runtimeVersions: process.versions }),
        environment: () => process.env,
        now,
      };
      return { ok: true, data: await buildEnvironmentSnapshot({ ...defaults, ...deps.environment, now }) };
    } catch (error) {
      return errorResult(error);
    }
  });

  quickTestInsightsChannels.repeatReplay.provider(async (request) => {
    try {
      if (!deps.replay) throw new Error('Automated replay is unavailable.');
      const rootPath = root(request.rootPath);
      const repetitions = Math.min(20, Math.max(2, Math.floor(request.repetitions ?? 5)));
      const rules = request.useMocks ? (await readMocks(rootPath)).rules.map(validateMockRule) : [];
      const outcomes: RepeatReplayOutcome[] = [];
      for (let index = 0; index < repetitions; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- flaky detection must preserve isolated run order.
        const outcome = await deps.replay({
          rootPath,
          scenarioId: request.scenarioId,
          tabId: request.tabId,
          mockRules: rules,
        });
        outcomes.push(outcome);
      }
      const runs: ReliabilityRun[] = outcomes.map((outcome) => ({
        runId: outcome.runId,
        testId: request.scenarioId,
        status: outcome.status,
        startedAt: outcome.startedAt,
        finishedAt: outcome.finishedAt,
        errors: outcome.errors,
      }));
      return {
        ok: true,
        data: {
          runs: outcomes,
          summary: analyzeRepeatedRuns(request.scenarioId, runs),
          clusters: clusterReliabilityErrors(runs),
        },
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  quickTestInsightsChannels.listMocks.provider(async (request) => {
    try {
      return { ok: true, data: await readMocks(root(request.rootPath)) };
    } catch (error) {
      return errorResult(error);
    }
  });
  quickTestInsightsChannels.saveMock.provider(async (request) => {
    try {
      const rootPath = root(request.rootPath);
      const rule = validateMockRule(request.rule);
      const state = await readMocks(rootPath);
      state.rules = [rule, ...state.rules.filter((candidate) => candidate.id !== rule.id)].slice(0, 100);
      await writeMocks(rootPath, state);
      return { ok: true, data: rule };
    } catch (error) {
      return errorResult(error);
    }
  });
  quickTestInsightsChannels.removeMock.provider(async (request) => {
    try {
      const rootPath = root(request.rootPath);
      const state = await readMocks(rootPath);
      state.rules = state.rules.filter((rule) => rule.id !== request.ruleId);
      await writeMocks(rootPath, state);
      return { ok: true, data: true };
    } catch (error) {
      return errorResult(error);
    }
  });

  quickTestInsightsChannels.exportReport.provider(async (request) => {
    try {
      const rootPath = root(request.rootPath);
      const run = (await readAssets(rootPath)).runs.find((candidate) => candidate.id === request.runId);
      if (!run) throw new Error('Quick Test run was not found.');
      const reportId = `report-${id()}`;
      const errors = traceErrors(run.trace);
      const bundle = buildDiagnosticReport({
        reportId,
        scenarioId: request.scenarioId ?? 'workspace',
        runId: run.id,
        title: request.title?.trim() || run.name,
        summary: errors.length
          ? `${errors.length} failure signal(s) captured.`
          : 'The Quick Test run completed without captured errors.',
        status: errors.length ? 'failed' : 'passed',
        createdAt: now(),
        durationMs: Math.max(0, run.trace.stoppedAt - run.trace.startedAt),
        events: run.trace.events.map((event) => ({
          timestamp: event.at,
          type: event.kind,
          outcome:
            event.kind === 'exception' || (event.kind === 'console' && event.level === 'error') ? 'failed' : 'info',
          detail: eventDetail(event),
        })),
        findings: errors.map((error) => ({ severity: 'error', title: error.kind ?? 'runtime', detail: error.message })),
      });
      const directory = path.join(insightsDir(rootPath), 'reports');
      await fsp.mkdir(directory, { recursive: true });
      const jsonPath = path.join(directory, `${reportId}.json`);
      const markdownPath = path.join(directory, `${reportId}.md`);
      await Promise.all([
        fsp.writeFile(jsonPath, bundle.json, 'utf8'),
        fsp.writeFile(markdownPath, bundle.markdown, 'utf8'),
      ]);
      return { ok: true, data: { ...bundle, jsonPath, markdownPath } };
    } catch (error) {
      return errorResult(error);
    }
  });

  const cleanupPlan = async (
    request: RetentionRequest
  ): Promise<{ rootPath: string; state: QuickTestAssetState; plan: RetentionCleanupPlan }> => {
    const rootPath = root(request.rootPath);
    const state = await readAssets(rootPath);
    const plan = planRetentionCleanup(await retentionAssets(rootPath, state), request.policy, now());
    return { rootPath, state, plan };
  };
  quickTestInsightsChannels.previewCleanup.provider(async (request) => {
    try {
      return { ok: true, data: (await cleanupPlan(request)).plan };
    } catch (error) {
      return errorResult(error);
    }
  });
  quickTestInsightsChannels.applyCleanup.provider(async (request) => {
    try {
      const { rootPath, state, plan } = await cleanupPlan(request);
      const ids = new Set(plan.delete.map((decision) => decision.asset.id));
      const removedBaselines = state.baselines.filter((item) => ids.has(`baseline:${item.checkpoint.id}`));
      state.runs = state.runs.filter((run) => !ids.has(`run:${run.id}`));
      state.baselines = state.baselines.filter((item) => !ids.has(`baseline:${item.checkpoint.id}`));
      await writeAssets(rootPath, state);
      await Promise.all([
        ...removedBaselines.map((item) => fsp.rm(item.checkpoint.screenshotPath, { force: true })),
        ...plan.delete
          .filter((decision) => decision.asset.category === 'media' || decision.asset.category === 'report')
          .map((decision) => {
            const [category, ...name] = decision.asset.id.split(':');
            return fsp.rm(
              path.join(insightsDir(rootPath), category === 'media' ? 'media' : 'reports', name.join(':')),
              { force: true }
            );
          }),
      ]);
      return { ok: true, data: plan };
    } catch (error) {
      return errorResult(error);
    }
  });

  quickTestInsightsChannels.editScenario.provider(async (request) => {
    try {
      const rootPath = root(request.rootPath);
      const state = await readAssets(rootPath);
      const index = state.scenarios.findIndex((scenario) => scenario.id === request.scenarioId);
      const original = state.scenarios[index];
      if (!original) throw new Error('Replay scenario was not found.');
      const editable = editableScenario(original);
      if (request.expectedRevision !== undefined && request.expectedRevision !== editable.revision) {
        throw new Error('Scenario revision changed; reload before editing.');
      }
      const edited = applyScenarioEdits(editable, request.operations, now());
      const replayScenario = replayFromEditable(edited, original);
      state.scenarios[index] = replayScenario;
      await writeAssets(rootPath, state);
      return { ok: true, data: { scenario: edited, replayScenario } };
    } catch (error) {
      return errorResult(error);
    }
  });
};
