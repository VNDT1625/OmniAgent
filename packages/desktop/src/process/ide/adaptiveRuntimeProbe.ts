/**
 * Adaptive runtime probe policy.
 *
 * The probe does not pretend that every platform exposes the same hooks. It
 * chooses the strongest adapter that is actually available and returns an
 * evidence contract that the renderer can show beside the trace.
 */

import type { CdpWebContents, TraceEvidence, TracePlatform } from './quickTestTracer';

export type AdaptiveProbeDeps = {
  getWebContents: () => CdpWebContents | null;
};

/** Select the strongest observable adapter without starting a session. */
export const selectAdaptiveEvidence = (
  platform: TracePlatform,
  hasWebContents: boolean,
  nativeStreamOpened: boolean,
  nativeAccessibilityAvailable = false
): TraceEvidence => {
  if (platform === 'web' && hasWebContents) {
    return {
      adapter: 'web-cdp',
      level: 'full',
      capabilities: ['interaction', 'network', 'stack', 'coverage'],
      noteKey: 'full',
    };
  }

  if (nativeStreamOpened && nativeAccessibilityAvailable) {
    return {
      adapter: 'native-accessibility',
      level: 'accessibility',
      capabilities: ['interaction', 'stack'],
      noteKey: 'accessibility',
    };
  }

  if (nativeStreamOpened) {
    return {
      adapter: 'native-log',
      level: 'runtime',
      capabilities: ['stack'],
      noteKey: 'runtime',
    };
  }

  return {
    adapter: 'visual-fallback',
    level: 'visual',
    capabilities: ['screen'],
    noteKey: 'visual',
  };
};

/**
 * Probe the current target before a native stream is opened. This keeps target
 * detection separate from the platform-specific process opener and makes it
 * possible to add UI Automation/Accessibility adapters without changing IPC.
 */
export const createAdaptiveRuntimeProbe = (deps: AdaptiveProbeDeps) => ({
  inspect(platform: TracePlatform, nativeStreamOpened = false, nativeAccessibilityAvailable = false): TraceEvidence {
    return selectAdaptiveEvidence(
      platform,
      Boolean(deps.getWebContents()),
      nativeStreamOpened,
      nativeAccessibilityAvailable
    );
  },
});
