import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import {
  isSensitiveReplaySelector,
  isValidReplaySelector,
  isValidReplayUrl,
  REPLAY_REDACTED_VALUE,
  type ReplayPageAdapter,
  type ReplayRunMode,
  type ReplayScenario,
  type ReplayStep,
} from '../quickTestReplay';

export type ScenarioRunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'timed-out';

export type ScenarioActionEvidence = {
  stepId: string;
  stepIndex: number;
  kind: ReplayStep['kind'];
  target: string;
  status: 'passed' | 'failed' | 'cancelled' | 'timed-out';
  startedAt: number;
  finishedAt: number;
  error?: string;
};

export type ScenarioRuntimeEvidence = {
  consoleErrors: string[];
  networkFailures: string[];
  attachments: string[];
  relatedFiles: string[];
};

export type ScenarioFailureCategory =
  | 'interaction'
  | 'runtime-console'
  | 'runtime-network'
  | 'evidence-collection'
  | 'setup'
  | 'timeout'
  | 'cancelled';

export type ScenarioRunAssessment = {
  verdict: 'passed' | 'failed' | 'inconclusive';
  summary: string;
  failure: {
    category: ScenarioFailureCategory;
    message: string;
    stepId?: string;
    stepIndex?: number;
    kind?: ReplayStep['kind'];
    target?: string;
  } | null;
  evidenceCounts: {
    consoleErrors: number;
    networkFailures: number;
    attachments: number;
    relatedFiles: number;
  };
  rerun: {
    recommended: boolean;
    debugMode: ReplayRunMode;
    verificationMode: { kind: 'full' };
  };
};

export type ScenarioRunResult = {
  runId: string;
  testId: string;
  scenarioName: string;
  rootPath: string;
  status: Exclude<ScenarioRunStatus, 'running'>;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  actions: ScenarioActionEvidence[];
  failedStep: number | null;
  reason: string | null;
  evidence: ScenarioRuntimeEvidence;
  assessment: ScenarioRunAssessment;
};

export type ScenarioRunSnapshot =
  | {
      runId: string;
      testId: string;
      scenarioName: string;
      rootPath: string;
      status: 'running';
      startedAt: number;
    }
  | ScenarioRunResult;

export type StartScenarioRunRequest = {
  rootPath: string;
  testId: string;
  target?: string;
  mode?: ReplayRunMode;
  timeoutMs?: number;
  inputOverrides?: Readonly<Record<string, string>>;
  tabId?: string;
};

export type ScenarioRunnerAdapter = ReplayPageAdapter & {
  collectEvidence?: () => Promise<Partial<ScenarioRuntimeEvidence>>;
  dispose?: () => Promise<void> | void;
};

export type ScenarioRunnerDeps = {
  createAdapter: (input: {
    rootPath: string;
    testId: string;
    runId: string;
    scenario: ReplayScenario;
    target?: string;
    tabId?: string;
  }) => Promise<ScenarioRunnerAdapter> | ScenarioRunnerAdapter;
  resolveSecret?: (input: {
    rootPath: string;
    testId: string;
    stepId: string;
    selector: string;
  }) => Promise<string | null>;
  readFile?: (filePath: string, encoding: 'utf8') => Promise<string>;
  now?: () => number;
  randomId?: () => string;
  defaultTimeoutMs?: number;
};

type AssetsFile = { scenarios?: unknown };
type ActiveRun = {
  abortController: AbortController;
  snapshot: ScenarioRunSnapshot;
  completion: Promise<ScenarioRunResult>;
  resolveCompletion: (result: ScenarioRunResult) => void;
  timeoutTriggered: boolean;
};

