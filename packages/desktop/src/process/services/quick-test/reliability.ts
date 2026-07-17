/** Pure reliability analysis for Quick Test. IO is injected by callers. */

export type ReliabilityRunStatus = 'passed' | 'failed' | 'cancelled' | 'timed-out';
export type ReliabilityError = {
  kind?: string;
  message: string;
  code?: string | number;
  stack?: string;
  source?: string;
};
export type ReliabilityRun = {
  runId: string;
  testId: string;
  status: ReliabilityRunStatus;
  startedAt: number;
  finishedAt: number;
  errors?: readonly ReliabilityError[];
};
export type ReliabilityClassification = 'insufficient' | 'stable-passing' | 'stable-failing' | 'flaky';
export type DurationStatistics = {
  minimumMs: number;
  maximumMs: number;
  averageMs: number;
  medianMs: number;
  p95Ms: number;
};
export type ReliabilitySummary = {
  testId: string;
  classification: ReliabilityClassification;
  retainedRuns: number;
  conclusiveRuns: number;
  passedRuns: number;
  failedRuns: number;
  interruptedRuns: number;
  passRate: number;
  failureRate: number;
  transitionCount: number;
  transitionRate: number;
  durations: DurationStatistics | null;
  firstRunAt: number | null;
  lastRunAt: number | null;
};
export type ReliabilityAnalysisOptions = { maxRuns?: number; minimumConclusiveRuns?: number };

const DEFAULT_MAX_RUNS = 50;
const MAX_RUN_LIMIT = 1_000;
const DEFAULT_MINIMUM_RUNS = 3;
const REDACTED = '[REDACTED]';

const boundedInteger = (value: number | undefined, fallback: number, maximum: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
};
const roundRate = (value: number): number => Math.round(value * 10_000) / 10_000;
const orderedRuns = (runs: readonly ReliabilityRun[], maximum: number): ReliabilityRun[] =>
  [...runs]
    .toSorted((left, right) => left.startedAt - right.startedAt || left.runId.localeCompare(right.runId))
    .slice(-maximum);
