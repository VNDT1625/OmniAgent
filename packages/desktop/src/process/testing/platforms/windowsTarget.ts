/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `windowsTarget` — Windows platform: a real `.exe` launched INSIDE the isolated
 * virtual display (Yêu cầu 2b, criterion 2.1). Critically, the app runs on the
 * isolated display only — never on the user's real desktop (criterion 2.2 /
 * Property 1). The process launcher is injected so this module only manages the
 * app lifecycle on the given (already-isolated) display target.
 *
 * Main-process (Node.js) module — no DOM APIs.
 */

import type { AppUnderTest, Viewport } from '../testingTypes';
import type { IPlatformTarget, PreparedTarget } from './platformTarget';

/** Launches/terminates a .exe on an isolated display (injected). */
export type AppLauncher = {
  /** Launch `exePath` on `displayTarget`; resolve with the app's control target. */
  launch(exePath: string, displayTarget: Record<string, string>): Promise<{ target: Record<string, string> }>;
  /** Terminate the launched app. */
  terminate(target: Record<string, string>): Promise<void>;
};

/** Options for {@link createWindowsTarget}. */
export type WindowsTargetDeps = {
  /** Default path of the .exe under test (used when a scenario omits `app.exePath`). */
  exePath?: string;
  /** App launcher. */
  launcher: AppLauncher;
  /** Window sizes offered for the desktop app. Defaults to a single desktop size. */
  viewports?: Viewport[];
};

/** Default desktop window sizes for Windows app testing. */
const DEFAULT_WINDOWS_VIEWPORTS: Viewport[] = [
  { width: 1280, height: 800, label: 'desktop' },
  { width: 1920, height: 1080, label: 'wide' },
];

/**
 * Create the Windows {@link IPlatformTarget}. The .exe is launched on the
 * isolated display passed to {@link IPlatformTarget.prepare}; it never touches
 * the real desktop. The exe path is taken per-scenario from `app.exePath` (what
 * the user picks in the UI), falling back to the deps default / env var.
 *
 * @param deps default exe path + launcher + optional window sizes.
 * @returns A Windows platform target.
 */
export const createWindowsTarget = (deps: WindowsTargetDeps): IPlatformTarget => {
  const viewports = deps.viewports ?? DEFAULT_WINDOWS_VIEWPORTS;

  return {
    platform: 'windows',
    availableViewports: () => [...viewports],
    prepare: async (displayTarget, viewport, app?: AppUnderTest): Promise<PreparedTarget> => {
      const exePath = app?.exePath?.trim() || deps.exePath?.trim() || '';
      const { target } = await deps.launcher.launch(exePath, displayTarget);
      return { platform: 'windows', target, viewport: viewport ?? viewports[0] };
    },
    teardown: async (prepared) => {
      await deps.launcher.terminate(prepared.target);
    },
  };
};
