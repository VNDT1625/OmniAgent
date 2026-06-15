/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared contract for platform targets (Yêu cầu 2b, criteria 2.1 / 2.6). A
 * platform target knows how to PREPARE a test environment for one platform on an
 * isolated virtual display, expose the size options, and TEAR it down. The
 * orchestrator pairs a target with a driver to run a scenario.
 *
 * Main-process types/contract only — concrete engines are injected per target.
 */

import type { AppUnderTest, TestPlatform, Viewport } from '../testingTypes';

/** A prepared platform environment, bound to an isolated display target. */
export type PreparedTarget = {
  /** Platform this environment serves. */
  platform: TestPlatform;
  /** The isolated virtual-display target the driver/recorder use. */
  target: Record<string, string>;
  /** The active viewport/size, when applicable. */
  viewport?: Viewport;
};

/** Contract every platform target implements. */
export type IPlatformTarget = {
  /** Platform handled. */
  readonly platform: TestPlatform;
  /** Size options offered for responsive testing (criterion 2.6). */
  availableViewports(): Viewport[];
  /**
   * Prepare the environment on `displayTarget` (already isolated). `viewport`
   * selects a size where supported. `app` carries the per-scenario app under
   * test (windows: `exePath`; android: `apkPath`/`appPackage`) so a target can
   * launch the right app instead of relying on a fixed bootstrap value.
   */
  prepare(displayTarget: Record<string, string>, viewport?: Viewport, app?: AppUnderTest): Promise<PreparedTarget>;
  /** Tear down the prepared environment. */
  teardown(prepared: PreparedTarget): Promise<void>;
};
