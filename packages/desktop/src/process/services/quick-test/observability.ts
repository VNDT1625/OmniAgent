/**
 * Pure and bounded Quick Test observability helpers. Collection/transport stays outside this
 * module so CDP, native adapters, and tests can provide the same input shapes.
 */

const REDACTED = '[REDACTED]';
const SENSITIVE_NAME =
  /(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key)/i;
const MAX_TEXT = 512;

const finiteNonNegative = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

const boundedLimit = (value: number | undefined, fallback: number, ceiling: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(ceiling, Math.max(0, Math.floor(value)));
};

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1))}…` : value;

const redactObject = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SENSITIVE_NAME.test(key) ? REDACTED : redactObject(child),
    ])
  );
};

/** Redact common credentials without retaining an unbounded payload. */
export const redactObservabilityText = (value: string, maxLength = 8_192): string => {
  const limit = boundedLimit(maxLength, 8_192, 65_536);
  try {
    return truncate(JSON.stringify(redactObject(JSON.parse(value))), limit);
  } catch {
    return truncate(
      value
        .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [REDACTED]')
        .replace(/((?:password|passwd|secret|token|api[-_]?key)\s*[=:]\s*)[^&\s,;]+/gi, '$1[REDACTED]')
        .replace(/([?&](?:password|passwd|secret|token|api[-_]?key)=)[^&#]*/gi, '$1[REDACTED]'),
      limit
    );
  }
};

const redactUrl = (url: string): string =>
  truncate(
    url
      .replace(/\/\/([^/:@\s]+):([^@/\s]+)@/g, `//$1:${REDACTED}@`)
      .replace(/([?&](?:password|passwd|secret|token|api[-_]?key)=)[^&#]*/gi, '$1[REDACTED]'),
    2_048
  );

const sanitizeHeaders = (
  headers: Readonly<Record<string, string>> | undefined,
  maxHeaders: number,
  maxValueLength: number
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(headers ?? {})
      .toSorted(([left], [right]) => left.localeCompare(right))
      .slice(0, maxHeaders)
      .map(([name, value]) => [
        truncate(name, 128),
        SENSITIVE_NAME.test(name) ? REDACTED : redactObservabilityText(value, maxValueLength),
      ])
  );

export type NetworkRequestSample = {
  id: string;
  method: string;
  url: string;
  startedAt: number;
  responseAt?: number;
  finishedAt?: number;
  status?: number;
  resourceType?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  responseHeaders?: Readonly<Record<string, string>>;
  requestBody?: string;
  responseBody?: string;
  transferredBytes?: number;
  initiatorRequestId?: string;
  error?: string;
};

export type NetworkTiming = {
  ttfbMs: number | null;
  downloadMs: number | null;
  durationMs: number | null;
};

export type InspectedNetworkRequest = {
  id: string;
  method: string;
  url: string;
  status: number | null;
  resourceType?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  transferredBytes: number;
  initiatorRequestId?: string;
  error?: string;
  startedAt: number;
  timing: NetworkTiming;
};

export type NetworkDependencyGraph = {
  nodes: Array<{ id: string; method: string; url: string; resourceType?: string }>;
  edges: Array<{ from: string; to: string }>;
};

export type NetworkInspection = {
  requests: InspectedNetworkRequest[];
  dependencyGraph: NetworkDependencyGraph;
  summary: {
    observedCount: number;
    keptCount: number;
    failedCount: number;
    transferredBytes: number;
    slowestRequestId: string | null;
    truncated: boolean;
  };
};

export type NetworkInspectionOptions = {
  maxRequests?: number;
  maxHeaders?: number;
  maxHeaderValueLength?: number;
  maxBodyLength?: number;
  maxEdges?: number;
};

const elapsed = (end: number | null, start: number | null): number | null =>
  end === null || start === null || end < start ? null : end - start;

/** Build a deterministic, redacted and bounded network report. */
export const buildNetworkInspection = (
  samples: readonly NetworkRequestSample[],
  options: NetworkInspectionOptions = {}
): NetworkInspection => {
  const maxRequests = boundedLimit(options.maxRequests, 200, 2_000);
  const maxHeaders = boundedLimit(options.maxHeaders, 40, 200);
  const maxHeaderValueLength = boundedLimit(options.maxHeaderValueLength, 1_024, 8_192);
  const maxBodyLength = boundedLimit(options.maxBodyLength, 8_192, 65_536);
  const maxEdges = boundedLimit(options.maxEdges, 400, 4_000);
  const requests = samples
    .slice(0, maxRequests)
    .map((sample): InspectedNetworkRequest => {
      const start = finiteNonNegative(sample.startedAt) ?? 0;
      const response = finiteNonNegative(sample.responseAt);
      const finish = finiteNonNegative(sample.finishedAt);
      const transferredBytes = finiteNonNegative(sample.transferredBytes) ?? 0;
      return {
        id: truncate(sample.id, 256),
        method: truncate(sample.method.trim().toUpperCase() || 'GET', 32),
        url: redactUrl(sample.url),
        status: finiteNonNegative(sample.status),
        resourceType: sample.resourceType ? truncate(sample.resourceType, 64) : undefined,
        requestHeaders: sanitizeHeaders(sample.requestHeaders, maxHeaders, maxHeaderValueLength),
        responseHeaders: sanitizeHeaders(sample.responseHeaders, maxHeaders, maxHeaderValueLength),
        requestBody:
          sample.requestBody === undefined ? undefined : redactObservabilityText(sample.requestBody, maxBodyLength),
        responseBody:
          sample.responseBody === undefined ? undefined : redactObservabilityText(sample.responseBody, maxBodyLength),
        transferredBytes,
        initiatorRequestId: sample.initiatorRequestId ? truncate(sample.initiatorRequestId, 256) : undefined,
        error: sample.error ? redactObservabilityText(sample.error, MAX_TEXT) : undefined,
        startedAt: start,
        timing: {
          ttfbMs: elapsed(response, start),
          downloadMs: elapsed(finish, response),
          durationMs: elapsed(finish, start),
        },
      };
    })
    .toSorted((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));

  const ids = new Set(requests.map((request) => request.id));
  const allEdges = requests
    .filter(
      (request): request is InspectedNetworkRequest & { initiatorRequestId: string } =>
        request.initiatorRequestId !== undefined &&
        request.initiatorRequestId !== request.id &&
        ids.has(request.initiatorRequestId)
    )
    .map((request) => ({ from: request.initiatorRequestId, to: request.id }))
    .filter(
      (edge, index, all) =>
        all.findIndex((candidate) => candidate.from === edge.from && candidate.to === edge.to) === index
    );
  const edges = allEdges.slice(0, maxEdges);
  const slowest = requests.reduce<InspectedNetworkRequest | null>((current, request) => {
    if (request.timing.durationMs === null) return current;
    if (current?.timing.durationMs === null || current === null) return request;
    return request.timing.durationMs > current.timing.durationMs ? request : current;
  }, null);

  return {
    requests,
    dependencyGraph: {
      nodes: requests.map(({ id, method, url, resourceType }) => ({ id, method, url, resourceType })),
      edges,
    },
    summary: {
      observedCount: samples.length,
      keptCount: requests.length,
      failedCount: requests.filter((request) => request.error !== undefined || (request.status ?? 0) >= 400).length,
      transferredBytes: requests.reduce((sum, request) => sum + request.transferredBytes, 0),
      slowestRequestId: slowest?.id ?? null,
      truncated: samples.length > requests.length || allEdges.length > edges.length,
    },
  };
};

export type ApiMockUrlMatch =
  | { kind: 'exact'; value: string }
  | { kind: 'prefix'; value: string }
  | { kind: 'glob'; value: string };

export type ApiMockRule = {
  id: string;
  enabled?: boolean;
  priority?: number;
  match: {
    method?: string;
    url: ApiMockUrlMatch;
    headers?: Readonly<Record<string, string>>;
    bodyIncludes?: string;
  };
  response: {
    status: number;
    headers?: Readonly<Record<string, string>>;
    body?: string;
    delayMs?: number;
  };
};

export type ApiMockRequest = {
  method: string;
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
};

export type ApiMockMatch = {
  ruleId: string;
  response: { status: number; headers: Record<string, string>; body?: string; delayMs: number };
};

const globMatches = (pattern: string, value: string): boolean => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
};

