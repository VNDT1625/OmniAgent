/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DetectedCoreTarget } from '../coreAdapter';

/**
 * Creates runtime metadata for a configured remote gateway. Endpoint and
 * credential handles remain in the injected resolver, never in renderer-facing target metadata.
 */
export const createRemoteCoreTarget = (input: {
  id: string;
  name: string;
  detail?: string;
  available?: boolean;
}): DetectedCoreTarget => ({
  id: input.id.trim(),
  name: input.name.trim(),
  protocol: 'tomny-remote-v1',
  candidates: [],
  args: [],
  detail: input.detail?.trim() || 'Remote Tomny Core gateway',
  runnable: input.available !== false,
  detected: true,
  available: input.available !== false,
});