const EMPTY_RUNTIME_EVIDENCE: ScenarioRuntimeEvidence = {
  consoleErrors: [],
  networkFailures: [],
  attachments: [],
  relatedFiles: [],
};
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const MAX_INPUT_OVERRIDES = 50;
const MAX_INPUT_OVERRIDE_LENGTH = 16_384;
const MAX_STORED_RUNS = 100;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sanitizeScenario = (value: unknown, expectedId: string): ReplayScenario | null => {
  if (!isRecord(value) || value.id !== expectedId || !Array.isArray(value.steps)) return null;
  if (typeof value.name !== 'string' || typeof value.rootPath !== 'string' || typeof value.createdAt !== 'number') {
    return null;
  }
  if (
    value.platform !== 'web' &&
    value.platform !== 'windows' &&
    value.platform !== 'desktop' &&
    value.platform !== 'android'
  )
    return null;
  const platform = value.platform === 'desktop' ? 'windows' : value.platform;

  const steps: ReplayStep[] = [];
  for (const candidate of value.steps) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || typeof candidate.sourceAt !== 'number') return null;
    if (candidate.kind === 'navigate' && typeof candidate.url === 'string' && isValidReplayUrl(candidate.url)) {
      steps.push({ id: candidate.id, kind: 'navigate', url: candidate.url, sourceAt: candidate.sourceAt });
      continue;
    }
    if (
      candidate.kind === 'click' &&
      typeof candidate.selector === 'string' &&
      isValidReplaySelector(candidate.selector)
    ) {
      steps.push({ id: candidate.id, kind: 'click', selector: candidate.selector, sourceAt: candidate.sourceAt });
      continue;
    }
    if (
      candidate.kind === 'input' &&
      typeof candidate.selector === 'string' &&
      isValidReplaySelector(candidate.selector) &&
      typeof candidate.value === 'string'
    ) {
      const redacted = candidate.redacted === true || isSensitiveReplaySelector(candidate.selector);
      steps.push({
        id: candidate.id,
        kind: 'input',
        selector: candidate.selector,
        value: redacted ? REPLAY_REDACTED_VALUE : candidate.value,
        redacted,
        sourceAt: candidate.sourceAt,
      });
      continue;
    }
    return null;
  }

  return {
    version: 1,
    id: expectedId,
    name: value.name,
    platform,
    rootPath: value.rootPath,
    ...(typeof value.target === 'string' && value.target.trim() ? { target: value.target.trim() } : {}),
    createdAt: value.createdAt,
    steps,
  };
};

export const loadSavedQuickTestScenario = async (
  rootPath: string,
  testId: string,
  readFile: (filePath: string, encoding: 'utf8') => Promise<string> = fsp.readFile
): Promise<ReplayScenario> => {
  const normalizedRoot = rootPath.trim();
  const normalizedId = testId.trim();
  if (!normalizedRoot) throw new Error('A project root path is required.');
  if (!normalizedId) throw new Error('A Quick Test scenario ID is required.');

  const filePath = path.join(path.resolve(normalizedRoot), '.omni', 'quick-test', 'assets.json');
  let parsed: AssetsFile;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as AssetsFile;
  } catch (error) {
    throw new Error(`Quick Test assets could not be loaded: ${errorMessage(error)}`, { cause: error });
  }
  if (!Array.isArray(parsed.scenarios)) throw new Error('Quick Test assets do not contain saved scenarios.');
  const scenario = parsed.scenarios.map((value) => sanitizeScenario(value, normalizedId)).find(Boolean);
  if (!scenario) throw new Error(`Quick Test scenario "${normalizedId}" was not found or is invalid.`);
  return scenario;
};

const resolveStepIndexes = (stepCount: number, mode: ReplayRunMode): number[] => {
  if (mode.kind === 'full') return Array.from({ length: stepCount }, (_, index) => index);
  if (!Number.isInteger(mode.stepIndex) || mode.stepIndex < 0 || mode.stepIndex >= stepCount) {
    throw new RangeError(`Replay step index ${mode.stepIndex} is outside the scenario.`);
  }
  if (mode.kind === 'single-step') return [mode.stepIndex];
  return Array.from({ length: stepCount - mode.stepIndex }, (_, index) => index + mode.stepIndex);
};

const targetForStep = (step: ReplayStep): string => (step.kind === 'navigate' ? step.url : step.selector);