const urlMatches = (match: ApiMockUrlMatch, url: string): boolean => {
  if (match.kind === 'exact') return url === match.value;
  if (match.kind === 'prefix') return url.startsWith(match.value);
  return globMatches(match.value, url);
};

const matchSpecificity = (match: ApiMockUrlMatch): number =>
  ({ exact: 3_000, prefix: 2_000, glob: 1_000 })[match.kind] + match.value.length;

/** Resolve one API mock using priority, specificity, then rule id as stable tie-breakers. */
export const matchApiMockRule = (
  request: ApiMockRequest,
  rules: readonly ApiMockRule[],
  options: Pick<NetworkInspectionOptions, 'maxHeaders' | 'maxHeaderValueLength' | 'maxBodyLength'> = {}
): ApiMockMatch | null => {
  const requestHeaders = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
  );
  const matching = rules
    .filter((rule) => {
      if (rule.enabled === false) return false;
      if (rule.match.method && rule.match.method.toUpperCase() !== request.method.toUpperCase()) return false;
      if (!urlMatches(rule.match.url, request.url)) return false;
      if (rule.match.bodyIncludes && !request.body?.includes(rule.match.bodyIncludes)) return false;
      return Object.entries(rule.match.headers ?? {}).every(
        ([name, value]) => requestHeaders[name.toLowerCase()] === value
      );
    })
    .toSorted(
      (left, right) =>
        (right.priority ?? 0) - (left.priority ?? 0) ||
        matchSpecificity(right.match.url) - matchSpecificity(left.match.url) ||
        left.id.localeCompare(right.id)
    );
  const winner = matching[0];
  if (!winner) return null;
  const maxHeaders = boundedLimit(options.maxHeaders, 40, 200);
  const maxHeaderValueLength = boundedLimit(options.maxHeaderValueLength, 1_024, 8_192);
  const maxBodyLength = boundedLimit(options.maxBodyLength, 8_192, 65_536);
  return {
    ruleId: truncate(winner.id, 256),
    response: {
      status: Math.min(599, Math.max(100, Math.floor(winner.response.status))),
      headers: sanitizeHeaders(winner.response.headers, maxHeaders, maxHeaderValueLength),
      body:
        winner.response.body === undefined ? undefined : redactObservabilityText(winner.response.body, maxBodyLength),
      delayMs: Math.min(60_000, finiteNonNegative(winner.response.delayMs) ?? 0),
    },
  };
};

