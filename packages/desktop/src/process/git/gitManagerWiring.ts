/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `gitManagerWiring` — assembles the Git Manager services once (repo store,
 * encrypted credential store, git runner) and caches the singleton so the bridge
 * registration reuses one instance. Mirrors `terminalWiring`'s lazy-build seam.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { createGitCredentialStore } from './gitCredentialStore';
import { createGitRepoStore } from './gitRepoStore';
import { createGitRunner } from './gitRunner';
import type { GitManagerServices } from './gitManagerBridge';

let services: GitManagerServices | undefined;

/** Build (once) and return the Git Manager services. */
export const getGitManagerServices = (): GitManagerServices => {
  if (services) return services;
  services = {
    repoStore: createGitRepoStore(),
    credentialStore: createGitCredentialStore(),
    runner: createGitRunner(),
  };
  return services;
};

/** Reset the cached services (deterministic teardown for tests / hot-reload). */
export const disposeGitManagerServices = (): void => {
  services = undefined;
};
