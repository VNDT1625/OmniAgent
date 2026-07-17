import { describe, expect, it } from 'vitest';

import {
  analyzeRepeatedRuns,
  buildEnvironmentSnapshot,
  clusterReliabilityErrors,
  fingerprintReliabilityError,
  QuickTestReliabilityTracker,
  redactEnvironment,
  type ReliabilityRun,
} from '../../../../packages/desktop/src/process/services/quick-test/reliability';

const run = (
  runId: string,
  status: ReliabilityRun['status'],
  startedAt: number,
  overrides: Partial<ReliabilityRun> = {}
): ReliabilityRun => ({
  runId,
  testId: 'checkout',
  status,
  startedAt,
  finishedAt: startedAt + 100,
  ...overrides,
});

describe('analyzeRepeatedRuns', () => {
  it('classifies alternating conclusive outcomes as flaky with duration statistics', () => {
    const result = analyzeRepeatedRuns('checkout', [
      run('one', 'passed', 0),
      run('two', 'failed', 200, { finishedAt: 500 }),
      run('three', 'passed', 600, { finishedAt: 1_100 }),
    ]);

    expect(result.classification).toBe('flaky');
    expect(result.passRate).toBe(0.6667);
    expect(result.transitionCount).toBe(2);
    expect(result.durations).toEqual({
      minimumMs: 100,
      maximumMs: 500,
      averageMs: 300,
      medianMs: 300,
      p95Ms: 500,
    });
  });

  it('keeps interrupted runs visible without treating them as product failures', () => {
    const result = analyzeRepeatedRuns(
      'checkout',
      [run('one', 'passed', 0), run('two', 'cancelled', 200), run('three', 'timed-out', 400)],
      { minimumConclusiveRuns: 2 }
    );

    expect(result.classification).toBe('insufficient');
    expect(result.interruptedRuns).toBe(2);
    expect(result.failureRate).toBe(0);
  });

  it('uses only the newest bounded run window', () => {
    const result = analyzeRepeatedRuns(
      'checkout',
      [run('old', 'passed', 0), run('new-1', 'failed', 100), run('new-2', 'failed', 200)],
      { maxRuns: 2, minimumConclusiveRuns: 2 }
    );

    expect(result.classification).toBe('stable-failing');
    expect(result.firstRunAt).toBe(100);
  });

  it('returns an empty safe summary when the test has no runs', () => {
    const result = analyzeRepeatedRuns('missing', [run('other', 'failed', 0)]);

    expect(result.retainedRuns).toBe(0);
    expect(result.durations).toBeNull();
    expect(result.classification).toBe('insufficient');
  });
});

describe('error fingerprints and clustering', () => {
  it('groups messages whose volatile URL, UUID, path and numbers differ', () => {
    const first = fingerprintReliabilityError({
      message: 'Request 42 failed at https://localhost/item/42',
      stack: 'at load (C:\\repo\\src\\api.ts:12:4)',
    });
    const second = fingerprintReliabilityError({
      message: 'Request 99 failed at https://example.test/item/99',
      stack: 'at load (D:\\work\\src\\api.ts:88:9)',
    });

    expect(first.id).toBe(second.id);
    expect(first.normalizedMessage).toContain('<number>');
  });

  it('counts affected runs separately from duplicate occurrences and bounds samples', () => {
    const error = { message: 'API request 500 failed' };
    const clusters = clusterReliabilityErrors(
      [
        run('one', 'failed', 0, { errors: [error, error] }),
        run('two', 'failed', 100, { errors: [{ message: 'API request 404 failed' }] }),
      ],
      { maxSamplesPerCluster: 1 }
    );

    expect(clusters[0]?.occurrenceCount).toBe(3);
    expect(clusters[0]?.affectedRunCount).toBe(2);
    expect(clusters[0]?.samples).toHaveLength(1);
  });

  it('returns no clusters when runs contain no error evidence', () => {
    expect(clusterReliabilityErrors([run('one', 'failed', 0)])).toEqual([]);
  });
});

describe('QuickTestReliabilityTracker', () => {
  it('replaces duplicate run IDs and evicts the oldest runs', () => {
    const tracker = new QuickTestReliabilityTracker({ maxStoredRuns: 2, minimumConclusiveRuns: 2 });
    tracker.record(run('one', 'passed', 0));
    tracker.record(run('two', 'passed', 100));
    tracker.record(run('one', 'failed', 200));

    expect(tracker.runs().map((item) => item.status)).toEqual(['passed', 'failed']);
    expect(tracker.analyze('checkout').classification).toBe('flaky');
  });

  it('clears one test without removing other test histories', () => {
    const tracker = new QuickTestReliabilityTracker();
    tracker.record(run('one', 'passed', 0));
    tracker.record(run('two', 'failed', 100, { testId: 'profile' }));
    tracker.clear('checkout');

    expect(tracker.runs().map((item) => item.testId)).toEqual(['profile']);
  });
});

describe('environment snapshots', () => {
  it('redacts sensitive keys and credentials embedded in otherwise useful values', () => {
    const result = redactEnvironment({
      NODE_ENV: 'development',
      API_TOKEN: 'top-secret',
      SERVICE_URL: 'https://user:password@example.test/path?token=abc',
      EMPTY: undefined,
    });

    expect(result.API_TOKEN).toBe('[REDACTED]');
    expect(result.SERVICE_URL).not.toContain('password');
    expect(result.SERVICE_URL).not.toContain('abc');
    expect(result.NODE_ENV).toBe('development');
  });

  it('captures injected git, dependency, service, port and platform data with bounds', async () => {
    const snapshot = await buildEnvironmentSnapshot(
      {
        now: () => 123,
        git: () => ({ commit: 'abc', branch: 'main', dirty: true, changedFiles: ['one.ts', 'two.ts'] }),
        dependencies: () => [
          { name: 'react', version: '19' },
          { name: 'vitest', version: '4' },
        ],
        services: () => [{ name: 'frontend', status: 'running', port: 3000 }],
        ports: () => [{ port: 3000, process: 'bun' }],
        platform: () => ({ os: 'win32', arch: 'x64', runtimeVersions: { node: '22' } }),
        environment: () => ({ PASSWORD: 'secret', NODE_ENV: 'test' }),
      },
      { maxDependencies: 1, maxChangedFiles: 1 }
    );

    expect(snapshot.capturedAt).toBe(123);
    expect(snapshot.dependencies).toEqual([{ name: 'react', version: '19', source: undefined }]);
    expect(snapshot.git?.changedFiles).toEqual(['one.ts']);
    expect(snapshot.environment.PASSWORD).toBe('[REDACTED]');
  });

  it('isolates failed collectors and reports their sections instead of rejecting the snapshot', async () => {
    const snapshot = await buildEnvironmentSnapshot({
      git: () => {
        throw new Error('git unavailable');
      },
      ports: async () => {
        throw new Error('permission denied');
      },
      platform: () => ({ os: 'linux', arch: 'arm64' }),
      now: () => 50,
    });

    expect(snapshot.git).toBeNull();
    expect(snapshot.ports).toEqual([]);
    expect(snapshot.warnings).toEqual(['git', 'ports']);
  });
});
