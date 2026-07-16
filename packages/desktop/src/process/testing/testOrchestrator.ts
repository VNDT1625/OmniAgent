/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `testOrchestrator` — coordinates a multi-platform test session end to end
 * (Yêu cầu 2b, criteria 2.3 / 2.7 / 2.10): acquire an isolated display, prepare
 * the platform target, start recording, run each step via the chosen driver
 * (script preferred, computer-use fallback), build the `.md` report, and tear
 * everything down. Concurrency is gated by the ResourceCoordinator under
 * `TaskKind: 'windowsTest' | 'emulator'` (criteria 2.7 / 2.10), so over-budget
 * sessions queue instead of overloading the machine.
 *
 * Everything heavy is injected (display manager, platform targets, drivers,
 * recorder, report builder, lease coordinator) so the orchestrator is fully
 * unit-testable without a real display/emulator. Process boundary: Main-process.
 */

import type { Lease, LeaseRequest, TaskKind } from '../resource/leaseTypes';
import type { ITestDriver } from './scriptDriver';
import type { IRecorder } from './recorder';
import type { IVirtualDisplayManager } from './virtualDisplayManager';
import type { IPlatformTarget } from './platforms/platformTarget';
import type { IAppLauncher, RunningApp } from './appLauncher';
import { buildReport, type BuiltReport } from './reportBuilder';
import type { SessionVisibility, StepResult, TestPlatform, TestScenario, TestSession } from './testingTypes';

/** Minimal lease surface (the real ResourceCoordinator satisfies it). */
export type LeaseCoordinator = {
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  releaseLease: (id: string) => void;
};

/** Persists a generated report; returns the written path. */
export type ReportWriter = (sessionId: string, report: BuiltReport) => Promise<string>;

