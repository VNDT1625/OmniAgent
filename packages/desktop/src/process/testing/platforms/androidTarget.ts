/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `androidTarget` — Android platform via an emulator (Yêu cầu 2b, criteria 2.1 /
 * 2.6). Unlike web, the size is chosen per AVD (Android Virtual Device) config,
 * not freely (criterion 2.6). The emulator provisioning (boot an AVD, expose its
 * adb target) is injected so this module only manages AVD selection + lifecycle.
 *
 * Main-process (Node.js) module — no DOM APIs.
 */

import type { AppUnderTest, Viewport } from '../testingTypes';
import type { IPlatformTarget, PreparedTarget } from './platformTarget';

/** An AVD configuration option (a device profile with a fixed resolution). */
export type AvdProfile = {
  /** AVD name as known to the emulator. */
  avdName: string;
  /** The device's screen size. */
  viewport: Viewport;
};

/** Boots/stops an Android emulator AVD (injected; wraps adb/emulator in prod). */
export type EmulatorProvisioner = {
  /** Boot `avdName` bound to `displayTarget`; resolve with its adb target. */
  boot(avdName: string, displayTarget: Record<string, string>): Promise<{ target: Record<string, string> }>;
  /** Shut down the emulator. */
  shutdown(target: Record<string, string>): Promise<void>;
  /** Optionally install an APK onto the booted device (no-op when unsupported). */
  installApk?(target: Record<string, string>, apkPath: string): Promise<void>;
};

/** Options for {@link createAndroidTarget}. */
export type AndroidTargetDeps = {
  /** Emulator provisioner. */
  provisioner: EmulatorProvisioner;
  /** Configured AVD profiles selectable for testing. */
  profiles: AvdProfile[];
};

/**
 * Create the Android {@link IPlatformTarget}. Viewports come from the configured
 * AVD profiles; when a `viewport` is requested, the closest matching AVD by label
 * (else the first profile) is booted. When the scenario's `app.apkPath` is set,
 * it is installed after boot; `app.appPackage` is threaded into the target so the
 * driver can auto-launch it.
 *
 * @param deps Provisioner + AVD profiles.
 * @returns An Android platform target.
 */
export const createAndroidTarget = (deps: AndroidTargetDeps): IPlatformTarget => {
  if (deps.profiles.length === 0) {
    throw new Error('[AndroidTarget] At least one AVD profile must be configured.');
  }

  const pickProfile = (viewport?: Viewport): AvdProfile => {
    if (!viewport) return deps.profiles[0];
    return (
      deps.profiles.find((p) => p.viewport.label === viewport.label) ??
      deps.profiles.find((p) => p.viewport.width === viewport.width && p.viewport.height === viewport.height) ??
      deps.profiles[0]
    );
  };

  return {
    platform: 'android',
    availableViewports: () => deps.profiles.map((p) => ({ ...p.viewport })),
    prepare: async (displayTarget, viewport, app?: AppUnderTest): Promise<PreparedTarget> => {
      const profile = pickProfile(viewport);
      const { target } = await deps.provisioner.boot(profile.avdName, displayTarget);
      // Install the APK under test (if provided) so the scenario can launch it.
      const apkPath = app?.apkPath?.trim();
      if (apkPath && deps.provisioner.installApk) {
        await deps.provisioner.installApk(target, apkPath);
      }
      // Thread the package id through so the script engine can auto-launch it.
      const appPackage = app?.appPackage?.trim();
      const enrichedTarget = appPackage ? { ...target, appPackage } : target;
      return { platform: 'android', target: enrichedTarget, viewport: profile.viewport };
    },
    teardown: async (prepared) => {
      await deps.provisioner.shutdown(prepared.target);
    },
  };
};
