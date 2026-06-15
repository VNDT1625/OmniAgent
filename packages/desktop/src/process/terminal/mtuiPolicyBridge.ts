/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge } from '@office-ai/platform';
import { checkMtuiPolicy, type MtuiPolicyCheck } from './mtuiPolicy';

export const MTUI_POLICY_CHANNELS = {
  check: 'terminal.mtui-policy-check',
} as const;

export type MtuiPolicyCheckRequest = {
  rootPath: string;
  changedPaths: string[];
};

export type MtuiPolicyCheckResult = {
  strict: boolean;
  clean: boolean;
  changedCount: number;
  baselineCount: number;
  sessionBaselineCount: number;
  autoSessionCreated: boolean;
  violationCount: number;
  violationsTruncated: boolean;
  violations: MtuiPolicyCheck['violations'];
};

export type MtuiPolicyResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const mtuiPolicyChannels = {
  check: bridge.buildProvider<MtuiPolicyResult<MtuiPolicyCheckResult>, MtuiPolicyCheckRequest>(
    MTUI_POLICY_CHANNELS.check
  ),
};

export function registerMtuiPolicyBridge(): void {
  mtuiPolicyChannels.check.provider(async (req): Promise<MtuiPolicyResult<MtuiPolicyCheckResult>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) {
      return { ok: false, error: 'A folder path is required.' };
    }
    try {
      return {
        ok: true,
        data: await checkMtuiPolicy(rootPath, req.changedPaths ?? []),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
