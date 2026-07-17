import type { RuntimeTrace, TracePlatform } from './quickTestTracer';

export type ReplayStep =
  | { id: string; kind: 'navigate'; url: string; sourceAt: number }
  | { id: string; kind: 'click'; selector: string; sourceAt: number }
  | { id: string; kind: 'input'; selector: string; value: string; redacted: boolean; sourceAt: number };

export type ReplayRunRecipe = {
  mode: 'frontend' | 'full' | 'services';
  serviceIds?: string[];
  url?: string;
};

export type ReplayScenario = {
  version: 1;
  id: string;
  name: string;
  platform: TracePlatform;
  rootPath: string;
  target?: string;
  run?: ReplayRunRecipe;
  createdAt: number;
  steps: ReplayStep[];
};

export type ReplayRunMode =
  | { kind: 'full' }
  | { kind: 'from-step'; stepIndex: number }
  | { kind: 'single-step'; stepIndex: number };

export type ReplayStepEvidence = {
  pageUrl?: string;
  pageTitle?: string;
  activeElement?: string;
  target?: {
    selector: string;
    exists: boolean;
    tagName?: string;
    role?: string;
    text?: string;
    rect?: { x: number; y: number; width: number; height: number };
  };
  screenshotPath?: string;
  collectionError?: string;
};

export type ReplayEvidenceContext = {
  stepIndex: number;
  step: ReplayStep;
  status: 'passed' | 'failed';
  error?: string;
};

export type ReplayStepResult = {
  stepIndex: number;
  step: ReplayStep;
  status: 'passed' | 'failed';
  startedAt: number;
  finishedAt: number;
  error?: string;
  evidence?: ReplayStepEvidence;
};

export type ReplayRunResult = {
  scenarioId: string;
  status: 'passed' | 'failed';
  startedAt: number;
  finishedAt: number;
  steps: ReplayStepResult[];
};

export type ReplayPageAdapter = {
  navigate: (url: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  input: (selector: string, value: string) => Promise<void>;
  collectStepEvidence?: (context: ReplayEvidenceContext) => Promise<ReplayStepEvidence | undefined>;
};

export type CreateReplayScenarioOptions = {
  name?: string;
  createdAt?: number;
  run?: ReplayRunRecipe;
};

const MAX_SELECTOR_LENGTH = 2_048;
const MAX_URL_LENGTH = 8_192;
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

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
};

export const isValidReplaySelector = (selector: string): boolean => {
  const value = selector.trim();
  if (!value || value.length > MAX_SELECTOR_LENGTH || hasControlCharacter(value)) return false;

  let brackets = 0;
  let parentheses = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') brackets += 1;
    if (character === ']') brackets -= 1;
    if (character === '(') parentheses += 1;
    if (character === ')') parentheses -= 1;
    if (brackets < 0 || parentheses < 0) return false;
  }
  return !quote && !escaped && brackets === 0 && parentheses === 0;
};

