/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Test gate — runs a role's verification through the app's existing Testing
 * capability (Requirement 5). When a role's workflow calls for a test, the
 * pipeline builds a scenario and runs it via the Testing bridge
 * (`testing.run` → `testOrchestrator.run`), waits for the report, and reports
 * pass/fail back into the pipeline. On failure the executor is given the failure
 * report to fix and the test re-runs, up to a bounded number of rounds.
 *
 * The Testing client is injected so this is unit-testable without the real
 * orchestrator.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

/** Minimal Testing client surface (a structural subset of `testingClient`). */
export type TestRunner = {
  run: (request: {
    name: string;
    platform: 'web' | 'android' | 'windows';
    steps: Array<{ id: string; description: string }>;
    visible?: boolean;
  }) => Promise<{
    sessionId: string;
    status: 'queued' | 'running' | 'passed' | 'failed' | 'error';
    reportPath?: string;
  }>;
};

/** A fix step invoked between failed test rounds (e.g. re-run the executor). */
export type TestFixer = (input: { round: number; failureDetail: string }) => Promise<void>;

/** Outcome of the gated test loop. */
export type TestGateOutcome = {
  /** Whether the test ultimately passed. */
  passed: boolean;
  /** Number of rounds run. */
  rounds: number;
  /** Path to the last report (.md), if any. */
  reportPath?: string;
  /** The terminal status of the last run. */
  status: 'passed' | 'failed' | 'error';
};

/** Options for {@link runTestGate}. */
export type TestGateOptions = {
  /** Scenario display name. */
  scenarioName: string;
  /** Ordered steps in the test script grammar (e.g. "goto ...", "assertText ..."). */
  steps: string[];
  /** Target platform. Default 'web'. */
  platform?: 'web' | 'android' | 'windows';
  /** Max rounds (run + fix) before reporting failure up. Default 3. */
  maxRounds?: number;
  /** Run the test visibly. Default false (hidden). */
  visible?: boolean;
  /** Optional fixer invoked after a failed round before retrying. */
  fix?: TestFixer;
  /** Cancellation signal. */
  signal?: AbortSignal;
};

/** Default max test rounds. */
const DEFAULT_MAX_ROUNDS = 3;

/** Turn a list of plain-text step lines into the Testing client's step shape. */
const toSteps = (lines: string[]): Array<{ id: string; description: string }> =>
  lines.map((description, index) => ({ id: `s${index}`, description }));

/**
 * Run a role's verification through the Testing capability, retrying with the
 * optional fixer until it passes or the round budget is exhausted.
 *
 * Never rejects: a Testing failure resolves with `passed: false` so the caller
 * can surface it up the tree.
 */
export const runTestGate = async (runner: TestRunner, options: TestGateOptions): Promise<TestGateOutcome> => {
  const maxRounds = Math.max(1, options.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const platform = options.platform ?? 'web';
  const steps = toSteps(options.steps);

  let lastReportPath: string | undefined;
  let lastStatus: 'passed' | 'failed' | 'error' = 'failed';

  for (let round = 1; round <= maxRounds; round++) {
    if (options.signal?.aborted) {
      return { passed: false, rounds: round - 1, reportPath: lastReportPath, status: lastStatus };
    }

    let result: Awaited<ReturnType<TestRunner['run']>>;
    try {
      result = await runner.run({ name: options.scenarioName, platform, steps, visible: options.visible });
    } catch {
      lastStatus = 'error';
      return { passed: false, rounds: round, reportPath: lastReportPath, status: 'error' };
    }

    lastReportPath = result.reportPath ?? lastReportPath;
    lastStatus = result.status === 'passed' ? 'passed' : result.status === 'error' ? 'error' : 'failed';

    if (result.status === 'passed') {
      return { passed: true, rounds: round, reportPath: lastReportPath, status: 'passed' };
    }

    // Failed (or errored): give the fixer a chance before the next round.
    if (round < maxRounds && options.fix) {
      try {
        await options.fix({
          round,
          failureDetail: `Test "${options.scenarioName}" ${result.status} (session ${result.sessionId}).`,
        });
      } catch {
        // A failed fix attempt still lets the loop retry the test once more.
      }
    }
  }

  return { passed: false, rounds: maxRounds, reportPath: lastReportPath, status: lastStatus };
};
