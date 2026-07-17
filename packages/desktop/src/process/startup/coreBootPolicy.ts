/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

export type CoreBootMode = 'tomny' | 'compat' | 'legacy';

export type CoreBootPolicy = {
  mode: CoreBootMode;
  startLegacyBackend: boolean;
  requireLegacyBackend: boolean;
};

type ResolveCoreBootPolicyInput = {
  requestedMode?: string;
  isWebUIMode?: boolean;
  isResetPasswordMode?: boolean;
};

const VALID_MODES = new Set<CoreBootMode>(['tomny', 'compat', 'legacy']);

/**
 * Resolves the desktop core cutover policy without touching the legacy binary.
 * Tomny is the desktop default; HTTP compatibility must be explicitly enabled.
 */
export function resolveCoreBootPolicy(input: ResolveCoreBootPolicyInput = {}): CoreBootPolicy {
  const requested = input.requestedMode?.trim().toLowerCase();
  if (requested && !VALID_MODES.has(requested as CoreBootMode)) {
    throw new Error(`Invalid Tomny core boot mode ${input.requestedMode}. Expected one of: tomny, compat, legacy.`);
  }

  const requiresLegacyFeature = input.isWebUIMode === true || input.isResetPasswordMode === true;
  const mode = (requested || (requiresLegacyFeature ? 'legacy' : 'tomny')) as CoreBootMode;
  if (requiresLegacyFeature && mode === 'tomny') {
    throw new Error('WebUI and password reset require --core-mode=legacy or TOMNY_CORE_BOOT_MODE=legacy.');
  }

  if (requiresLegacyFeature || mode === 'legacy') {
    return { mode: 'legacy', startLegacyBackend: true, requireLegacyBackend: true };
  }
  if (mode === 'compat') {
    return { mode, startLegacyBackend: true, requireLegacyBackend: false };
  }
  return { mode, startLegacyBackend: false, requireLegacyBackend: false };
}
