/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Testing surface (Yêu cầu 2b). Mirrors the
 * company/browser bridge-client pattern: it rebuilds typed invokers from the
 * channel-name strings (so the renderer never imports a Node-only bridge module)
 * and wraps each call with a timeout so an unwired Main-process bridge (Task
 * 15.1) rejects with a clear error instead of hanging.
 *
 * NOTE: the Testing Main-process bridge is wired in Task 15.1; until then these
 * calls reject and the UI shows a friendly "not available" state.
 */

import { bridge } from '@office-ai/platform';

/** IPC channel names for the testing surface (renderer-safe contract). */
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

/** A structured report for the UI (mirrors reportBuilder.StructuredReport). */
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

/** Default per-call timeout (ms) before treating the bridge as unavailable. */
const CALL_TIMEOUT_MS = 8000;

/** A platform an agent/user can test (mirrors testingTypes.TestPlatform). */
export type TestingPlatform = 'web' | 'android' | 'windows';

/** A single scenario step (mirrors testingTypes.TestStep). */
export type TestingStep = {
  id: string;
  description: string;
};

/** A viewport for responsive checks (mirrors testingTypes.Viewport). */
export type TestingViewport = {
  width: number;
  height: number;
  label?: string;
};

/** How the launcher knows a service is ready (mirrors testingTypes.ServiceReadiness). */
export type ServiceReadiness =
  | { type: 'url'; url: string }
  | { type: 'port'; port: number }
  | { type: 'log'; match: string }
  | { type: 'delay'; ms: number };

/** A background service to start before the test (mirrors testingTypes.ServiceSpec). */
export type ServiceSpec = {
  name?: string;
  command: string;
  cwd?: string;
  ready?: ServiceReadiness;
  readyTimeoutMs?: number;
};

/** Declares how to start the app under test (mirrors testingTypes.AppUnderTest). */
export type AppUnderTest = {
  command?: string;
  cwd?: string;
  url?: string;
  readyTimeoutMs?: number;
  services?: ServiceSpec[];
  /** Windows: absolute path of the `.exe` to launch and drive. */
  exePath?: string;
  /** Android: absolute path of an APK to install before the test (optional). */
  apkPath?: string;
  /** Android: app package id to launch (e.g. `com.example.app`). */
  appPackage?: string;
};

/** Request to run a scenario (mirrors testingBridge.RunTestRequest). */
export type RunTestRequest = {
  name: string;
  platform: TestingPlatform;
  steps: TestingStep[];
  visible?: boolean;
  viewport?: TestingViewport;
  app?: AppUnderTest;
};

/** Result of a run (mirrors testingBridge.RunTestResult). */
export type RunTestResult = TestingSessionSummary & { reportPath?: string };

/** Request to generate a scenario from a description (mirrors testingBridge.GenerateTestRequest). */
export type GenerateTestRequest = {
  description: string;
  platform: TestingPlatform;
  model?: string;
  appUrl?: string;
};

/** Result of generation: an editable scenario draft (mirrors testingBridge.GenerateTestResult). */
export type GenerateTestResult = {
  name: string;
  steps: TestingStep[];
};

/** Request to detect how to run a project (mirrors testingBridge.DetectAppRequest). */
export type DetectAppRequest = {
  projectDir: string;
  model?: string;
  refresh?: boolean;
};

/** Phase of an app-detection run (mirrors testingTypes.DetectPhase). */
export type DetectPhase = 'scanning' | 'reading' | 'analyzing' | 'parsing' | 'cache' | 'done' | 'error';

/** A live progress update for app detection (mirrors testingTypes.DetectProgress). */
export type DetectProgress = {
  projectDir: string;
  phase: DetectPhase;
  message: string;
  percent?: number;
};

/** Phase of a scenario-generation run (mirrors testingTypes.GeneratePhase). */
export type GeneratePhase = 'preparing' | 'thinking' | 'parsing' | 'done' | 'error';

/** A live progress update for scenario generation (mirrors testingTypes.GenerateProgress). */
export type GenerateProgress = {
  phase: GeneratePhase;
  message: string;
  percent?: number;
};

const listSessionsProvider = bridge.buildProvider<TestingSessionSummary[], void>(TESTING_CHANNELS.listSessions);
const getReportProvider = bridge.buildProvider<TestingReport | undefined, { sessionId: string }>(
  TESTING_CHANNELS.getReport
);
const runProvider = bridge.buildProvider<RunTestResult, RunTestRequest>(TESTING_CHANNELS.run);
const generateProvider = bridge.buildProvider<GenerateTestResult, GenerateTestRequest>(TESTING_CHANNELS.generate);
const detectAppProvider = bridge.buildProvider<AppUnderTest, DetectAppRequest>(TESTING_CHANNELS.detectApp);
const detectProgressEmitter = bridge.buildEmitter<DetectProgress>(TESTING_CHANNELS.detectProgress);
const generateProgressEmitter = bridge.buildEmitter<GenerateProgress>(TESTING_CHANNELS.generateProgress);

/** Reject if the underlying invoke does not settle within the timeout. */
const withTimeout = <T>(p: Promise<T>, label: string, ms = CALL_TIMEOUT_MS, timeoutMessage?: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage ?? `Testing bridge "${label}" is not available yet.`)), ms)
    ),
  ]);

/** The renderer-facing Testing client. */
export const testingClient = {
  /** List all test sessions (newest first). */
  listSessions: (): Promise<TestingSessionSummary[]> => withTimeout(listSessionsProvider.invoke(), 'listSessions'),
  /** Fetch the structured report for a session. */
  getReport: (sessionId: string): Promise<TestingReport | undefined> =>
    withTimeout(getReportProvider.invoke({ sessionId }), 'getReport'),
  /**
   * Submit a scenario and run it end to end. A run can take a while (it boots a
   * surface, executes each step, records, and writes the report), so it uses a
   * generous timeout.
   */
  run: (request: RunTestRequest): Promise<RunTestResult> => withTimeout(runProvider.invoke(request), 'run', 120_000),
  /**
   * Generate an editable scenario draft from a plain-language description, using
   * the user's configured model. The backend caps the model round-trip at ~45s,
   * so the client waits a bit longer (70s) to let the real backend result (or
   * its specific error) win the race — otherwise a generic "unavailable" would
   * mask a slow-but-working model. On a true timeout the message says the model
   * is taking too long (not "not wired").
   */
  generate: (request: GenerateTestRequest): Promise<GenerateTestResult> =>
    withTimeout(
      generateProvider.invoke(request),
      'generate',
      70_000,
      'The model is taking too long to design the test. Try a faster model, or simplify your description.'
    ),
  /**
   * Read a project folder and propose how to run it (services + app + url),
   * using the user's configured model. Bounded so the UI never spins forever.
   */
  detectApp: (request: DetectAppRequest): Promise<AppUnderTest> =>
    withTimeout(detectAppProvider.invoke(request), 'detectApp', 50_000),
  /**
   * Subscribe to live app-detection progress (Main → renderer). Returns an
   * unsubscribe fn. Lets the page show what the AI is reading/doing instead of
   * an opaque spinner.
   */
  onDetectProgress: (listener: (progress: DetectProgress) => void): (() => void) => detectProgressEmitter.on(listener),
  /**
   * Subscribe to live scenario-generation progress (Main → renderer). Returns an
   * unsubscribe fn. Lets the page show what the AI is doing (preparing →
   * thinking → parsing) instead of a bare button spinner.
   */
  onGenerateProgress: (listener: (progress: GenerateProgress) => void): (() => void) =>
    generateProgressEmitter.on(listener),
};
