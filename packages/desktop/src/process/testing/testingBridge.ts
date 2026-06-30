/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Testing IPC bridge (Yêu cầu 2b, criteria 2.3 / 2.5) — exposes the Main-process
 * multi-platform testing layer to the renderer Testing page. Mirrors the
 * company/browser/monitor bridge pattern: renderer-safe channel-name constants +
 * typed providers built with `@office-ai/platform`, registered once by the
 * global bootstrap (Task 15.1); it does not self-wire.
 *
 * The renderer (`testingBridgeClient.ts`) rebuilds matching invokers from the
 * channel-name strings so it never imports this Node-only module.
 *
 * Both this bridge and the Testing MCP server (`testingServer.ts`) operate on
 * the SAME {@link ITestOrchestrator} singleton (`testingWiring.ts`), so a
 * session an agent runs appears in this UI and vice-versa.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { buildReport } from './reportBuilder';
import type { IAppDetector } from './appDetector';
import type { IScenarioGenerator } from './scenarioGenerator';
import type { ITestOrchestrator } from './testOrchestrator';
import type {
  AppUnderTest,
  DetectProgress,
  GenerateProgress,
  TestPlatform,
  TestScenario,
  TestStep,
  Viewport,
} from './testingTypes';

/** IPC channel names for the testing surface. Safe to import from the renderer. */
export const TESTING_CHANNELS = {
  listSessions: 'testing.list-sessions',
  getReport: 'testing.get-report',
  run: 'testing.run',
  generate: 'testing.generate',
  detectApp: 'testing.detect-app',
  detectProgress: 'testing.detect-progress',
  generateProgress: 'testing.generate-progress',
} as const;

/** A structured per-step row (mirrors reportBuilder.StructuredReport). */
export type TestingReportStep = {
  index: number;
  description: string;
  passed: boolean;
  detail?: string;
  screenshots: string[];
};

/** A structured report for the UI (mirrors reportBuilder.StructuredReport + markdown). */
export type TestingReport = {
  sessionId: string;
  scenarioName: string;
  platform: string;
  passed: boolean;
  status?: string;
  total: number;
  passedCount: number;
  steps: TestingReportStep[];
  videoPath?: string;
  /** Setup error (e.g. the app failed to start) when status is 'error'. */
  error?: string;
  /** The raw markdown, for an IDE-style preview. */
  markdown?: string;
};

/** A session summary row for the list. */
export type TestingSessionSummary = {
  sessionId: string;
  name: string;
  platform: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error';
};

/** Request for {@link TESTING_CHANNELS.run}: submit a scenario to run. */
export type RunTestRequest = {
  /** Human-readable scenario name. */
  name: string;
  /** Target platform. */
  platform: TestPlatform;
  /** Ordered steps (one directive per line, see the web script grammar). */
  steps: TestStep[];
  /** Show the run instead of running hidden (default hidden). */
  visible?: boolean;
  /** Optional viewport for responsive checks. */
  viewport?: Viewport;
  /** Optional app-under-test declaration (web): start command + cwd + url. */
  app?: AppUnderTest;
};

/** Result of {@link TESTING_CHANNELS.run}: the finished session summary. */
export type RunTestResult = TestingSessionSummary & {
  /** Path of the generated markdown report, when available. */
  reportPath?: string;
};

/** Request for {@link TESTING_CHANNELS.generate}: describe a test in plain language. */
export type GenerateTestRequest = {
  /** Plain-language description of what to test. */
  description: string;
  /** Target platform. */
  platform: TestPlatform;
  /** Optional preferred model id. */
  model?: string;
  /** Optional URL of the app under test (web) so steps navigate there, not example.com. */
  appUrl?: string;
};

/** Result of {@link TESTING_CHANNELS.generate}: an editable scenario draft. */
export type GenerateTestResult = {
  /** Suggested scenario name. */
  name: string;
  /** Generated steps in the script grammar (editable before running). */
  steps: TestStep[];
};

/** Request for {@link TESTING_CHANNELS.detectApp}: read a project folder. */
export type DetectAppRequest = {
  /** Absolute path of the project source folder. */
  projectDir: string;
  /** Optional preferred model id. */
  model?: string;
  /** Force fresh detection, ignoring the cached `<name>-data.json`. */
  refresh?: boolean;
};