const durationsFor = (runs: readonly ReliabilityRun[]): DurationStatistics | null => {
  if (runs.length === 0) return null;
  const values = runs.map((run) => Math.max(0, run.finishedAt - run.startedAt)).toSorted((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  const median =
    values.length % 2 === 0 ? ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2 : (values[middle] ?? 0);
  return {
    minimumMs: values[0] ?? 0,
    maximumMs: values.at(-1) ?? 0,
    averageMs: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
    medianMs: median,
    p95Ms: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0,
  };
};

/** Analyze repeated outcomes and identify tests that alternate between pass and failure. */
export function analyzeRepeatedRuns(
  testId: string,
  runs: readonly ReliabilityRun[],
  options: ReliabilityAnalysisOptions = {}
): ReliabilitySummary {
  const maximum = boundedInteger(options.maxRuns, DEFAULT_MAX_RUNS, MAX_RUN_LIMIT);
  const minimum = boundedInteger(options.minimumConclusiveRuns, DEFAULT_MINIMUM_RUNS, MAX_RUN_LIMIT);
  const retained = orderedRuns(
    runs.filter((run) => run.testId === testId),
    maximum
  );
  const conclusive = retained.filter((run) => run.status === 'passed' || run.status === 'failed');
  const passedRuns = conclusive.filter((run) => run.status === 'passed').length;
  const failedRuns = conclusive.length - passedRuns;
  let transitionCount = 0;
  for (let index = 1; index < conclusive.length; index += 1) {
    if (conclusive[index]?.status !== conclusive[index - 1]?.status) transitionCount += 1;
  }
  let classification: ReliabilityClassification = 'insufficient';
  if (conclusive.length >= minimum) {
    classification = passedRuns > 0 && failedRuns > 0 ? 'flaky' : passedRuns > 0 ? 'stable-passing' : 'stable-failing';
  }
  return {
    testId,
    classification,
    retainedRuns: retained.length,
    conclusiveRuns: conclusive.length,
    passedRuns,
    failedRuns,
    interruptedRuns: retained.length - conclusive.length,
    passRate: conclusive.length === 0 ? 0 : roundRate(passedRuns / conclusive.length),
    failureRate: conclusive.length === 0 ? 0 : roundRate(failedRuns / conclusive.length),
    transitionCount,
    transitionRate: conclusive.length < 2 ? 0 : roundRate(transitionCount / (conclusive.length - 1)),
    durations: durationsFor(retained),
    firstRunAt: retained[0]?.startedAt ?? null,
    lastRunAt: retained.at(-1)?.startedAt ?? null,
  };
}

const normalizeErrorText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/https?:\/\/[^\s)]+/g, '<url>')
    .replace(/[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}/gi, '<uuid>')
    .replace(/(?:[a-z]:\\|\/)[^\s():]+(?::\d+(?::\d+)?)?/gi, '<path>')
    .replace(/\b0x[a-f\d]+\b/gi, '<hex>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_000);
const fnv1a = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
export type ErrorFingerprint = { id: string; signature: string; normalizedMessage: string };
export function fingerprintReliabilityError(error: ReliabilityError): ErrorFingerprint {
  const normalizedMessage = normalizeErrorText(error.message);
  const stackHead = normalizeErrorText(error.stack?.split(String.fromCharCode(10)).slice(0, 3).join(' ') ?? '');
  const signature = [error.kind ?? 'error', error.code ?? '', error.source ?? '', normalizedMessage, stackHead]
    .map((part) => normalizeErrorText(String(part)))
    .join('|');
  return { id: 'error-' + fnv1a(signature), signature, normalizedMessage };
}
export type ErrorClusterSample = { runId: string; message: string; startedAt: number };
export type ErrorCluster = {
  fingerprint: string;
  signature: string;
  normalizedMessage: string;
  occurrenceCount: number;
  affectedRunCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  samples: ErrorClusterSample[];
};
export type ErrorClusterOptions = { maxRuns?: number; maxClusters?: number; maxSamplesPerCluster?: number };
type MutableCluster = ErrorCluster & { runIds: Set<string> };

/** Cluster equivalent failures across a bounded run window. */
export function clusterReliabilityErrors(
  runs: readonly ReliabilityRun[],
  options: ErrorClusterOptions = {}
): ErrorCluster[] {
  const retained = orderedRuns(runs, boundedInteger(options.maxRuns, DEFAULT_MAX_RUNS, MAX_RUN_LIMIT));
  const maximumClusters = boundedInteger(options.maxClusters, 20, 200);
  const maximumSamples = boundedInteger(options.maxSamplesPerCluster, 3, 20);
  const clusters = new Map<string, MutableCluster>();
  for (const run of retained) {
    for (const error of run.errors ?? []) {
      const fingerprint = fingerprintReliabilityError(error);
      const current = clusters.get(fingerprint.id);
      if (current) {
        current.occurrenceCount += 1;
        current.runIds.add(run.runId);
        current.affectedRunCount = current.runIds.size;
        current.lastSeenAt = Math.max(current.lastSeenAt, run.startedAt);
        if (current.samples.length < maximumSamples) {
          current.samples.push({ runId: run.runId, message: error.message.slice(0, 2_000), startedAt: run.startedAt });
        }
      } else {
        clusters.set(fingerprint.id, {
          fingerprint: fingerprint.id,
          signature: fingerprint.signature,
          normalizedMessage: fingerprint.normalizedMessage,
          occurrenceCount: 1,
          affectedRunCount: 1,
          firstSeenAt: run.startedAt,
          lastSeenAt: run.startedAt,
          samples: [{ runId: run.runId, message: error.message.slice(0, 2_000), startedAt: run.startedAt }],
          runIds: new Set([run.runId]),
        });
      }
    }
  }
  return [...clusters.values()]
    .toSorted(
      (a, b) =>
        b.affectedRunCount - a.affectedRunCount || b.occurrenceCount - a.occurrenceCount || b.lastSeenAt - a.lastSeenAt
    )
    .slice(0, maximumClusters)
    .map(({ runIds: _runIds, ...cluster }) => cluster);
}

export type ReliabilityTrackerOptions = ReliabilityAnalysisOptions & { maxStoredRuns?: number };
/** Bounded in-memory retention for incremental agent workflows. */
export class QuickTestReliabilityTracker {
  readonly #maximum: number;
  readonly #minimum: number;
  #runs: ReliabilityRun[] = [];
  constructor(options: ReliabilityTrackerOptions = {}) {
    this.#maximum = boundedInteger(options.maxStoredRuns ?? options.maxRuns, DEFAULT_MAX_RUNS, MAX_RUN_LIMIT);
    this.#minimum = boundedInteger(options.minimumConclusiveRuns, DEFAULT_MINIMUM_RUNS, MAX_RUN_LIMIT);
  }
  record(run: ReliabilityRun): void {
    const copy = { ...run, errors: run.errors?.map((error) => ({ ...error })) };
    this.#runs = orderedRuns([...this.#runs.filter((candidate) => candidate.runId !== run.runId), copy], this.#maximum);
  }
  runs(testId?: string): ReliabilityRun[] {
    return this.#runs
      .filter((run) => testId === undefined || run.testId === testId)
      .map((run) => ({
        runId: run.runId,
        testId: run.testId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        errors: run.errors?.map((error) => ({ ...error })),
      }));
  }
  analyze(testId: string): ReliabilitySummary {
    return analyzeRepeatedRuns(testId, this.#runs, { maxRuns: this.#maximum, minimumConclusiveRuns: this.#minimum });
  }
  clusters(testId?: string, options: Omit<ErrorClusterOptions, 'maxRuns'> = {}): ErrorCluster[] {
    return clusterReliabilityErrors(this.runs(testId), { ...options, maxRuns: this.#maximum });
  }
  clear(testId?: string): void {
    this.#runs = testId === undefined ? [] : this.#runs.filter((run) => run.testId !== testId);
  }
}

export type EnvironmentDependency = { name: string; version: string; source?: string };
export type EnvironmentService = {
  name: string;
  status: 'running' | 'stopped' | 'unknown';
  port?: number;
  pid?: number;
};
export type EnvironmentPort = { port: number; host?: string; process?: string; state?: string };
export type EnvironmentGit = {
  commit?: string;
  branch?: string;
  dirty: boolean;
  changedFiles?: readonly string[];
};
export type EnvironmentPlatform = {
  os: string;
  arch: string;
  release?: string;
  runtimeVersions?: Readonly<Record<string, string>>;
};
export type EnvironmentSection = 'git' | 'dependencies' | 'services' | 'ports' | 'platform' | 'environment';
export type EnvironmentSnapshot = {
  capturedAt: number;
  git: EnvironmentGit | null;
  dependencies: EnvironmentDependency[];
  services: EnvironmentService[];
  ports: EnvironmentPort[];
  platform: EnvironmentPlatform | null;
  environment: Record<string, string>;
  warnings: EnvironmentSection[];
};
type MaybePromise<T> = T | Promise<T>;
export type EnvironmentSnapshotProviders = {
  git?: () => MaybePromise<EnvironmentGit>;
  dependencies?: () => MaybePromise<readonly EnvironmentDependency[]>;
  services?: () => MaybePromise<readonly EnvironmentService[]>;
  ports?: () => MaybePromise<readonly EnvironmentPort[]>;
  platform?: () => MaybePromise<EnvironmentPlatform>;
  environment?: () => MaybePromise<Readonly<Record<string, string | undefined>>>;
  now?: () => number;
};
export type EnvironmentSnapshotOptions = {
  maxDependencies?: number;
  maxServices?: number;
  maxPorts?: number;
  maxChangedFiles?: number;
  maxEnvironmentEntries?: number;
};

const SENSITIVE_ENV_KEY =
  /(?:^|_)(?:api_?key|authorization|cookie|credential|jwt|pass(?:word)?|private_?key|secret|session|token)(?:_|$)/i;
const redactEmbeddedSecrets = (value: string): string =>
  value
    .replace(/(bearer\s+)[^\s]+/gi, '$1' + REDACTED)
    .replace(/([?&](?:api_?key|password|secret|token)=)[^&\s]*/gi, '$1' + REDACTED)
    .replace(/(https?:\/\/[^\s/:@]+:)[^\s@]+@/gi, '$1' + REDACTED + '@')
    .slice(0, 4_096);

/** Redact secret-bearing keys and embedded credentials while retaining useful context. */
export function redactEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  maxEntries = 100
): Record<string, string> {
  const limit = boundedInteger(maxEntries, 100, 1_000);
  return Object.fromEntries(
    Object.entries(environment)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .toSorted(([left], [right]) => left.localeCompare(right))
      .slice(0, limit)
      .map(([key, value]) => [key.slice(0, 256), SENSITIVE_ENV_KEY.test(key) ? REDACTED : redactEmbeddedSecrets(value)])
  );
}

const collectSection = async <T>(
  section: EnvironmentSection,
  provider: (() => MaybePromise<T>) | undefined,
  fallback: T,
  warnings: EnvironmentSection[]
): Promise<T> => {
  if (!provider) return fallback;
  try {
    return await provider();
  } catch {
    warnings.push(section);
    return fallback;
  }
};

/** Build a bounded, secret-safe snapshot from injected environment collectors. */
export async function buildEnvironmentSnapshot(
  providers: EnvironmentSnapshotProviders,
  options: EnvironmentSnapshotOptions = {}
): Promise<EnvironmentSnapshot> {
  const warnings: EnvironmentSection[] = [];
  const [git, dependencies, services, ports, platform, environment] = await Promise.all([
    collectSection('git', providers.git, null, warnings),
    collectSection<readonly EnvironmentDependency[]>('dependencies', providers.dependencies, [], warnings),
    collectSection<readonly EnvironmentService[]>('services', providers.services, [], warnings),
    collectSection<readonly EnvironmentPort[]>('ports', providers.ports, [], warnings),
    collectSection('platform', providers.platform, null, warnings),
    collectSection<Readonly<Record<string, string | undefined>>>('environment', providers.environment, {}, warnings),
  ]);
  const dependencyLimit = boundedInteger(options.maxDependencies, 200, 1_000);
  const serviceLimit = boundedInteger(options.maxServices, 50, 500);
  const portLimit = boundedInteger(options.maxPorts, 100, 1_000);
  const fileLimit = boundedInteger(options.maxChangedFiles, 100, 1_000);

  return {
    capturedAt: providers.now?.() ?? Date.now(),
    git: git
      ? {
          ...git,
          commit: git.commit?.slice(0, 128),
          branch: git.branch?.slice(0, 256),
          changedFiles: git.changedFiles?.slice(0, fileLimit).map((file) => file.slice(0, 2_000)),
        }
      : null,
    dependencies: dependencies.slice(0, dependencyLimit).map((dependency) => ({
      name: dependency.name.slice(0, 256),
      version: dependency.version.slice(0, 128),
      source: dependency.source?.slice(0, 256),
    })),
    services: services.slice(0, serviceLimit).map((service) => ({
      name: service.name.slice(0, 256),
      status: service.status,
      port: service.port,
      pid: service.pid,
    })),
    ports: ports.slice(0, portLimit).map((port) => ({
      port: port.port,
      host: port.host?.slice(0, 256),
      process: port.process?.slice(0, 256),
      state: port.state?.slice(0, 64),
    })),
    platform: platform
      ? {
          ...platform,
          os: platform.os.slice(0, 128),
          arch: platform.arch.slice(0, 128),
          release: platform.release?.slice(0, 128),
          runtimeVersions: platform.runtimeVersions
            ? Object.fromEntries(Object.entries(platform.runtimeVersions).slice(0, 50))
            : undefined,
        }
      : null,
    environment: redactEnvironment(environment, options.maxEnvironmentEntries),
    warnings: [...new Set(warnings)].toSorted(),
  };
}