/** Options for {@link createTestOrchestrator}. */
export type TestOrchestratorDeps = {
  /** Allocates isolated virtual displays (never the real desktop). */
  displayManager: IVirtualDisplayManager;
  /** Platform targets keyed implicitly by their `platform`. */
  targets: IPlatformTarget[];
  /** Preferred (script) driver. */
  scriptDriver: ITestDriver;
  /** Fallback (computer-use) driver. */
  computerUseDriver: ITestDriver;
  /** Recorder (always records video + milestone screenshots). */
  recorder: IRecorder;
  /** Lease gate for concurrency/queueing (criteria 2.7 / 2.10). */
  coordinator: LeaseCoordinator;
  /** Persists the markdown report; returns its path. */
  writeReport: ReportWriter;
  /**
   * Optional launcher that boots the web app under test (e.g. `npm run dev`)
   * before a scenario with `scenario.app` runs, and stops it afterwards. When
   * absent, `scenario.app` is ignored and steps must navigate to a running URL.
   */
  appLauncher?: IAppLauncher;
  /** Estimated RAM (MB) per session. Defaults to 1024. */
  estCostMB?: number;
  /** Unique id generator. Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
};

/** Options for a single {@link ITestOrchestrator.run}. */
export type RunOptions = {
  /** Show the run or keep it hidden (criterion 2.3). Defaults to `hidden`. */
  visibility?: SessionVisibility;
  /** Force the fallback computer-use driver instead of the script driver. */
  preferComputerUse?: boolean;
};

/** Public contract of the test orchestrator. */
export type ITestOrchestrator = {
  /** Run a scenario end to end and return the completed session. */
  run(scenario: TestScenario, options?: RunOptions): Promise<TestSession>;
  /** Look up a session by id. */
  getSession(id: string): TestSession | undefined;
  /** All sessions, oldest first. */
  listSessions(): TestSession[];
};

/** Map a platform to the heavy-task lease kind it consumes (criterion 2.7). */
const leaseKindForPlatform = (platform: TestPlatform): TaskKind => {
  if (platform === 'windows') return 'windowsTest';
  if (platform === 'android') return 'emulator';
  return 'browser'; // web testing runs in an embedded browser
};

/** Default estimated RAM (MB) charged per test session. */
const DEFAULT_EST_COST_MB = 1024;

/**
 * Create an {@link ITestOrchestrator} from the injected building blocks.
 *
 * @param deps All testing collaborators. See {@link TestOrchestratorDeps}.
 * @returns A ready-to-use orchestrator.
 */
export const createTestOrchestrator = (deps: TestOrchestratorDeps): ITestOrchestrator => {
  const estCostMB = deps.estCostMB ?? DEFAULT_EST_COST_MB;
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());

  const targetByPlatform = new Map<TestPlatform, IPlatformTarget>();
  for (const target of deps.targets) targetByPlatform.set(target.platform, target);

  const sessions = new Map<string, TestSession>();

  const transition = (session: TestSession, patch: Partial<Omit<TestSession, 'id'>>): void => {
    Object.assign(session, patch, { updatedAt: now() });
  };

  const run: ITestOrchestrator['run'] = async (scenario, options = {}) => {
    const visibility: SessionVisibility = options.visibility ?? 'hidden';
    const ts = now();
    const session: TestSession = {
      id: generateId(),
      scenario,
      visibility,
      status: 'queued',
      results: [],
      createdAt: ts,
      updatedAt: ts,
    };
    sessions.set(session.id, session);

    const platformTarget = targetByPlatform.get(scenario.platform);
    if (!platformTarget) {
      transition(session, { status: 'error', error: `No platform target for "${scenario.platform}"` });
      return session;
    }

    const driver: ITestDriver = options.preferComputerUse ? deps.computerUseDriver : deps.scriptDriver;

    // Gate concurrency: requestLease queues the session until budget frees
    // (criteria 2.7 / 2.10). Released in finally so the budget always recovers.
    const lease = await deps.coordinator.requestLease({ kind: leaseKindForPlatform(scenario.platform), estCostMB });
    transition(session, { status: 'running' });

    const display = await deps.displayManager.acquire().catch((error: unknown): undefined => {
      transition(session, { status: 'error', error: error instanceof Error ? error.message : String(error) });
      return undefined;
    });
    if (!display) {
      deps.coordinator.releaseLease(lease.id);
      return session;
    }

    let prepared: Awaited<ReturnType<IPlatformTarget['prepare']>> | undefined;
    let recording: Awaited<ReturnType<IRecorder['start']>> | undefined;
    let runningApp: RunningApp | undefined;
    try {
      // Optionally boot the web app under test (e.g. `npm run dev`) and wait for
      // its URL, so the user/agent doesn't have to start it by hand. Web-only —
      // windows/android get their app info via the platform target below. A
      // failure here ends the session as `error` with the launcher's message.
      if (scenario.platform === 'web' && scenario.app && deps.appLauncher) {
        runningApp = await deps.appLauncher.start(scenario.app);
      }

      prepared = await platformTarget.prepare(display.target, scenario.viewport, scenario.app);
      recording = await deps.recorder.start(session.id, prepared.target);

      const results: StepResult[] = [];
      for (const step of scenario.steps) {
        const outcome = await driver.runStep(step, { platform: scenario.platform, target: prepared.target });
        const shot = await deps.recorder.snapshot(recording, step.id);
        results.push({ step, passed: outcome.passed, detail: outcome.detail, screenshots: [shot], at: now() });
        transition(session, { results: [...results] });
      }

      const allPassed = results.length > 0 && results.every((r) => r.passed);
      transition(session, { status: allPassed ? 'passed' : 'failed' });
    } catch (error) {
      transition(session, { status: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      // Always stop recording, tear down the env + display, stop the launched
      // app, release the lease.
      if (recording) {
        const { videoPath } = await deps.recorder
          .stop(recording)
          .catch((): { videoPath: string | undefined } => ({ videoPath: undefined }));
        if (videoPath) transition(session, { videoPath });
      }
      if (prepared) await platformTarget.teardown(prepared).catch((): undefined => undefined);
      if (runningApp) await runningApp.stop().catch((): undefined => undefined);
      await deps.displayManager.release(display.id).catch((): undefined => undefined);
      deps.coordinator.releaseLease(lease.id);
    }

    // Build + persist the report regardless of pass/fail (criterion 2.5).
    const report = buildReport(session);
    const reportPath = await deps.writeReport(session.id, report).catch((): undefined => undefined);
    if (reportPath) transition(session, { reportPath });

    return session;
  };

  const getSession: ITestOrchestrator['getSession'] = (id) => {
    const s = sessions.get(id);
    return s ? { ...s } : undefined;
  };

  const listSessions: ITestOrchestrator['listSessions'] = () => [...sessions.values()].map((s) => ({ ...s }));

  return { run, getSession, listSessions };
};
