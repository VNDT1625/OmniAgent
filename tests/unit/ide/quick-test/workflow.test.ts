import { describe, expect, it } from 'vitest';

import {
  applyScenarioEdits,
  buildDiagnosticReport,
  MAX_REPORT_EVENTS,
  planRetentionCleanup,
  ScenarioValidationError,
  validateScenario,
  type EditableScenario,
  type RetentionAsset,
  type RetentionPolicy,
} from '../../../../packages/desktop/src/process/services/quick-test/workflow';

const reportInput = () => ({
  reportId: 'report-1',
  scenarioId: 'login-flow',
  runId: 'run-2',
  title: 'Login regression',
  summary: 'The login action failed',
  status: 'failed' as const,
  createdAt: Date.UTC(2026, 6, 17),
});

const policy = (overrides?: Partial<RetentionPolicy>): RetentionPolicy => ({
  categories: {
    run: { maxAgeMs: 1_000, maxCount: 2, maxBytes: 100 },
    baseline: { maxAgeMs: 1_000, maxCount: 2, maxBytes: 100 },
    media: { maxAgeMs: 1_000, maxCount: 2, maxBytes: 100 },
    report: { maxAgeMs: 1_000, maxCount: 2, maxBytes: 100 },
  },
  totalMaxBytes: 400,
  ...overrides,
});

const asset = (
  id: string,
  category: RetentionAsset['category'],
  createdAt: number,
  sizeBytes = 10,
  extra: Partial<RetentionAsset> = {}
): RetentionAsset => ({ id, category, createdAt, sizeBytes, ...extra });

const scenario = (): EditableScenario => ({
  id: 'checkout',
  name: 'Checkout',
  revision: 3,
  updatedAt: 100,
  steps: [
    { id: 'open', kind: 'action', action: 'navigate', target: 'http://localhost:3000' },
    { id: 'buy', kind: 'action', action: 'click', target: '[data-testid="buy"]' },
  ],
});

describe('diagnostic report builder', () => {
  it('builds portable JSON and Markdown with artifact references', () => {
    const result = buildDiagnosticReport({
      ...reportInput(),
      durationMs: 250,
      references: [
        {
          id: 'screen-1',
          kind: 'screenshot',
          label: 'Failure screen',
          target: '.omni/quick-test/media/failure.png',
          sizeBytes: 1024,
        },
      ],
      events: [
        {
          timestamp: 10,
          type: 'click',
          outcome: 'failed',
          detail: 'Button did not respond',
          referenceIds: ['screen-1', 'missing'],
        },
      ],
    });

    expect(JSON.parse(result.json)).toEqual(result.manifest);
    expect(result.markdown).toContain('[Failure screen](.omni/quick-test/media/failure.png)');
    expect(result.manifest.events[0].referenceIds).toEqual(['screen-1']);
  });

  it('redacts secrets from environment and evidence text', () => {
    const result = buildDiagnosticReport({
      ...reportInput(),
      summary: 'Bearer abc.def',
      environment: { NODE_ENV: 'test', API_TOKEN: 'do-not-export' },
      findings: [{ severity: 'error', title: 'Auth', detail: 'password=visible' }],
    });

    expect(result.manifest.environment.API_TOKEN).toBe('[REDACTED]');
    expect(result.json).not.toContain('do-not-export');
    expect(result.json).not.toContain('visible');
  });

  it('rejects embedded blobs instead of creating oversized reports', () => {
    expect(() =>
      buildDiagnosticReport({
        ...reportInput(),
        references: [
          {
            id: 'embedded',
            kind: 'screenshot',
            label: 'Bad',
            target: 'data:image/png;base64,AAAA',
          },
        ],
      })
    ).toThrow(/must point/);
  });

  it('bounds noisy timelines and records the omitted count', () => {
    const events = Array.from({ length: MAX_REPORT_EVENTS + 2 }, (_, index) => ({
      timestamp: index,
      type: 'console',
    }));
    const result = buildDiagnosticReport({ ...reportInput(), events });

    expect(result.manifest.events).toHaveLength(MAX_REPORT_EVENTS);
    expect(result.manifest.truncated.events).toBe(2);
  });

  it('rejects duplicate artifact identifiers', () => {
    const repeated = {
      id: 'same',
      kind: 'log' as const,
      label: 'Log',
      target: '.omni/log.txt',
    };

    expect(() => buildDiagnosticReport({ ...reportInput(), references: [repeated, repeated] })).toThrow(
      /Duplicate reference id/
    );
  });
});

