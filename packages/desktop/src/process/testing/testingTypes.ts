/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the multi-platform testing layer (Yêu cầu 2b). Kept in one
 * module so the orchestrator, drivers, platform targets, recorder and report
 * builder reuse the same shapes without circular imports.
 *
 * Process boundary: Main-process (Node.js) types only — no DOM, no runtime.
 */

/** Platforms an agent can test (criterion 2b.1). iOS is out of scope (2b.9). */
export type TestPlatform = 'web' | 'android' | 'windows';

/** Whether the test session is shown to the user or runs hidden (criterion 2b.3). */
export type SessionVisibility = 'visible' | 'hidden';

/** How automation drives the target (criterion 2b.8). */
export type DriverKind = 'script' | 'computer-use';

/** A screen size for responsive evaluation (criterion 2b.6). */
export type Viewport = {
  /** Logical width in pixels. */
  width: number;
  /** Logical height in pixels. */
  height: number;
  /** Optional label (e.g. `phone`, `tablet`, `desktop`). */
  label?: string;
};

/**
 * How the launcher knows a service has finished starting up. Backends often
 * have no page URL, so several readiness strategies are supported:
 * - `url`   — poll an HTTP(S) URL until it responds (any status).
 * - `port`  — poll a TCP port until something accepts a connection.
 * - `log`   — scan the service's stdout/stderr until a substring/regex appears.
 * - `delay` — simply wait a fixed number of milliseconds.
 * When omitted, the service is started fire-and-forget (not waited on).
 */
export type ServiceReadiness =
  | { type: 'url'; url: string }
  | { type: 'port'; port: number }
  | { type: 'log'; match: string }
  | { type: 'delay'; ms: number };

/**
 * One background command to run before the test (e.g. a backend API, a database,
 * a queue worker). Started in order; torn down in reverse after the run.
 */
export type ServiceSpec = {
  /** Human-readable label shown in the UI/report (e.g. "API", "Postgres"). */
  name?: string;
  /** Shell command that starts the service (e.g. `npm run start:api`). */
  command: string;
  /** Working directory the command runs in. */
  cwd?: string;
  /** How to know the service is ready before starting the next one. */
  ready?: ServiceReadiness;
  /** Max time (ms) to wait for readiness. Defaults to 60s. */
  readyTimeoutMs?: number;
};

/**
 * Declares how to start (or where to find) the app under test.
 *
 * Web uses `url` (+ optional `command`/`services` to boot a dev server).
 * Windows uses `exePath` (the `.exe` to launch and drive).
 * Android uses `apkPath` (an APK to install first, optional) and/or
 * `appPackage` (the package to launch, e.g. `com.example.app`).
 *
 * Real apps often need more than one process (a backend API, a database, extra
 * services). Declare those in {@link AppUnderTest.services}; they are started in
 * order BEFORE the main app, each waited on per its readiness, and stopped in
 * reverse order after the run.
 */
export type AppUnderTest = {
  /**
   * Shell command that starts the app (web only, e.g. `npm run dev`). When
   * omitted, the app is assumed already running and only {@link AppUnderTest.url}
   * is probed.
   */
  command?: string;
  /** Working directory the command runs in (the project folder). */
  cwd?: string;
  /** The dev URL to wait for and navigate to (web only, e.g. `http://localhost:5173`). */
  url?: string;
  /** Max time (ms) to wait for the URL to respond. Defaults to 60s. */
  readyTimeoutMs?: number;
  /**
   * Extra services (backend, db, workers) started — in order — BEFORE the main
   * app `command`, and stopped in reverse order afterwards. Each is waited on
   * per its own readiness check.
   */
  services?: ServiceSpec[];
  /** Absolute path of the `.exe` under test (Windows only). */
  exePath?: string;
  /** Absolute path of an APK to install before the test (Android only, optional). */
  apkPath?: string;
  /** App package id to launch (Android only, e.g. `com.example.app`). */
  appPackage?: string;
};