const validateInputOverrides = (
  scenario: ReplayScenario,
  overrides: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> => {
  if (!overrides) return {};
  const entries = Object.entries(overrides);
  if (entries.length > MAX_INPUT_OVERRIDES) {
    throw new RangeError(`A run can override at most ${MAX_INPUT_OVERRIDES} secret input steps.`);
  }
  const redactedSteps = new Map(
    scenario.steps
      .filter((step): step is Extract<ReplayStep, { kind: 'input' }> => step.kind === 'input' && step.redacted)
      .map((step) => [step.id, step])
  );
  const validated: Record<string, string> = {};
  for (const [stepId, value] of entries) {
    if (!redactedSteps.has(stepId)) {
      throw new Error(`Input override step ${stepId} does not exist or is not redacted.`);
    }
    if (typeof value !== 'string' || !value || value.length > MAX_INPUT_OVERRIDE_LENGTH) {
      throw new RangeError(
        `Input override ${stepId} must contain between 1 and ${MAX_INPUT_OVERRIDE_LENGTH} characters.`
      );
    }
    validated[stepId] = value;
  }
  return validated;
};

const replaceSecrets = (value: string, secrets: ReadonlySet<string>): string => {
  let safe = value;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join(REPLAY_REDACTED_VALUE);
  }
  return safe;
};

const sanitizeRuntimeEvidence = (
  value: Partial<ScenarioRuntimeEvidence> | undefined,
  secrets: ReadonlySet<string>
): ScenarioRuntimeEvidence => {
  const strings = (items: unknown): string[] =>
    Array.isArray(items)
      ? items.filter((item): item is string => typeof item === 'string').map((item) => replaceSecrets(item, secrets))
      : [];
  return {
    consoleErrors: strings(value?.consoleErrors),
    networkFailures: strings(value?.networkFailures),
    attachments: strings(value?.attachments),
    relatedFiles: strings(value?.relatedFiles),
  };
};

const raceWithAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) throw signal.reason;
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((deferredResolve) => {
    resolve = deferredResolve;
  });
  return { promise, resolve };
};

type InputReplayStep = Extract<ReplayStep, { kind: 'input' }>;
type ResolveInputValue = (step: InputReplayStep) => Promise<string>;

const executeScenarioStep = async (
  adapter: ScenarioRunnerAdapter,
  step: ReplayStep,
  resolveInputValue: ResolveInputValue
): Promise<void> => {
  if (step.kind === 'navigate') {
    await adapter.navigate(step.url);
    return;
  }
  if (step.kind === 'click') {
    await adapter.click(step.selector);
    return;
  }
  await adapter.input(step.selector, await resolveInputValue(step));
};

const buildRunAssessment = (input: {
  status: ScenarioRunResult['status'];
  reason: string | null;
  failedStep: number | null;
  actions: ScenarioActionEvidence[];
  evidence: ScenarioRuntimeEvidence;
  failureCategory: ScenarioFailureCategory | null;
}): ScenarioRunAssessment => {
  const failedAction =
    input.failedStep === null ? undefined : input.actions.find((action) => action.stepIndex === input.failedStep);
  const verdict = input.status === 'passed' ? 'passed' : input.status === 'cancelled' ? 'inconclusive' : 'failed';
  const fallbackMessage =
    input.status === 'passed'
      ? 'All selected scenario actions completed without recorded runtime failures.'
      : input.status === 'cancelled'
        ? 'The scenario run was cancelled before a pass or fail verdict could be reached.'
        : 'The scenario run failed without a detailed error message.';
  const message = input.reason ?? fallbackMessage;

  return {
    verdict,
    summary: message,
    failure:
      input.status === 'passed'
        ? null
        : {
            category:
              input.failureCategory ??
              (input.status === 'timed-out' ? 'timeout' : input.status === 'cancelled' ? 'cancelled' : 'setup'),
            message,
            ...(failedAction
              ? {
                  stepId: failedAction.stepId,
                  stepIndex: failedAction.stepIndex,
                  kind: failedAction.kind,
                  target: failedAction.target,
                }
              : {}),
          },
    evidenceCounts: {
      consoleErrors: input.evidence.consoleErrors.length,
      networkFailures: input.evidence.networkFailures.length,
      attachments: input.evidence.attachments.length,
      relatedFiles: input.evidence.relatedFiles.length,
    },
    rerun: {
      recommended: input.status !== 'passed' && input.status !== 'cancelled',
      debugMode: failedAction ? { kind: 'from-step', stepIndex: failedAction.stepIndex } : { kind: 'full' },
      verificationMode: { kind: 'full' },
    },
  };
};

