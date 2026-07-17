import { describe, expect, it } from 'vitest';

import { compareQuickTestRuns } from '../../../packages/desktop/src/process/ide/quickTestRunCompare';
import type { RuntimeTrace, TraceEvent } from '../../../packages/desktop/src/process/ide/quickTestTracer';

function trace(events: TraceEvent[], overrides: Partial<Omit<RuntimeTrace, 'events'>> = {}): RuntimeTrace {
  return {
    platform: 'web',
    rootPath: 'C:/repo',
    events,
    firstError: null,
    startedAt: 1_000,
    stoppedAt: 2_000,
    ...overrides,
  };
}

describe('compareQuickTestRuns', () => {
  it('keeps matching interaction steps aligned around an inserted action', () => {
    const baseline = trace([
      { kind: 'navigate', url: 'http://localhost/', at: 1_000 },
      { kind: 'click', selector: '#save', text: 'Save', at: 1_100 },
    ]);
    const current = trace([
      { kind: 'navigate', url: 'http://localhost/', at: 1_000 },
      { kind: 'input', selector: '#name', value: 'Aion', at: 1_050 },
      { kind: 'click', selector: '#save', text: 'Save', at: 1_100 },
    ]);

    const result = compareQuickTestRuns(baseline, current);

    expect(result.interactions.map((step) => step.status)).toEqual(['unchanged', 'added', 'unchanged']);
    expect(result.summary.interactionChanges).toBe(1);
  });

  it('reports new and resolved runtime errors deterministically', () => {
    const baseline = trace([{ kind: 'console', level: 'error', message: 'old failure', at: 1_100 }]);
    const current = trace([
      { kind: 'exception', message: 'new failure', url: 'app.ts', line: 7, at: 1_100 },
      { kind: 'exception', message: 'new failure', url: 'app.ts', line: 7, at: 1_200 },
    ]);

    const result = compareQuickTestRuns(baseline, current);

    expect(result.errors.added).toMatchObject([{ kind: 'exception', message: 'new failure', count: 2 }]);
    expect(result.errors.resolved).toMatchObject([{ kind: 'console', message: 'old failure', count: 1 }]);
    expect(result.summary.hasRegressionSignals).toBe(true);
  });

  it('compares repeated network requests by occurrence and exposes body changes', () => {
    const baseline = trace([
      { kind: 'network', method: 'get', url: '/api/items', status: 200, responseBody: '{"page":1}', at: 1_100 },
      { kind: 'network', method: 'get', url: '/api/items', status: 200, responseBody: '{"page":2}', at: 1_200 },
    ]);
    const current = trace([
      { kind: 'network', method: 'GET', url: '/api/items', status: 200, responseBody: '{"page":1}', at: 1_100 },
      { kind: 'network', method: 'GET', url: '/api/items', status: 500, responseBody: '{"error":true}', at: 1_200 },
    ]);

    const result = compareQuickTestRuns(baseline, current);

    expect(result.network).toMatchObject([
      { occurrence: 2, status: 'changed', statusChanged: true, bodyChanged: true },
    ]);
    expect(result.summary.networkChanges).toBe(1);
  });

  it('summarizes function, file, and duration changes', () => {
    const baseline = trace([], {
      coverage: [
        { file: 'src/a.ts', functionName: 'run', line: 2, callCount: 1 },
        { file: 'src/old.ts', functionName: 'old', line: 1, callCount: 1 },
      ],
      stoppedAt: 2_000,
    });
    const current = trace([], {
      coverage: [
        { file: 'src/a.ts', functionName: 'run', line: 2, callCount: 3 },
        { file: 'src/new.ts', functionName: 'next', line: 5, callCount: 1 },
      ],
      stoppedAt: 2_500,
    });

    const result = compareQuickTestRuns(baseline, current);

    expect(result.duration).toEqual({ baselineMs: 1_000, currentMs: 1_500, deltaMs: 500, deltaPercent: 50 });
    expect(result.summary.coverageFunctionChanges).toBe(3);
    expect(result.coverage.files.map((entry) => [entry.file, entry.status])).toEqual([
      ['src/a.ts', 'changed'],
      ['src/new.ts', 'added'],
      ['src/old.ts', 'removed'],
    ]);
  });

  it('bounds large traces and marks the result as truncated', () => {
    const events: TraceEvent[] = Array.from({ length: 20 }, (_, index) => ({
      kind: 'click',
      selector: `#item-${index}`,
      text: String(index),
      at: 1_000 + index,
    }));

    const result = compareQuickTestRuns(trace(events), trace(events), { maxInteractionSteps: 3 });

    expect(result.interactions).toHaveLength(3);
    expect(result.summary.truncated).toBe(true);
  });

  it('handles empty and zero-duration traces without invalid percentages', () => {
    const result = compareQuickTestRuns(trace([], { stoppedAt: 1_000 }), trace([], { stoppedAt: 1_000 }));

    expect(result.interactions).toEqual([]);
    expect(result.duration.deltaPercent).toBeNull();
    expect(result.summary.hasRegressionSignals).toBe(false);
  });
});
