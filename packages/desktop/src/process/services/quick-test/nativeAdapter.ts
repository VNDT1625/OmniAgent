import type { RuntimeTrace, TraceEvent, TracePlatform } from '../../ide/quickTestTracer';

export type NativePlatform = Exclude<TracePlatform, 'web'>;

export type NativeTarget =
  | {
      kind: 'android-device';
      serial?: string;
      packageName?: string;
      activity?: string;
    }
  | {
      kind: 'windows-app';
      executablePath?: string;
      processId?: number;
      windowTitle?: string;
    };

export type NativeLocator =
  | { kind: 'accessibility-id'; value: string }
  | { kind: 'resource-id'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'role'; value: string; name?: string }
  | { kind: 'platform-selector'; value: string }
  | { kind: 'coordinates'; x: number; y: number };

export type NativeActionCapability = 'launch' | 'tap' | 'input' | 'back' | 'swipe' | 'assert-visible';

export type NativeScenarioStep =
  | { id: string; kind: 'launch'; timeoutMs?: number }
  | { id: string; kind: 'tap'; locators: readonly NativeLocator[]; timeoutMs?: number }
  | { id: string; kind: 'input'; locators: readonly NativeLocator[]; value: string; redacted: boolean; timeoutMs?: number }
  | { id: string; kind: 'back'; timeoutMs?: number }
  | {
      id: string;
      kind: 'swipe';
      from: { x: number; y: number };
      to: { x: number; y: number };
      durationMs?: number;
      timeoutMs?: number;
    }
  | { id: string; kind: 'assert-visible'; locators: readonly NativeLocator[]; timeoutMs?: number };

export type NativeScenario = {
  version: 1;
  id: string;
  name: string;
  originPlatform: NativePlatform;
  rootPath: string;
  createdAt: number;
  /** Optional recorded target. Callers can override it at run time. */
  target?: NativeTarget;
  steps: readonly NativeScenarioStep[];
};

export type NativeAdapterContext = {
  signal: AbortSignal;
  target?: NativeTarget;
  stepIndex: number;
  deadlineAt: number;
};

export type NativeAutomationAdapter = {
  id: string;
  platforms: readonly NativePlatform[];
  capabilities: ReadonlySet<NativeActionCapability>;
  defaultTimeoutMs?: number;
  execute: (step: NativeScenarioStep, context: NativeAdapterContext) => Promise<void>;
};

export type NativeCompatibilityIssue = {
  stepId?: string;
  code: 'platform-unsupported' | 'target-mismatch' | 'action-unsupported' | 'invalid-timeout';
  message: string;
  capability?: NativeActionCapability;
};

export type NativeStepStatus = 'passed' | 'failed' | 'cancelled' | 'timed-out' | 'unsupported';

export type NativeStepRunResult = {
  stepIndex: number;
  stepId: string;
  kind: NativeActionCapability;
  status: NativeStepStatus;
  startedAt: number;
  finishedAt: number;
  error?: string;
};

export type NativeScenarioRunResult = {
  scenarioId: string;
  adapterId: string;
  platform: NativePlatform;
  target?: NativeTarget;
  status: NativeStepStatus;
  startedAt: number;
  finishedAt: number;
  steps: readonly NativeStepRunResult[];
};

export type RecordNativeScenarioOptions = {
  name?: string;
  createdAt?: number;
  target?: NativeTarget;
  resolveLocators?: (event: Extract<TraceEvent, { kind: 'click' | 'input' }>) => readonly NativeLocator[];
};

export type RunNativeScenarioOptions = {
  signal?: AbortSignal;
  target?: NativeTarget;
  stepTimeoutMs?: number;
  now?: () => number;
};

const DEFAULT_STEP_TIMEOUT_MS = 10_000;
const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_SELECTOR = /(password|passwd|passcode|secret|token|api[-_]?key|credit.?card|\bpin\b)/i;

const stableHash = (value: string): string => {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
};

const nativePlatformForTarget = (target: NativeTarget): NativePlatform =>
  target.kind === 'android-device' ? 'android' : 'windows';

const actionForStep = (step: NativeScenarioStep): NativeActionCapability => step.kind;

