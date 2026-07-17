import { describe, expect, it, vi } from 'vitest';

import {
  createReplayScenario,
  isValidReplaySelector,
  isValidReplayUrl,
  REPLAY_REDACTED_VALUE,
  replayScenario,
  type ReplayPageAdapter,
} from '../../../packages/desktop/src/process/ide/quickTestReplay';
import type { RuntimeTrace } from '../../../packages/desktop/src/process/ide/quickTestTracer';

const makeTrace = (events: RuntimeTrace['events']): RuntimeTrace => ({
  platform: 'web',
  rootPath: 'C:/workspace/app',
  events,
  firstError: null,
  startedAt: 10,
  stoppedAt: 20,
});

const makeAdapter = (): ReplayPageAdapter => ({
  navigate: vi.fn().mockResolvedValue(undefined),
  click: vi.fn().mockResolvedValue(undefined),
  input: vi.fn().mockResolvedValue(undefined),
});

describe('createReplayScenario', () => {
  it('turns supported trace events into stable ordered replay steps', () => {
    const trace = makeTrace([
      { kind: 'navigate', url: 'http://localhost:3000/login', at: 11 },
      { kind: 'click', selector: 'button[data-testid="sign-in"]', text: 'Sign in', at: 12 },
      { kind: 'input', selector: '#email', value: 'dev@example.com', at: 13 },
    ]);

    const first = createReplayScenario(trace, { name: 'Login', createdAt: 100 });
    const second = createReplayScenario(trace, { name: 'Login', createdAt: 100 });

    expect(first).toEqual(second);
    expect(first.steps.map((step) => step.kind)).toEqual(['navigate', 'click', 'input']);
    expect(first.steps[2]).toMatchObject({ value: 'dev@example.com', redacted: false });
  });

  it('persists a resolved native target for later replay', () => {
    const scenario = createReplayScenario(
      {
        ...makeTrace([{ kind: 'click', selector: 'uia:login', text: 'Login', at: 11 }]),
        platform: 'android',
        target: 'emulator-5554',
      },
      { createdAt: 100 }
    );

    expect(scenario).toMatchObject({ platform: 'android', target: 'emulator-5554' });
  });

  it('redacts password-like input values before persistence', () => {
    const scenario = createReplayScenario(
      makeTrace([{ kind: 'input', selector: 'input[name="password"]', value: 'super-secret', at: 11 }]),
      { createdAt: 100 }
    );

    expect(scenario.steps[0]).toMatchObject({ value: REPLAY_REDACTED_VALUE, redacted: true });
    expect(JSON.stringify(scenario)).not.toContain('super-secret');
  });

  it('discards unsafe URLs and malformed selectors', () => {
    const scenario = createReplayScenario(
      makeTrace([
        { kind: 'navigate', url: 'javascript:alert(1)', at: 11 },
        { kind: 'click', selector: 'div[', text: '', at: 12 },
        { kind: 'input', selector: '', value: 'ignored', at: 13 },
      ]),
      { createdAt: 100 }
    );

    expect(scenario.steps).toEqual([]);
  });
});

describe('replay validation', () => {
  it('accepts HTTP URLs and balanced CSS selectors', () => {
    expect(isValidReplayUrl('https://example.com/path?q=1')).toBe(true);
    expect(isValidReplaySelector('main > button:nth-child(2)[aria-label="Save"]')).toBe(true);
  });

  it('rejects unsafe protocols, control characters, and unbalanced selectors', () => {
    expect(isValidReplayUrl('file:///etc/passwd')).toBe(false);
    expect(isValidReplaySelector('button\nscript')).toBe(false);
    expect(isValidReplaySelector('div:not([hidden]')).toBe(false);
  });
});