describe('retention cleanup planner', () => {
  it('removes expired and count-limited assets deterministically', () => {
    const result = planRetentionCleanup(
      [
        asset('old', 'run', 1),
        asset('first', 'run', 1_500),
        asset('second', 'run', 1_600),
        asset('newest', 'run', 1_700),
      ],
      policy(),
      2_000
    );

    expect(result.delete.map(({ asset: item, reason }) => [item.id, reason])).toEqual([
      ['old', 'expired'],
      ['first', 'count-limit'],
    ]);
    expect(result.keep.map((item) => item.id)).toEqual(['newest', 'second']);
  });

  it('keeps pinned assets and their dependencies', () => {
    const result = planRetentionCleanup(
      [
        asset('baseline', 'baseline', 1, 80),
        asset('report', 'report', 1_900, 10, { pinned: true, references: ['baseline'] }),
      ],
      policy({
        categories: {
          ...policy().categories,
          baseline: { maxAgeMs: 100, maxCount: 0, maxBytes: 0 },
        },
      }),
      2_000
    );

    expect(result.keep.map((item) => item.id)).toEqual(['report', 'baseline']);
    expect(result.warnings).toContain('Preserved referenced asset baseline');
  });

  it('deletes oldest unreferenced assets to satisfy the global budget', () => {
    const result = planRetentionCleanup(
      [asset('old', 'run', 1_500, 60), asset('new', 'media', 1_900, 60)],
      policy({ totalMaxBytes: 70 }),
      2_000
    );

    expect(result.delete[0]).toMatchObject({
      asset: { id: 'old' },
      reason: 'total-size-limit',
    });
    expect(result.retainedBytes).toBe(60);
  });

  it('warns when pinned data alone exceeds the global budget', () => {
    const result = planRetentionCleanup(
      [asset('pinned', 'run', 1_900, 200, { pinned: true })],
      policy({ totalMaxBytes: 10 }),
      2_000
    );

    expect(result.delete).toEqual([]);
    expect(result.warnings).toContain('Retention limits cannot be met without deleting pinned or referenced assets');
  });

  it('rejects duplicate asset identifiers', () => {
    expect(() => planRetentionCleanup([asset('same', 'run', 1), asset('same', 'media', 2)], policy(), 10)).toThrow(
      /Duplicate asset id/
    );
  });
});

describe('visual scenario editor operations', () => {
  it('reorders, edits, and adds assertions and checkpoints immutably', () => {
    const original = scenario();
    const edited = applyScenarioEdits(
      original,
      [
        { type: 'reorder', stepId: 'buy', toIndex: 0 },
        {
          type: 'edit',
          stepId: 'buy',
          step: {
            id: 'buy',
            kind: 'action',
            action: 'click',
            target: '[data-testid="checkout"]',
          },
        },
        {
          type: 'add-assertion',
          afterStepId: 'buy',
          step: {
            id: 'visible',
            kind: 'assertion',
            assertion: 'visible',
            target: '#confirmation',
            expected: true,
          },
        },
        {
          type: 'add-checkpoint',
          step: {
            id: 'final-screen',
            kind: 'checkpoint',
            name: 'Confirmation',
            capture: 'all',
          },
        },
      ],
      200
    );

    expect(edited.steps.map((step) => step.id)).toEqual(['buy', 'visible', 'open', 'final-screen']);
    expect(edited).toMatchObject({ revision: 4, updatedAt: 200 });
    expect(original.steps[1]).toMatchObject({ target: '[data-testid="buy"]' });
  });

  it('deletes a selected step while retaining a runnable scenario', () => {
    const edited = applyScenarioEdits(scenario(), [{ type: 'delete', stepId: 'buy' }], 200);

    expect(edited.steps.map((step) => step.id)).toEqual(['open']);
  });

  it('rejects deleting the final action', () => {
    const singleAction = { ...scenario(), steps: [scenario().steps[0]] };

    expect(() => applyScenarioEdits(singleAction, [{ type: 'delete', stepId: 'open' }], 200)).toThrow(
      ScenarioValidationError
    );
  });

  it('rejects duplicate ids introduced by an editor operation', () => {
    expect(() =>
      applyScenarioEdits(
        scenario(),
        [
          {
            type: 'add-checkpoint',
            step: { id: 'buy', kind: 'checkpoint', name: 'Duplicate', capture: 'trace' },
          },
        ],
        200
      )
    ).toThrow(/Duplicate step id/);
  });

  it('returns actionable validation paths for malformed steps', () => {
    const issues = validateScenario({
      ...scenario(),
      steps: [
        { id: 'click', kind: 'action', action: 'click' },
        {
          id: 'assert',
          kind: 'assertion',
          assertion: 'text',
          target: '#message',
          expected: '',
          timeoutMs: 300_001,
        },
      ],
    });

    expect(issues.map((issue) => issue.path)).toEqual(['steps[0].target', 'steps[1].expected', 'steps[1].timeoutMs']);
  });

  it('rejects unknown step references and invalid destinations', () => {
    expect(() => applyScenarioEdits(scenario(), [{ type: 'reorder', stepId: 'missing', toIndex: 0 }], 200)).toThrow(
      /Unknown scenario step/
    );
    expect(() => applyScenarioEdits(scenario(), [{ type: 'reorder', stepId: 'buy', toIndex: 9 }], 200)).toThrow(
      /Invalid destination index/
    );
  });
});
