import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadSavedQuickTestScenario,
  QuickTestScenarioRunner,
  type ScenarioRunnerAdapter,
} from '../../../packages/desktop/src/process/ide/mcp/quickTestScenarioRunner';
import type { ReplayScenario } from '../../../packages/desktop/src/process/ide/quickTestReplay';

const roots: string[] = [];

const scenario = (steps: ReplayScenario['steps']): ReplayScenario => ({
  version: 1,
  id: 'scenario-login',
  name: 'Login flow',
  platform: 'web',
  rootPath: 'ignored-persisted-root',
  createdAt: 100,
  steps,
});

const saveAssets = async (savedScenario: ReplayScenario): Promise<string> => {
  const rootPath = await mkdtemp(path.join(tmpdir(), 'quick-test-runner-'));
  roots.push(rootPath);
  const directory = path.join(rootPath, '.omni', 'quick-test');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'assets.json'),
    JSON.stringify({ version: 1, scenarios: [savedScenario] }),
    'utf8'
  );
  return rootPath;
};

const adapter = (): ScenarioRunnerAdapter => ({
  navigate: vi.fn().mockResolvedValue(undefined),
  click: vi.fn().mockResolvedValue(undefined),
  input: vi.fn().mockResolvedValue(undefined),
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((rootPath) => rm(rootPath, { recursive: true, force: true })));
});

describe('loadSavedQuickTestScenario', () => {
  it('loads a saved scenario by project root and ID', async () => {
    const rootPath = await saveAssets(
      scenario([{ id: 'navigate', kind: 'navigate', url: 'http://localhost:3000', sourceAt: 101 }])
    );

    const loaded = await loadSavedQuickTestScenario(rootPath, 'scenario-login');

    expect(loaded.name).toBe('Login flow');
    expect(loaded.steps).toHaveLength(1);
  });

  it('rejects a missing scenario instead of running an arbitrary asset', async () => {
    const rootPath = await saveAssets(scenario([]));

    await expect(loadSavedQuickTestScenario(rootPath, 'scenario-other')).rejects.toThrow('was not found');
  });
});

