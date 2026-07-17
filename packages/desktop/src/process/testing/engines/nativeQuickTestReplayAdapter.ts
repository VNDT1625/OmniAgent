import type { ReplayPageAdapter, ReplayScenario } from '../../ide/quickTestReplay';
import { createAndroidQuickTestAdapter } from './androidQuickTestAdapter';
import { createWindowsQuickTestAdapter } from './windowsQuickTestAdapter';

export type NativeQuickTestReplayAdapter = ReplayPageAdapter & {
  collectEvidence?: () => Promise<{
    consoleErrors: string[];
    networkFailures: string[];
    attachments: string[];
    relatedFiles: string[];
  }>;
  dispose?: () => Promise<void> | void;
};

export type CreateNativeQuickTestReplayAdapterOptions = {
  rootPath: string;
  runId: string;
  scenario: ReplayScenario;
  target?: string;
};

export const createNativeQuickTestReplayAdapter = async ({
  rootPath,
  runId,
  scenario,
  target,
}: CreateNativeQuickTestReplayAdapterOptions): Promise<NativeQuickTestReplayAdapter> => {
  const resolvedTarget = target?.trim() || scenario.target?.trim() || '';
  if (scenario.platform === 'android') {
    return createAndroidQuickTestAdapter({ rootPath, runId, ...(resolvedTarget ? { serial: resolvedTarget } : {}) });
  }
  if (scenario.platform === 'windows') {
    if (!resolvedTarget)
      throw new Error('A Windows .exe or process target is required to replay this desktop scenario.');
    return createWindowsQuickTestAdapter({ rootPath, runId, target: resolvedTarget });
  }
  throw new Error(`Native replay is not available for ${scenario.platform} scenarios.`);
};