describe('replayScenario', () => {
  const scenario = createReplayScenario(
    makeTrace([
      { kind: 'navigate', url: 'http://localhost:3000', at: 11 },
      { kind: 'click', selector: '#open', text: 'Open', at: 12 },
      { kind: 'input', selector: '#query', value: 'hello', at: 13 },
    ]),
    { createdAt: 100 }
  );

  it('runs every step in sequence', async () => {
    const calls: string[] = [];
    const adapter: ReplayPageAdapter = {
      navigate: async (url) => void calls.push(`navigate:${url}`),
      click: async (selector) => void calls.push(`click:${selector}`),
      input: async (selector, value) => void calls.push(`input:${selector}:${value}`),
    };

    const result = await replayScenario(scenario, adapter);

    expect(result.status).toBe('passed');
    expect(calls).toEqual(['navigate:http://localhost:3000', 'click:#open', 'input:#query:hello']);
    expect(result.steps).toHaveLength(3);
  });

  it('runs from a selected step', async () => {
    const adapter = makeAdapter();

    const result = await replayScenario(scenario, adapter, { kind: 'from-step', stepIndex: 1 });

    expect(adapter.navigate).not.toHaveBeenCalled();
    expect(adapter.click).toHaveBeenCalledWith('#open');
    expect(result.steps.map((step) => step.stepIndex)).toEqual([1, 2]);
  });

  it('runs only one selected step', async () => {
    const adapter = makeAdapter();

    const result = await replayScenario(scenario, adapter, { kind: 'single-step', stepIndex: 2 });

    expect(adapter.input).toHaveBeenCalledWith('#query', 'hello');
    expect(result.steps.map((step) => step.stepIndex)).toEqual([2]);
  });

  it('stops at the first adapter failure and reports it', async () => {
    const adapter = makeAdapter();
    vi.mocked(adapter.click).mockRejectedValueOnce(new Error('Element disappeared'));

    const result = await replayScenario(scenario, adapter);

    expect(result.status).toBe('failed');
    expect(result.steps.at(-1)).toMatchObject({ stepIndex: 1, status: 'failed', error: 'Element disappeared' });
    expect(adapter.input).not.toHaveBeenCalled();
  });

  it('attributes adapter evidence to each completed step before continuing', async () => {
    const adapter = makeAdapter();
    adapter.collectStepEvidence = vi.fn(async ({ stepIndex, status }) => ({
      pageUrl: `http://localhost:3000/step/${stepIndex}`,
      pageTitle: status,
    }));

    const result = await replayScenario(scenario, adapter);

    expect(result.steps.map((step) => step.evidence?.pageUrl)).toEqual([
      'http://localhost:3000/step/0',
      'http://localhost:3000/step/1',
      'http://localhost:3000/step/2',
    ]);
    expect(adapter.collectStepEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 1, status: 'passed', step: scenario.steps[1] })
    );
  });

  it('keeps the original action failure while attaching failure-state evidence', async () => {
    const adapter = makeAdapter();
    vi.mocked(adapter.click).mockRejectedValueOnce(new Error('Element disappeared'));
    adapter.collectStepEvidence = vi.fn(async ({ status, error }) =>
      status === 'failed'
        ? { pageUrl: 'http://localhost:3000/broken', pageTitle: error, screenshotPath: 'failure.png' }
        : undefined
    );

    const result = await replayScenario(scenario, adapter);

    expect(result.steps.at(-1)).toMatchObject({
      status: 'failed',
      error: 'Element disappeared',
      evidence: {
        pageUrl: 'http://localhost:3000/broken',
        pageTitle: 'Element disappeared',
        screenshotPath: 'failure.png',
      },
    });
  });

  it('reports evidence collection errors without failing a successful action', async () => {
    const adapter = makeAdapter();
    adapter.collectStepEvidence = vi.fn().mockRejectedValue(new Error('Screenshot unavailable'));

    const result = await replayScenario(scenario, adapter, { kind: 'single-step', stepIndex: 1 });

    expect(result.status).toBe('passed');
    expect(result.steps[0]?.evidence).toEqual({ collectionError: 'Screenshot unavailable' });
  });

  it('rejects out-of-range execution modes', async () => {
    await expect(replayScenario(scenario, makeAdapter(), { kind: 'single-step', stepIndex: 99 })).rejects.toThrow(
      RangeError
    );
  });

  it('does not type a redacted secret', async () => {
    const redactedScenario = createReplayScenario(
      makeTrace([{ kind: 'input', selector: '#password', value: 'secret', at: 11 }]),
      { createdAt: 100 }
    );
    const adapter = makeAdapter();

    const result = await replayScenario(redactedScenario, adapter);

    expect(result.status).toBe('failed');
    expect(result.steps[0]?.error).toContain('must be supplied');
    expect(adapter.input).not.toHaveBeenCalled();
  });
});
