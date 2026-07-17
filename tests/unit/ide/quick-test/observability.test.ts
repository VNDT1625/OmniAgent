import { describe, expect, it } from 'vitest';

import {
  buildNetworkInspection,
  buildPerformanceTimeline,
  matchApiMockRule,
  redactObservabilityText,
  type ApiMockRule,
  type NetworkRequestSample,
  type PerformanceSample,
} from '../../../../packages/desktop/src/process/services/quick-test/observability';

const request = (overrides: Partial<NetworkRequestSample> = {}): NetworkRequestSample => ({
  id: 'root',
  method: 'get',
  url: 'https://app.test/api/items',
  startedAt: 100,
  responseAt: 140,
  finishedAt: 180,
  status: 200,
  transferredBytes: 512,
  ...overrides,
});

describe('Quick Test network inspection', () => {
  it('summarizes timing, failures, transfer size and the slowest request', () => {
    const result = buildNetworkInspection([
      request(),
      request({ id: 'slow', startedAt: 200, responseAt: 260, finishedAt: 400, status: 503, transferredBytes: 256 }),
    ]);

    expect(result.requests[0]?.timing).toEqual({ ttfbMs: 40, downloadMs: 40, durationMs: 80 });
    expect(result.summary).toMatchObject({ failedCount: 1, transferredBytes: 768, slowestRequestId: 'slow' });
  });

  it('redacts credentials from URLs, headers, JSON bodies and errors', () => {
    const result = buildNetworkInspection([
      request({
        url: 'https://user:pass@app.test/data?token=top-secret&ok=1',
        requestHeaders: { Authorization: 'Bearer abc', Accept: 'application/json' },
        responseHeaders: { 'Set-Cookie': 'sid=abc', Server: 'test' },
        requestBody: JSON.stringify({ profile: { password: 'pw', name: 'Aion' } }),
        responseBody: 'token=raw-token',
        error: 'Bearer private-token failed',
      }),
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/top-secret|Bearer abc|sid=abc|"pw"|raw-token|private-token/);
    expect(serialized).toContain('[REDACTED]');
  });

  it('creates only valid dependency edges in stable timeline order', () => {
    const result = buildNetworkInspection([
      request({ id: 'child', startedAt: 200, initiatorRequestId: 'root' }),
      request({ id: 'orphan', startedAt: 300, initiatorRequestId: 'missing' }),
      request({ id: 'root', startedAt: 100 }),
    ]);

    expect(result.requests.map((entry) => entry.id)).toEqual(['root', 'child', 'orphan']);
    expect(result.dependencyGraph.edges).toEqual([{ from: 'root', to: 'child' }]);
  });

  it('bounds requests, headers, bodies and dependency edges', () => {
    const samples = Array.from({ length: 5 }, (_, index) =>
      request({
        id: String(index),
        initiatorRequestId: index === 0 ? undefined : String(index - 1),
        requestHeaders: { A: '1', B: '2' },
        responseBody: '123456789',
      })
    );
    const result = buildNetworkInspection(samples, {
      maxRequests: 3,
      maxHeaders: 1,
      maxBodyLength: 5,
      maxEdges: 1,
    });

    expect(result.requests).toHaveLength(3);
    expect(Object.keys(result.requests[0]?.requestHeaders ?? {})).toHaveLength(1);
    expect(result.requests[0]?.responseBody).toHaveLength(5);
    expect(result.summary.truncated).toBe(true);
  });

  it('does not manufacture invalid transfer values', () => {
    const result = buildNetworkInspection([request({ transferredBytes: -1 })]);

    expect(result.summary.transferredBytes).toBe(0);
  });
});

describe('Quick Test deterministic API mocks', () => {
  const rules: ApiMockRule[] = [
    {
      id: 'glob',
      match: { url: { kind: 'glob', value: 'https://api.test/items/*' } },
      response: { status: 200, body: '{"source":"glob"}' },
    },
    {
      id: 'exact',
      match: { method: 'GET', url: { kind: 'exact', value: 'https://api.test/items/42' } },
      response: { status: 201, body: '{"source":"exact"}' },
    },
  ];

  it('prefers the most specific URL independent of input order', () => {
    const first = matchApiMockRule({ method: 'get', url: 'https://api.test/items/42' }, rules);
    const reversed = matchApiMockRule({ method: 'GET', url: 'https://api.test/items/42' }, rules.toReversed());

    expect(first?.ruleId).toBe('exact');
    expect(reversed?.ruleId).toBe('exact');
  });

  it('lets explicit priority override URL specificity', () => {
    const prioritized = rules.map((rule) => (rule.id === 'glob' ? { ...rule, priority: 10 } : rule));

    expect(matchApiMockRule({ method: 'GET', url: 'https://api.test/items/42' }, prioritized)?.ruleId).toBe('glob');
  });

  it('matches headers and body while skipping disabled rules', () => {
    const conditional: ApiMockRule[] = [
      { ...rules[1]!, id: 'disabled', enabled: false, priority: 99 },
      {
        id: 'conditional',
        match: {
          method: 'POST',
          url: { kind: 'prefix', value: 'https://api.test/items' },
          headers: { 'x-mode': 'test' },
          bodyIncludes: 'needle',
        },
        response: { status: 200 },
      },
    ];

    expect(
      matchApiMockRule(
        { method: 'POST', url: 'https://api.test/items', headers: { 'X-Mode': 'test' }, body: 'a needle b' },
        conditional
      )?.ruleId
    ).toBe('conditional');
    expect(matchApiMockRule({ method: 'POST', url: 'https://api.test/items' }, conditional)).toBeNull();
  });

  it('redacts and bounds the selected mock response', () => {
    const result = matchApiMockRule(
      { method: 'GET', url: '/secret' },
      [
        {
          id: 'secret',
          match: { url: { kind: 'exact', value: '/secret' } },
          response: {
            status: 999,
            headers: { Authorization: 'Bearer private' },
            body: '{"token":"private","value":"123456"}',
            delayMs: 999_999,
          },
        },
      ],
      { maxBodyLength: 20 }
    );

    expect(result?.response).toMatchObject({ status: 599, delayMs: 60_000 });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});

describe('Quick Test performance timeline', () => {
  it('aggregates navigation, resources, blocking time and Core Web Vitals', () => {
    const samples: PerformanceSample[] = [
      { kind: 'navigation', startTime: 0, domContentLoadedMs: 900, loadMs: 1_500 },
      { kind: 'paint', name: 'first-contentful-paint', startTime: 1_000 },
      { kind: 'largest-contentful-paint', startTime: 2_600, size: 400 },
      { kind: 'layout-shift', startTime: 500, value: 0.08, hadRecentInput: false },
      { kind: 'layout-shift', startTime: 600, value: 0.2, hadRecentInput: true },
      { kind: 'long-task', startTime: 700, duration: 170 },
      {
        kind: 'resource',
        name: 'https://app.test/main.js?token=secret',
        initiatorType: 'script',
        startTime: 10,
        duration: 40,
        transferSize: 2_048,
      },
      { kind: 'interaction', startTime: 1_100, duration: 210, interactionId: 1 },
    ];
    const result = buildPerformanceTimeline(samples);

    expect(result.metrics).toMatchObject({
      fcpMs: { value: 1_000, rating: 'good' },
      lcpMs: { value: 2_600, rating: 'needs-improvement' },
      cls: { value: 0.08, rating: 'good' },
      inpMs: { value: 210, rating: 'needs-improvement' },
      totalBlockingTimeMs: { value: 120, rating: 'good' },
    });
    expect(result.summary).toMatchObject({ resourceCount: 1, longTaskCount: 1, totalTransferBytes: 2_048 });
  });

  it('uses latest LCP, earliest FCP and 98th percentile interaction', () => {
    const interactions: PerformanceSample[] = Array.from({ length: 100 }, (_, index) => ({
      kind: 'interaction',
      startTime: index,
      duration: index + 1,
    }));
    const result = buildPerformanceTimeline([
      { kind: 'largest-contentful-paint', startTime: 2_000 },
      { kind: 'largest-contentful-paint', startTime: 2_500 },
      { kind: 'paint', name: 'first-contentful-paint', startTime: 1_000 },
      { kind: 'paint', name: 'first-contentful-paint', startTime: 900 },
      ...interactions,
    ]);

    expect(result.metrics.lcpMs.value).toBe(2_500);
    expect(result.metrics.fcpMs.value).toBe(900);
    expect(result.metrics.inpMs.value).toBe(98);
  });

  it('bounds input processing and visible timeline independently', () => {
    const samples: PerformanceSample[] = Array.from({ length: 10 }, (_, index) => ({
      kind: 'resource',
      name: `/asset-${index}`,
      initiatorType: 'script',
      startTime: index,
      duration: 1,
      transferSize: 1,
    }));
    const result = buildPerformanceTimeline(samples, { maxInputSamples: 6, maxTimelineEvents: 2 });

    expect(result.events).toHaveLength(2);
    expect(result.summary).toMatchObject({ observedCount: 10, processedCount: 6, resourceCount: 6, truncated: true });
  });

  it('returns unknown optional metrics for an empty sample list', () => {
    const result = buildPerformanceTimeline([]);

    expect(result.events).toEqual([]);
    expect(result.metrics.fcpMs.rating).toBe('unknown');
    expect(result.metrics.totalBlockingTimeMs.value).toBe(0);
  });

  it('drops invalid timeline samples without contaminating aggregates', () => {
    const result = buildPerformanceTimeline([
      {
        kind: 'resource',
        name: '/bad',
        initiatorType: 'fetch',
        startTime: Number.NaN,
        duration: 10,
        transferSize: 100,
      },
      { kind: 'layout-shift', startTime: 1, value: -1, hadRecentInput: false },
    ]);

    expect(result.summary.totalTransferBytes).toBe(0);
    expect(result.metrics.cls.value).toBe(0);
  });
});

it('redacts common secrets in non-JSON text', () => {
  expect(redactObservabilityText('Authorization=Bearer abc token=xyz')).not.toMatch(/abc|xyz/);
});
