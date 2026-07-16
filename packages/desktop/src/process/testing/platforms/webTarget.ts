/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `webTarget` — web platform via the embedded browser + automation (Yêu cầu 2b,
 * criteria 2.1 / 2.6). The web target supports FREE viewport resizing across
 * phone / tablet / desktop / wide sizes (criterion 2.6). The browser provisioning
 * (open a controllable page on the isolated display) is injected so this module
 * only manages viewport selection + lifecycle.
 *
 * Main-process (Node.js) module — no DOM APIs.
 */

import type { Viewport } from '../testingTypes';
import type { IPlatformTarget, PreparedTarget } from './platformTarget';

/** Standard responsive presets offered for web testing (criterion 2.6). */
export const WEB_VIEWPORTS: Viewport[] = [
  { width: 375, height: 667, label: 'phone' },
  { width: 768, height: 1024, label: 'tablet' },
  { width: 1280, height: 800, label: 'desktop' },
  { width: 1920, height: 1080, label: 'wide' },
];

/** Provisions a controllable web page on the isolated display (injected). */
export type WebProvisioner = {
  /** Open a controllable browser context bound to `displayTarget` at `viewport`. */
  open(displayTarget: Record<string, string>, viewport: Viewport): Promise<{ target: Record<string, string> }>;
  /** Close the browser context. */
  close(target: Record<string, string>): Promise<void>;
};

/** Options for {@link createWebTarget}. */
export type WebTargetDeps = {
  /** Browser provisioner. */
  provisioner: WebProvisioner;
  /** Default viewport when none is given. Defaults to the `desktop` preset. */
  defaultViewport?: Viewport;
};

/**
 * Create the web {@link IPlatformTarget}. Web allows arbitrary viewport sizes,
 * not just the presets — any `Viewport` passed to {@link IPlatformTarget.prepare}
 * is honored.
 *
 * @param deps Provisioner + default viewport.
 * @returns A web platform target.
 */
export const createWebTarget = (deps: WebTargetDeps): IPlatformTarget => {
  const defaultViewport = deps.defaultViewport ?? WEB_VIEWPORTS[2];

  return {
    platform: 'web',
    availableViewports: () => [...WEB_VIEWPORTS],
    prepare: async (displayTarget, viewport): Promise<PreparedTarget> => {
      const chosen = viewport ?? defaultViewport;
      const { target } = await deps.provisioner.open(displayTarget, chosen);
      return { platform: 'web', target, viewport: chosen };
    },
    teardown: async (prepared) => {
      await deps.provisioner.close(prepared.target);
    },
  };
};