export const isValidReplayUrl = (url: string): boolean => {
  const value = url.trim();
  if (!value || value.length > MAX_URL_LENGTH || hasControlCharacter(value)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

export const isSensitiveReplaySelector = (selector: string): boolean =>
  SENSITIVE_SELECTOR.test(selector) || /\[type\s*=\s*['"]?password/i.test(selector);

export const createReplayScenario = (
  trace: RuntimeTrace,
  options: CreateReplayScenarioOptions = {}
): ReplayScenario => {
  const steps: ReplayStep[] = [];
  for (const event of trace.events) {
    const ordinal = steps.length;
    if (event.kind === 'navigate' && isValidReplayUrl(event.url)) {
      steps.push({
        id: `step-${ordinal}-${stableHash(`navigate:${event.url}`)}`,
        kind: 'navigate',
        url: event.url.trim(),
        sourceAt: event.at,
      });
    } else if (event.kind === 'click' && isValidReplaySelector(event.selector)) {
      const selector = event.selector.trim();
      steps.push({
        id: `step-${ordinal}-${stableHash(`click:${selector}`)}`,
        kind: 'click',
        selector,
        sourceAt: event.at,
      });
    } else if (event.kind === 'input' && isValidReplaySelector(event.selector)) {
      const selector = event.selector.trim();
      const redacted = isSensitiveReplaySelector(selector);
      steps.push({
        id: `step-${ordinal}-${stableHash(`input:${selector}`)}`,
        kind: 'input',
        selector,
        value: redacted ? REDACTED_VALUE : event.value,
        redacted,
        sourceAt: event.at,
      });
    }
  }

  const createdAt = options.createdAt ?? Date.now();
  const target = trace.target?.trim();
  const identity = `${trace.rootPath}:${trace.platform}:${target ?? ''}:${createdAt}:${steps.map((step) => step.id).join(':')}`;
  return {
    version: 1,
    id: `scenario-${stableHash(identity)}`,
    name: options.name?.trim() || `Quick Test ${new Date(createdAt).toISOString()}`,
    platform: trace.platform,
    rootPath: trace.rootPath,
    ...(target ? { target } : {}),
    ...(options.run ? { run: options.run } : {}),
    createdAt,
    steps,
  };
};

const resolveStepIndexes = (stepCount: number, mode: ReplayRunMode): number[] => {
  if (mode.kind === 'full') return Array.from({ length: stepCount }, (_, index) => index);
  if (!Number.isInteger(mode.stepIndex) || mode.stepIndex < 0 || mode.stepIndex >= stepCount) {
    throw new RangeError(`Replay step index ${mode.stepIndex} is outside the scenario.`);
  }
  if (mode.kind === 'single-step') return [mode.stepIndex];
  return Array.from({ length: stepCount - mode.stepIndex }, (_, index) => index + mode.stepIndex);
};

const executeStep = async (adapter: ReplayPageAdapter, step: ReplayStep): Promise<void> => {
  if (step.kind === 'navigate') {
    if (!isValidReplayUrl(step.url)) throw new Error(`Unsafe replay URL: ${step.url}`);
    await adapter.navigate(step.url);
    return;
  }
  if (!isValidReplaySelector(step.selector)) throw new Error(`Invalid replay selector: ${step.selector}`);
  if (step.kind === 'click') {
    await adapter.click(step.selector);
    return;
  }
  if (step.redacted)
    throw new Error(`Input value for ${step.selector} is redacted and must be supplied before replay.`);
  await adapter.input(step.selector, step.value);
};

const collectStepEvidence = async (
  adapter: ReplayPageAdapter,
  context: ReplayEvidenceContext
): Promise<ReplayStepEvidence | undefined> => {
  if (!adapter.collectStepEvidence) return undefined;
  try {
    return await adapter.collectStepEvidence(context);
  } catch (error) {
    return { collectionError: errorMessage(error) };
  }
};

export const replayScenario = async (
  scenario: ReplayScenario,
  adapter: ReplayPageAdapter,
  mode: ReplayRunMode = { kind: 'full' },
  now: () => number = Date.now
): Promise<ReplayRunResult> => {
  const startedAt = now();
  const results: ReplayStepResult[] = [];
  for (const stepIndex of resolveStepIndexes(scenario.steps.length, mode)) {
    const step = scenario.steps[stepIndex];
    const stepStartedAt = now();
    try {
      // eslint-disable-next-line no-await-in-loop -- replay must preserve the recorded action order.
      await executeStep(adapter, step);
      const finishedAt = now();
      // eslint-disable-next-line no-await-in-loop -- evidence must be attributed before the next action changes the page.
      const evidence = await collectStepEvidence(adapter, { stepIndex, step, status: 'passed' });
      results.push({
        stepIndex,
        step,
        status: 'passed',
        startedAt: stepStartedAt,
        finishedAt,
        ...(evidence ? { evidence } : {}),
      });
    } catch (error) {
      const message = errorMessage(error);
      const finishedAt = now();
      // eslint-disable-next-line no-await-in-loop -- capture the failure state before returning the replay result.
      const evidence = await collectStepEvidence(adapter, { stepIndex, step, status: 'failed', error: message });
      results.push({
        stepIndex,
        step,
        status: 'failed',
        startedAt: stepStartedAt,
        finishedAt,
        error: message,
        ...(evidence ? { evidence } : {}),
      });
      return {
        scenarioId: scenario.id,
        status: 'failed',
        startedAt,
        finishedAt: now(),
        steps: results,
      };
    }
  }
  return {
    scenarioId: scenario.id,
    status: 'passed',
    startedAt,
    finishedAt: now(),
    steps: results,
  };
};

export { REDACTED_VALUE as REPLAY_REDACTED_VALUE };