/** One step in a test scenario. */
export type TestStep = {
  /** Stable id of the step. */
  id: string;
  /** Human-readable description of what the step does. */
  description: string;
};

/** A test scenario to run against a target. */
export type TestScenario = {
  /** Stable id of the scenario / suite. */
  id: string;
  /** Human-readable scenario name. */
  name: string;
  /** Platform this scenario targets. */
  platform: TestPlatform;
  /** The ordered steps to perform. */
  steps: TestStep[];
  /** Optional viewport for web/android responsive checks. */
  viewport?: Viewport;
  /**
   * Optional declaration of how to start the app under test (web only). When
   * `app.command` is set, the orchestrator boots it (e.g. `npm run dev` in
   * `app.cwd`), waits until `app.url` responds, runs the scenario, then stops
   * the spawned process. When omitted, steps must navigate to an already-running
   * URL via a `goto` step.
   */
  app?: AppUnderTest;
};

/** Outcome of a single executed step. */
export type StepResult = {
  /** The step that ran. */
  step: TestStep;
  /** Whether the step passed. */
  passed: boolean;
  /** Optional detail (assertion message, error). */
  detail?: string;
  /** Paths of milestone screenshots captured for this step. */
  screenshots: string[];
  /** Unix-ms timestamp when the step finished. */
  at: number;
};

/** Lifecycle state of a test session. */
export type TestSessionStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error';

/** A recorded test session, surfaced to the UI + report. */
export type TestSession = {
  /** Unique id of the session. */
  id: string;
  /** The scenario being run. */
  scenario: TestScenario;
  /** Whether the run is shown or hidden. */
  visibility: SessionVisibility;
  /** Current lifecycle state. */
  status: TestSessionStatus;
  /** Per-step results, in order. */
  results: StepResult[];
  /** Path of the recorded video, when available. */
  videoPath?: string;
  /** Path of the generated markdown report, when available. */
  reportPath?: string;
  /** Unix-ms timestamps. */
  createdAt: number;
  updatedAt: number;
  /** Failure message when `status === 'error'`. */
  error?: string;
};

/** Phase of an app-detection run, surfaced live to the Testing page. */
export type DetectPhase = 'scanning' | 'reading' | 'analyzing' | 'parsing' | 'cache' | 'done' | 'error';

/**
 * A live progress update emitted while {@link IAppDetector.detect} reads a
 * project and asks the model how to run it. Streamed Main → renderer so the
 * Testing page can show a status bar ("reading package.json", "asking the
 * model…") instead of an opaque spinner.
 */
export type DetectProgress = {
  /** The project folder being detected (so the UI can correlate runs). */
  projectDir: string;
  /** Which phase the detection is in. */
  phase: DetectPhase;
  /** Human-readable detail (e.g. the file being read, or an error message). */
  message: string;
  /** Optional 0–100 completion estimate for the current run. */
  percent?: number;
};

/** Callback invoked with each {@link DetectProgress} update during detection. */
export type DetectProgressFn = (progress: DetectProgress) => void;

/** Phase of a scenario-generation run, surfaced live to the Testing page. */
export type GeneratePhase = 'preparing' | 'thinking' | 'parsing' | 'done' | 'error';

/**
 * A live progress update emitted while {@link IScenarioGenerator.generate} turns
 * a plain-language description into concrete steps. Streamed Main → renderer so
 * the Testing page can show a status bar ("asking the model…", "building
 * steps…") instead of a bare button spinner — the user sees what the AI is doing.
 */
export type GenerateProgress = {
  /** Which phase the generation is in. */
  phase: GeneratePhase;
  /**
   * Human-readable detail: the model id while `thinking`, the produced step
   * count while `done`, or the error message while `error`.
   */
  message: string;
  /** Optional 0–100 completion estimate for the current run. */
  percent?: number;
};

/** Callback invoked with each {@link GenerateProgress} update during generation. */
export type GenerateProgressFn = (progress: GenerateProgress) => void;