export class QuickTestScenarioRunner {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly readFile: (filePath: string, encoding: 'utf8') => Promise<string>;

  constructor(private readonly deps: ScenarioRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.randomId = deps.randomId ?? randomUUID;
    this.readFile = deps.readFile ?? fsp.readFile;
  }

  async start(request: StartScenarioRunRequest): Promise<ScenarioRunSnapshot> {
    const scenario = await loadSavedQuickTestScenario(request.rootPath, request.testId, this.readFile);
    const timeoutMs = request.timeoutMs ?? this.deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new RangeError(`Scenario timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`);
    }
    const mode = request.mode ?? { kind: 'full' };
    resolveStepIndexes(scenario.steps.length, mode);
    const inputOverrides = validateInputOverrides(scenario, request.inputOverrides);
    const target = request.target?.trim() || scenario.target?.trim();

    const runId = this.randomId();
    const startedAt = this.now();
    const deferred = createDeferred<ScenarioRunResult>();
    const active: ActiveRun = {
      abortController: new AbortController(),
      snapshot: {
        runId,
        testId: scenario.id,
        scenarioName: scenario.name,
        rootPath: path.resolve(request.rootPath),
        status: 'running',
        startedAt,
      },
      completion: deferred.promise,
      resolveCompletion: deferred.resolve,
      timeoutTriggered: false,
    };
    this.pruneRuns();
    this.runs.set(runId, active);
    void this.execute(active, scenario, mode, timeoutMs, inputOverrides, target, request.tabId);
    return active.snapshot;
  }

  async run(request: StartScenarioRunRequest): Promise<ScenarioRunResult> {
    const started = await this.start(request);
    return this.wait(started.runId);
  }

  get(runId: string): ScenarioRunSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  async wait(runId: string): Promise<ScenarioRunResult> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Quick Test run "${runId}" was not found.`);
    return run.completion;
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.snapshot.status !== 'running') return false;
    run.abortController.abort(new Error('Quick Test run was cancelled.'));
    return true;
  }

  private pruneRuns(): void {
    for (const [runId, run] of this.runs) {
      if (this.runs.size < MAX_STORED_RUNS) break;
      if (run.snapshot.status !== 'running') this.runs.delete(runId);
    }
    if (this.runs.size >= MAX_STORED_RUNS) {
      throw new Error('Too many Quick Test scenarios are running. Wait for one to finish or cancel it.');
    }
  }

  private async execute(
    active: ActiveRun,
    scenario: ReplayScenario,
    mode: ReplayRunMode,
    timeoutMs: number,
    inputOverrides: Readonly<Record<string, string>>,
    target?: string,
    tabId?: string
  ): Promise<void> {
    const signal = active.abortController.signal;
    const secrets = new Set<string>();
    const actions: ScenarioActionEvidence[] = [];
    let adapter: ScenarioRunnerAdapter | null = null;
    let reason: string | null = null;
    let failedStep: number | null = null;
    let status: ScenarioRunResult['status'] = 'passed';
    let failureCategory: ScenarioFailureCategory | null = null;
    const timer = setTimeout(() => {
      active.timeoutTriggered = true;
      active.abortController.abort(new Error(`Quick Test run exceeded ${timeoutMs} milliseconds.`));
    }, timeoutMs);

    try {
      adapter = await raceWithAbort(
        Promise.resolve(
          this.deps.createAdapter({
            rootPath: active.snapshot.rootPath,
            testId: scenario.id,
            runId: active.snapshot.runId,
            scenario,
            target,
            tabId,
          })
        ),
        signal
      );
      const resolveInputValue: ResolveInputValue = async (step) => {
        let value = step.value;
        if (step.redacted || isSensitiveReplaySelector(step.selector)) {
          value =
            inputOverrides[step.id] ??
            (await this.deps.resolveSecret?.({
              rootPath: active.snapshot.rootPath,
              testId: scenario.id,
              stepId: step.id,
              selector: step.selector,
            })) ??
            '';
          if (!value) throw new Error('A secret reference is required for this input step.');
        }
        secrets.add(value);
        return value;
      };
      for (const stepIndex of resolveStepIndexes(scenario.steps.length, mode)) {
        const step = scenario.steps[stepIndex];
        const startedAt = this.now();
        try {
          // eslint-disable-next-line no-await-in-loop -- recorded scenario actions must execute sequentially.
          await raceWithAbort(executeScenarioStep(adapter, step, resolveInputValue), signal);
          actions.push({
            stepId: step.id,
            stepIndex,
            kind: step.kind,
            target: targetForStep(step),
            status: 'passed',
            startedAt,
            finishedAt: this.now(),
          });
        } catch (error) {
          failedStep = stepIndex;
          reason = replaceSecrets(errorMessage(error), secrets);
          status = signal.aborted ? (active.timeoutTriggered ? 'timed-out' : 'cancelled') : 'failed';
          failureCategory = signal.aborted ? (active.timeoutTriggered ? 'timeout' : 'cancelled') : 'interaction';
          actions.push({
            stepId: step.id,
            stepIndex,
            kind: step.kind,
            target: targetForStep(step),
            status,
            startedAt,
            finishedAt: this.now(),
            error: reason,
          });
          break;
        }
      }
    } catch (error) {
      reason = replaceSecrets(errorMessage(error), secrets);
      status = signal.aborted ? (active.timeoutTriggered ? 'timed-out' : 'cancelled') : 'failed';
      failureCategory = signal.aborted ? (active.timeoutTriggered ? 'timeout' : 'cancelled') : 'setup';
    } finally {
      clearTimeout(timer);
    }

    let evidence = EMPTY_RUNTIME_EVIDENCE;
    let evidenceCollectionFailed = false;
    if (adapter?.collectEvidence) {
      try {
        evidence = sanitizeRuntimeEvidence(await adapter.collectEvidence(), secrets);
      } catch (error) {
        evidenceCollectionFailed = true;
        evidence = {
          ...EMPTY_RUNTIME_EVIDENCE,
          consoleErrors: [`Evidence collection failed: ${replaceSecrets(errorMessage(error), secrets)}`],
        };
      }
    }
    if (status === 'passed' && (evidence.consoleErrors.length > 0 || evidence.networkFailures.length > 0)) {
      status = 'failed';
      reason =
        evidence.consoleErrors[0] ?? evidence.networkFailures[0] ?? 'Runtime evidence reported an application failure.';
      failureCategory = evidenceCollectionFailed
        ? 'evidence-collection'
        : evidence.consoleErrors.length > 0
          ? 'runtime-console'
          : 'runtime-network';
    }
    if (adapter?.dispose) {
      try {
        await adapter.dispose();
      } catch {
        // Cleanup failure must not replace the authoritative replay result.
      }
    }

    const finishedAt = this.now();
    const runningSnapshot = active.snapshot;
    const result: ScenarioRunResult = {
      runId: runningSnapshot.runId,
      testId: scenario.id,
      scenarioName: scenario.name,
      rootPath: runningSnapshot.rootPath,
      status,
      startedAt: runningSnapshot.startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - runningSnapshot.startedAt),
      actions,
      failedStep,
      reason,
      evidence,
      assessment: buildRunAssessment({ status, reason, failedStep, actions, evidence, failureCategory }),
    };
    active.snapshot = result;
    active.resolveCompletion(result);
  }
}
