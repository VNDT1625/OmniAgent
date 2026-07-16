/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `scriptDriver` — the PREFERRED automation driver (Yêu cầu 2b, criterion 2.8a):
 * script-based automation (Playwright for web, adb/UIAutomator for Android,
 * AutoHotkey/nut.js for Windows). Fast and reliable for greenfield/bulk work.
 *
 * The concrete per-platform script engines are INJECTED so this module only
 * orchestrates step execution + isolation, and stays unit-testable without a
 * real browser/emulator. All actions run against the isolated virtual-display
 * `target` (criterion 2.8 — cách ly khỏi thao tác người dùng); the driver never
 * issues OS-global input itself.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { DriverKind, TestPlatform, TestStep } from './testingTypes';

/** Result of executing one step via a driver. */
export type DriverStepResult = {
  /** Whether the step succeeded. */
  passed: boolean;
  /** Optional detail (assertion/error text). */
  detail?: string;
};

/** Context handed to a driver for a run: the isolated display target + platform. */
export type DriverContext = {
  /** Platform being driven. */
  platform: TestPlatform;
  /** The isolated virtual-display target (never the real desktop). */
  target: Record<string, string>;
};

/** Common contract implemented by both the script and computer-use drivers. */
export type ITestDriver = {
  /** Which kind of driver this is. */
  readonly kind: DriverKind;
  /** Execute a single step within the run context. */
  runStep(step: TestStep, context: DriverContext): Promise<DriverStepResult>;
};

/**
 * A per-platform script engine (Playwright / adb / nut.js). Injected; the driver
 * picks the engine matching the run's platform.
 */
export type ScriptEngine = {
  /** Platform this engine automates. */
  readonly platform: TestPlatform;
  /** Run one step against the isolated target. */
  execute(step: TestStep, target: Record<string, string>): Promise<DriverStepResult>;
};

/** Options for {@link createScriptDriver}. */
export type ScriptDriverDeps = {
  /** Script engines keyed implicitly by their `platform`. */
  engines: ScriptEngine[];
};

/**
 * Create the script-based {@link ITestDriver}.
 *
 * @param deps The per-platform script engines.
 * @returns A driver that dispatches each step to the matching engine.
 */
export const createScriptDriver = (deps: ScriptDriverDeps): ITestDriver => {
  const byPlatform = new Map<TestPlatform, ScriptEngine>();
  for (const engine of deps.engines) byPlatform.set(engine.platform, engine);

  const runStep = async (step: TestStep, context: DriverContext): Promise<DriverStepResult> => {
    const engine = byPlatform.get(context.platform);
    if (!engine) {
      return { passed: false, detail: `No script engine for platform "${context.platform}"` };
    }
    return engine.execute(step, context.target);
  };

  return { kind: 'script', runStep };
};