export type PerformanceSample =
  | { kind: 'navigation'; startTime: number; domContentLoadedMs?: number; loadMs?: number }
  | {
      kind: 'resource';
      name: string;
      initiatorType: string;
      startTime: number;
      duration: number;
      transferSize?: number;
    }
  | { kind: 'long-task'; startTime: number; duration: number; name?: string }
  | { kind: 'layout-shift'; startTime: number; value: number; hadRecentInput: boolean }
  | { kind: 'paint'; name: 'first-paint' | 'first-contentful-paint'; startTime: number }
  | { kind: 'largest-contentful-paint'; startTime: number; size?: number }
  | { kind: 'interaction'; startTime: number; duration: number; interactionId?: number };

export type PerformanceTimelineEvent = {
  kind: PerformanceSample['kind'];
  at: number;
  durationMs?: number;
  name?: string;
  value?: number;
  transferredBytes?: number;
};

export type MetricRating = 'good' | 'needs-improvement' | 'poor' | 'unknown';
export type PerformanceMetric = { value: number | null; rating: MetricRating };

export type PerformanceTimeline = {
  events: PerformanceTimelineEvent[];
  metrics: {
    fcpMs: PerformanceMetric;
    lcpMs: PerformanceMetric;
    cls: PerformanceMetric;
    inpMs: PerformanceMetric;
    totalBlockingTimeMs: PerformanceMetric;
  };
  summary: {
    observedCount: number;
    processedCount: number;
    keptCount: number;
    resourceCount: number;
    longTaskCount: number;
    totalTransferBytes: number;
    domContentLoadedMs: number | null;
    loadMs: number | null;
    truncated: boolean;
  };
};

export type PerformanceTimelineOptions = { maxInputSamples?: number; maxTimelineEvents?: number };