describe('QuickTestScenarioRunner', () => {
  it('replays saved actions in order and returns structured evidence', async () => {
    const rootPath = await saveAssets(
      scenario([
        { id: 'navigate', kind: 'navigate', url: 'http://localhost:3000', sourceAt: 101 },
        { id: 'click', kind: 'click', selector: '#submit', sourceAt: 102 },
        { id: 'input', kind: 'input', selector: '#email', value: 'dev@example.com', redacted: false, sourceAt: 103 },
      ])
    );
    const calls: string[] = [];
    const runner = new QuickTestScenarioRunner({
      randomId: () => 'run-1',
      createAdapter: () => ({
        navigate: async () => void calls.push('navigate'),
        click: async () => void calls.push('click'),
        input: async () => void calls.push('input'),
        collectEvidence: async () => ({ relatedFiles: ['src/login.tsx'] }),
      }),
    });

    const result = await runner.run({ rootPath, testId: 'scenario-login' });

    expect(result).toMatchObject({
      status: 'passed',
      evidence: { relatedFiles: ['src/login.tsx'] },
      assessment: {
        verdict: 'passed',
        failure: null,
        evidenceCounts: { relatedFiles: 1 },
        rerun: { recommended: false, verificationMode: { kind: 'full' } },
      },
    });
    expect(calls).toEqual(['navigate', 'click', 'input']);
  });

  it('passes the saved native target or an explicit override to the adapter factory', async () => {
    const rootPath = await saveAssets({
      ...scenario([{ id: 'click', kind: 'click', selector: 'uia:login', sourceAt: 101 }]),
      platform: 'android',
      target: 'emulator-5554',
    });
    const page = adapter();
    const createAdapter = vi.fn().mockReturnValue(page);
    const runner = new QuickTestScenarioRunner({ createAdapter });

    await runner.run({ rootPath, testId: 'scenario-login', target: 'emulator-5556' });

    expect(createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'emulator-5556',
        scenario: expect.objectContaining({ platform: 'android', target: 'emulator-5554' }),
      })
    );
  });

  it('stops at the failing action and reports its index and reason', async () => {
    const rootPath = await saveAssets(
      scenario([
        { id: 'navigate', kind: 'navigate', url: 'http://localhost:3000', sourceAt: 101 },
        { id: 'click', kind: 'click', selector: '#missing', sourceAt: 102 },
      ])
    );
    const page = adapter();
    vi.mocked(page.click).mockRejectedValueOnce(new Error('Element was not found'));
    const runner = new QuickTestScenarioRunner({ createAdapter: () => page });

    const result = await runner.run({ rootPath, testId: 'scenario-login' });

    expect(result).toMatchObject({
      status: 'failed',
      failedStep: 1,
      reason: 'Element was not found',
      assessment: {
        verdict: 'failed',
        failure: {
          category: 'interaction',
          message: 'Element was not found',
          stepId: 'click',
          stepIndex: 1,
          kind: 'click',
          target: '#missing',
        },
        rerun: {
          recommended: true,
          debugMode: { kind: 'from-step', stepIndex: 1 },
          verificationMode: { kind: 'full' },
        },
      },
    });
    expect(result.actions.at(-1)).toMatchObject({ stepIndex: 1, status: 'failed' });
  });

  it('cancels an active run without waiting for a hanging adapter', async () => {
    const rootPath = await saveAssets(scenario([{ id: 'click', kind: 'click', selector: '#slow', sourceAt: 101 }]));
    const page = adapter();
    vi.mocked(page.click).mockImplementation(() => new Promise(() => undefined));
    const runner = new QuickTestScenarioRunner({ randomId: () => 'run-cancel', createAdapter: () => page });

    const started = await runner.start({ rootPath, testId: 'scenario-login' });
    await vi.waitFor(() => expect(page.click).toHaveBeenCalled());
    expect(runner.cancel(started.runId)).toBe(true);
    const result = await runner.wait(started.runId);

    expect(result.status).toBe('cancelled');
    expect(runner.cancel(started.runId)).toBe(false);
  });

  it('times out a hanging run and keeps the completed snapshot queryable', async () => {
    const rootPath = await saveAssets(scenario([{ id: 'click', kind: 'click', selector: '#slow', sourceAt: 101 }]));
    const page = adapter();
    vi.mocked(page.click).mockImplementation(() => new Promise(() => undefined));
    const runner = new QuickTestScenarioRunner({ randomId: () => 'run-timeout', createAdapter: () => page });

    const result = await runner.run({ rootPath, testId: 'scenario-login', timeoutMs: 10 });

    expect(result.status).toBe('timed-out');
    expect(runner.get('run-timeout')).toEqual(result);
  });

  it('resolves sensitive inputs without persisting or returning their values', async () => {
    const persistedSecret = 'persisted-should-never-escape';
    const runtimeSecret = 'runtime-should-never-escape';
    const rootPath = await saveAssets(
      scenario([
        {
          id: 'password',
          kind: 'input',
          selector: 'input[name="password"]',
          value: persistedSecret,
          redacted: false,
          sourceAt: 101,
        },
      ])
    );
    const page = adapter();
    vi.mocked(page.input).mockRejectedValueOnce(new Error(`Rejected ${runtimeSecret}`));
    page.collectEvidence = async () => ({ consoleErrors: [`Leaked ${runtimeSecret}`] });
    const createAdapter = vi.fn().mockReturnValue(page);
    const runner = new QuickTestScenarioRunner({ createAdapter });

    const result = await runner.run({
      rootPath,
      testId: 'scenario-login',
      inputOverrides: { password: runtimeSecret },
    });
    const serialized = JSON.stringify(result);

    expect(createAdapter.mock.calls[0][0].scenario.steps[0]).toMatchObject({ value: '[REDACTED]', redacted: true });
    expect(serialized).not.toContain(persistedSecret);
    expect(serialized).not.toContain(runtimeSecret);
  });

  it('rejects overrides for missing or non-redacted steps', async () => {
    const rootPath = await saveAssets(
      scenario([
        { id: 'email', kind: 'input', selector: '#email', value: 'dev@example.com', redacted: false, sourceAt: 101 },
      ])
    );
    const runner = new QuickTestScenarioRunner({ createAdapter: adapter });

    await expect(
      runner.start({ rootPath, testId: 'scenario-login', inputOverrides: { email: 'replacement' } })
    ).rejects.toThrow('does not exist or is not redacted');
    await expect(
      runner.start({ rootPath, testId: 'scenario-login', inputOverrides: { missing: 'replacement' } })
    ).rejects.toThrow('does not exist or is not redacted');
  });

  it('marks evidence collection failures as infrastructure evidence instead of an app console error', async () => {
    const rootPath = await saveAssets(scenario([{ id: 'click', kind: 'click', selector: '#submit', sourceAt: 101 }]));
    const page = adapter();
    page.collectEvidence = async () => {
      throw new Error('CDP session closed');
    };
    const runner = new QuickTestScenarioRunner({ createAdapter: () => page });

    const result = await runner.run({ rootPath, testId: 'scenario-login' });

    expect(result).toMatchObject({
      status: 'failed',
      assessment: {
        verdict: 'failed',
        failure: { category: 'evidence-collection', message: 'Evidence collection failed: CDP session closed' },
        evidenceCounts: { consoleErrors: 1 },
      },
    });
  });

  it('fails a replay when runtime tracing reports console or network errors', async () => {
    const rootPath = await saveAssets(scenario([{ id: 'click', kind: 'click', selector: '#submit', sourceAt: 101 }]));
    const page = adapter();
    page.collectEvidence = async () => ({
      consoleErrors: ['Unhandled checkout failure'],
      networkFailures: ['POST /api/checkout — 500'],
      relatedFiles: ['src/checkout.ts'],
    });
    const runner = new QuickTestScenarioRunner({ createAdapter: () => page });

    const result = await runner.run({ rootPath, testId: 'scenario-login' });

    expect(result).toMatchObject({
      status: 'failed',
      reason: 'Unhandled checkout failure',
      evidence: { relatedFiles: ['src/checkout.ts'] },
      assessment: {
        verdict: 'failed',
        failure: { category: 'runtime-console', message: 'Unhandled checkout failure' },
        evidenceCounts: { consoleErrors: 1, networkFailures: 1, relatedFiles: 1 },
        rerun: { recommended: true, debugMode: { kind: 'full' } },
      },
    });
  });
});