const defaultLocators = (event: Extract<TraceEvent, { kind: 'click' | 'input' }>): readonly NativeLocator[] => {
  const locators: NativeLocator[] = [];
  const selector = event.selector.trim();
  if (selector.startsWith('android:id/')) locators.push({ kind: 'resource-id', value: selector });
  if (selector) locators.push({ kind: 'accessibility-id', value: selector });
  if (event.kind === 'click' && event.text?.trim()) locators.push({ kind: 'text', value: event.text.trim() });
  if (selector) locators.push({ kind: 'platform-selector', value: selector });
  return locators;
};

/** Convert native accessibility interactions into a portable, deterministic scenario. */
export const recordNativeScenario = (
  trace: RuntimeTrace,
  options: RecordNativeScenarioOptions = {}
): NativeScenario => {
  if (trace.platform === 'web') throw new TypeError('Native scenarios cannot be recorded from a web trace.');
  const resolveLocators = options.resolveLocators ?? defaultLocators;
  const steps: NativeScenarioStep[] = [];

  for (const event of trace.events) {
    if (event.kind !== 'click' && event.kind !== 'input') continue;
    const locators = resolveLocators(event).filter((locator) =>
      locator.kind === 'coordinates' ? Number.isFinite(locator.x) && Number.isFinite(locator.y) : locator.value.trim().length > 0
    );
    if (!locators.length) continue;
    const ordinal = steps.length;
    if (event.kind === 'click') {
      steps.push({ id: `step-${ordinal}-${stableHash(`tap:${JSON.stringify(locators)}`)}`, kind: 'tap', locators });
      continue;
    }
    const redacted = SENSITIVE_SELECTOR.test(event.selector);
    steps.push({
      id: `step-${ordinal}-${stableHash(`input:${JSON.stringify(locators)}`)}`,
      kind: 'input',
      locators,
      value: redacted ? REDACTED_VALUE : event.value,
      redacted,
    });
  }

  const createdAt = options.createdAt ?? Date.now();
  const identity = `${trace.rootPath}:${trace.platform}:${createdAt}:${steps.map((step) => step.id).join(':')}`;
  return {
    version: 1,
    id: `native-scenario-${stableHash(identity)}`,
    name: options.name?.trim() || `Native Quick Test ${new Date(createdAt).toISOString()}`,
    originPlatform: trace.platform,
    rootPath: trace.rootPath,
    createdAt,
    target: options.target,
    steps,
  };
};

/** Preflight a scenario without touching the target. */
export const inspectNativeScenarioCompatibility = (
  scenario: NativeScenario,
  adapter: NativeAutomationAdapter,
  target: NativeTarget | undefined = scenario.target,
  fallbackTimeoutMs = adapter.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
): NativeCompatibilityIssue[] => {
  const issues: NativeCompatibilityIssue[] = [];
  const platform = target ? nativePlatformForTarget(target) : scenario.originPlatform;
  if (!adapter.platforms.includes(platform)) {
    issues.push({
      code: 'platform-unsupported',
      message: `Adapter ${adapter.id} does not support ${platform}.`,
    });
  }
  if (target && nativePlatformForTarget(target) !== platform) {
    issues.push({ code: 'target-mismatch', message: `Target ${target.kind} cannot run on ${platform}.` });
  }
  if (!Number.isFinite(fallbackTimeoutMs) || fallbackTimeoutMs <= 0) {
    issues.push({ code: 'invalid-timeout', message: 'The native step timeout must be greater than zero.' });
  }
  for (const step of scenario.steps) {
    const capability = actionForStep(step);
    if (!adapter.capabilities.has(capability)) {
      issues.push({
        stepId: step.id,
        code: 'action-unsupported',
        capability,
        message: `Adapter ${adapter.id} does not support ${capability} for step ${step.id}.`,
      });
    }
    if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) {
      issues.push({
        stepId: step.id,
        code: 'invalid-timeout',
        message: `Step ${step.id} must use a timeout greater than zero.`,
      });
    }
  }
  return issues;
};