const metric = (value: number | null, good: number, needsImprovement: number): PerformanceMetric => ({
  value,
  rating:
    value === null ? 'unknown' : value <= good ? 'good' : value <= needsImprovement ? 'needs-improvement' : 'poor',
});

const percentile98 = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.98) - 1)] ?? null;
};

/** Aggregate browser performance entries into bounded evidence and Core Web Vital ratings. */
export const buildPerformanceTimeline = (
  samples: readonly PerformanceSample[],
  options: PerformanceTimelineOptions = {}
): PerformanceTimeline => {
  const maxInputSamples = boundedLimit(options.maxInputSamples, 5_000, 50_000);
  const maxTimelineEvents = boundedLimit(options.maxTimelineEvents, 500, 5_000);
  const processed = samples.slice(0, maxInputSamples);
  const events: PerformanceTimelineEvent[] = [];
  let fcp: number | null = null;
  let lcp: number | null = null;
  let cls = 0;
  let hasCls = false;
  let totalBlockingTime = 0;
  let resourceCount = 0;
  let longTaskCount = 0;
  let totalTransferBytes = 0;
  let domContentLoadedMs: number | null = null;
  let loadMs: number | null = null;
  const interactions: number[] = [];

  for (const sample of processed) {
    const at = finiteNonNegative(sample.startTime);
    if (at === null) continue;
    if (sample.kind === 'navigation') {
      domContentLoadedMs = finiteNonNegative(sample.domContentLoadedMs) ?? domContentLoadedMs;
      loadMs = finiteNonNegative(sample.loadMs) ?? loadMs;
      events.push({ kind: sample.kind, at });
    } else if (sample.kind === 'resource') {
      const duration = finiteNonNegative(sample.duration) ?? 0;
      const transferredBytes = finiteNonNegative(sample.transferSize) ?? 0;
      resourceCount += 1;
      totalTransferBytes += transferredBytes;
      events.push({
        kind: sample.kind,
        at,
        durationMs: duration,
        name: truncate(`${sample.initiatorType}:${redactUrl(sample.name)}`, 512),
        transferredBytes,
      });
    } else if (sample.kind === 'long-task') {
      const duration = finiteNonNegative(sample.duration) ?? 0;
      longTaskCount += 1;
      totalBlockingTime += Math.max(0, duration - 50);
      events.push({
        kind: sample.kind,
        at,
        durationMs: duration,
        name: sample.name ? truncate(sample.name, 128) : undefined,
      });
    } else if (sample.kind === 'layout-shift') {
      const value = finiteNonNegative(sample.value) ?? 0;
      if (!sample.hadRecentInput) {
        cls += value;
        hasCls = true;
      }
      events.push({ kind: sample.kind, at, value });
    } else if (sample.kind === 'paint') {
      if (sample.name === 'first-contentful-paint') fcp = fcp === null ? at : Math.min(fcp, at);
      events.push({ kind: sample.kind, at, name: sample.name });
    } else if (sample.kind === 'largest-contentful-paint') {
      lcp = lcp === null ? at : Math.max(lcp, at);
      events.push({ kind: sample.kind, at, value: finiteNonNegative(sample.size) ?? undefined });
    } else {
      const duration = finiteNonNegative(sample.duration) ?? 0;
      interactions.push(duration);
      events.push({ kind: sample.kind, at, durationMs: duration });
    }
  }

  const keptEvents = events
    .toSorted((left, right) => left.at - right.at || left.kind.localeCompare(right.kind))
    .slice(0, maxTimelineEvents);
  return {
    events: keptEvents,
    metrics: {
      fcpMs: metric(fcp, 1_800, 3_000),
      lcpMs: metric(lcp, 2_500, 4_000),
      cls: metric(hasCls ? Number(cls.toFixed(4)) : null, 0.1, 0.25),
      inpMs: metric(percentile98(interactions), 200, 500),
      totalBlockingTimeMs: metric(Number(totalBlockingTime.toFixed(2)), 200, 600),
    },
    summary: {
      observedCount: samples.length,
      processedCount: processed.length,
      keptCount: keptEvents.length,
      resourceCount,
      longTaskCount,
      totalTransferBytes,
      domContentLoadedMs,
      loadMs,
      truncated: samples.length > processed.length || events.length > keptEvents.length,
    },
  };
};