/** Typed testing IPC channels. Exported for Task 15.1 registration wiring. */
export const testingChannels = {
  listSessions: bridge.buildProvider<TestingSessionSummary[], void>(TESTING_CHANNELS.listSessions),
  getReport: bridge.buildProvider<TestingReport | undefined, { sessionId: string }>(TESTING_CHANNELS.getReport),
  run: bridge.buildProvider<RunTestResult, RunTestRequest>(TESTING_CHANNELS.run),
  generate: bridge.buildProvider<GenerateTestResult, GenerateTestRequest>(TESTING_CHANNELS.generate),
  detectApp: bridge.buildProvider<AppUnderTest, DetectAppRequest>(TESTING_CHANNELS.detectApp),
  detectProgress: bridge.buildEmitter<DetectProgress>(TESTING_CHANNELS.detectProgress),
  generateProgress: bridge.buildEmitter<GenerateProgress>(TESTING_CHANNELS.generateProgress),
};

/** Options for {@link registerTestingBridge}. */
export type RegisterTestingBridgeOptions = {
  /** The shared orchestrator both planes drive. */
  orchestrator: ITestOrchestrator;
  /** Optional generator that turns a description into a scenario draft. */
  scenarioGenerator?: IScenarioGenerator;
  /** Optional detector that reads a project folder to propose how to run it. */
  appDetector?: IAppDetector;
};

/** Project a session onto its list-row summary. */
const toSummary = (session: {
  id: string;
  scenario: { name: string; platform: string };
  status: TestingSessionSummary['status'];
}): TestingSessionSummary => ({
  sessionId: session.id,
  name: session.scenario.name,
  platform: session.scenario.platform,
  status: session.status,
});

/**
 * Register the testing IPC handlers. Intended to be invoked once during
 * Main-process bootstrap (Task 15.1).
 *
 * @param options The shared orchestrator. See {@link RegisterTestingBridgeOptions}.
 */
export function registerTestingBridge(options: RegisterTestingBridgeOptions): void {
  const { orchestrator, scenarioGenerator, appDetector } = options;

  // Newest first, so the UI shows the most recent runs on top.
  testingChannels.listSessions.provider(() => Promise.resolve(orchestrator.listSessions().map(toSummary).toReversed()));

  // Build the structured + markdown report for one session on demand.
  testingChannels.getReport.provider(({ sessionId }) => {
    const session = orchestrator.getSession(sessionId);
    if (!session) return Promise.resolve(undefined);
    const { markdown, structured } = buildReport(session);
    const report: TestingReport = { ...structured, markdown };
    return Promise.resolve(report);
  });

  // Submit + run a scenario end to end, then resolve with the finished summary.
  testingChannels.run.provider(async ({ name, platform, steps, visible, viewport, app }) => {
    // Web convenience: when an app URL is given and the steps don't already
    // navigate, prepend a `goto <url>` so the run lands on the (freshly-started)
    // app automatically. Android/Windows launch their app via the platform
    // target, so no implicit step is injected for them.
    const hasGoto = steps.some((s) => /^\s*(goto|open)\b/i.test(s.description));
    const effectiveSteps: TestStep[] =
      platform === 'web' && app?.url && !hasGoto ? [{ id: 's0', description: `goto ${app.url}` }, ...steps] : steps;

    const scenario: TestScenario = {
      id: `scn-${Date.now()}`,
      name,
      platform,
      steps: effectiveSteps,
      viewport,
      app,
    };
    const session = await orchestrator.run(scenario, { visibility: visible ? 'visible' : 'hidden' });
    return { ...toSummary(session), reportPath: session.reportPath };
  });

  // Generate a scenario draft from a plain-language description (the user does
  // not have to know the step grammar). Throws a clear error when no generator
  // is wired or no model is configured; the renderer surfaces it as a message.
  testingChannels.generate.provider(async ({ description, platform, model, appUrl }) => {
    if (!scenarioGenerator) {
      throw new Error('Test generation is not available (no model generator wired).');
    }
    const draft = await scenarioGenerator.generate({
      description,
      platform,
      model,
      appUrl,
      onProgress: (progress) => testingChannels.generateProgress.emit(progress),
    });
    return { name: draft.name, steps: draft.steps };
  });

  // Read a project folder and propose how to start it (services + app + url).
  // Throws a clear error when no detector is wired or no model is configured;
  // the renderer surfaces it as a message. Progress is streamed live via the
  // `detectProgress` emitter so the page can show what the AI is reading/doing.
  testingChannels.detectApp.provider(async ({ projectDir, model, refresh }) => {
    if (!appDetector) {
      throw new Error('Project detection is not available (no detector wired).');
    }
    return appDetector.detect({
      projectDir,
      model,
      refresh,
      onProgress: (progress) => testingChannels.detectProgress.emit(progress),
    });
  });
}