class NativeCancelledError extends Error {
  constructor() {
    super('Native scenario replay was cancelled.');
    this.name = 'NativeCancelledError';
  }
}

class NativeTimeoutError extends Error {
  constructor(stepId: string, timeoutMs: number) {
    super(`Native step ${stepId} timed out after ${timeoutMs}ms.`);
    this.name = 'NativeTimeoutError';
  }
}

const runWithDeadline = async (
  adapter: NativeAutomationAdapter,
  step: NativeScenarioStep,
  context: Omit<NativeAdapterContext, 'signal'>,
  timeoutMs: number,
  parentSignal?: AbortSignal
): Promise<void> => {
  if (parentSignal?.aborted) throw new NativeCancelledError();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new NativeTimeoutError(step.id, timeoutMs));
    }, timeoutMs);
  });
  const cancellation = new Promise<never>((_resolve, reject) => {
    if (!parentSignal) return;
    onAbort = (): void => {
      controller.abort();
      reject(new NativeCancelledError());
    };
    parentSignal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    await Promise.race([adapter.execute(step, { ...context, signal: controller.signal }), timeout, cancellation]);
  } finally {
    if (timer) clearTimeout(timer);
    if (parentSignal && onAbort) parentSignal.removeEventListener('abort', onAbort);
  }
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Replay sequentially so adapter calls and results are deterministic across desktop and mobile. */
export const runNativeScenario = async (
  scenario: NativeScenario,
  adapter: NativeAutomationAdapter,
  options: RunNativeScenarioOptions = {}
): Promise<NativeScenarioRunResult> => {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const target = options.target ?? scenario.target;
  const platform = target ? nativePlatformForTarget(target) : scenario.originPlatform;
  const fallbackTimeoutMs = options.stepTimeoutMs ?? adapter.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const issues = inspectNativeScenarioCompatibility(scenario, adapter, target, fallbackTimeoutMs);
  const blocking = issues[0];
  if (blocking) {
    const stepIndex = blocking.stepId ? scenario.steps.findIndex((step) => step.id === blocking.stepId) : 0;
    const step = scenario.steps[Math.max(0, stepIndex)];
    const finishedAt = now();
    return {
      scenarioId: scenario.id,
      adapterId: adapter.id,
      platform,
      target,
      status: 'unsupported',
      startedAt,
      finishedAt,
      steps: step
        ? [
            {
              stepIndex: Math.max(0, stepIndex),
              stepId: step.id,
              kind: actionForStep(step),
              status: 'unsupported',
              startedAt,
              finishedAt,
              error: blocking.message,
            },
          ]
        : [],
    };
  }

  const results: NativeStepRunResult[] = [];
  for (const [stepIndex, step] of scenario.steps.entries()) {
    const stepStartedAt = now();
    const timeoutMs = step.timeoutMs ?? fallbackTimeoutMs;
    try {
      // Native replay must preserve the exact recorded action order.
      // eslint-disable-next-line no-await-in-loop
      await runWithDeadline(adapter, step, { target, stepIndex, deadlineAt: stepStartedAt + timeoutMs }, timeoutMs, options.signal);
      results.push({
        stepIndex,
        stepId: step.id,
        kind: actionForStep(step),
        status: 'passed',
        startedAt: stepStartedAt,
        finishedAt: now(),
      });
    } catch (error) {
      const status: NativeStepStatus =
        error instanceof NativeCancelledError
          ? 'cancelled'
          : error instanceof NativeTimeoutError
            ? 'timed-out'
            : 'failed';
      results.push({
        stepIndex,
        stepId: step.id,
        kind: actionForStep(step),
        status,
        startedAt: stepStartedAt,
        finishedAt: now(),
        error: messageOf(error),
      });
      return {
        scenarioId: scenario.id,
        adapterId: adapter.id,
        platform,
        target,
        status,
        startedAt,
        finishedAt: now(),
        steps: results,
      };
    }
  }

  return {
    scenarioId: scenario.id,
    adapterId: adapter.id,
    platform,
    target,
    status: 'passed',
    startedAt,
    finishedAt: now(),
    steps: results,
  };
};

export { REDACTED_VALUE as NATIVE_REDACTED_VALUE };
