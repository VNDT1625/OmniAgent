import { describe, expect, it, vi } from 'vitest';

import { createNativeQuickTestReplayAdapter } from '@/process/testing/engines/nativeQuickTestReplayAdapter';

import { createWindowsQuickTestAdapter } from '@/process/testing/engines/windowsQuickTestAdapter';
import type { ReplayScenario } from '@/process/ide/quickTestReplay';

const scenario = (platform: ReplayScenario['platform'], target?: string): ReplayScenario => ({
  version: 1,
  id: 'scenario-native',
  name: 'Native scenario',
  platform,
  rootPath: 'C:/workspace/app',
  ...(target ? { target } : {}),
  createdAt: 100,
  steps: [{ id: 'click', kind: 'click', selector: 'uia:login', sourceAt: 101 }],
});

describe('createNativeQuickTestReplayAdapter', () => {
  it('requires a Windows executable or process target for desktop replay', async () => {
    await expect(
      createNativeQuickTestReplayAdapter({
        rootPath: 'C:/workspace/app',
        runId: 'run-1',
        scenario: scenario('windows'),
      })
    ).rejects.toThrow('Windows .exe or process target is required');
  });

  it('rejects web scenarios before native tooling is touched', async () => {
    await expect(
      createNativeQuickTestReplayAdapter({ rootPath: 'C:/workspace/app', runId: 'run-1', scenario: scenario('web') })
    ).rejects.toThrow('Native replay is not available');
  });
});

describe('createWindowsQuickTestAdapter', () => {
  it.each(['pid:123', '123'])('attaches to %s without launching or closing the external process', async (target) => {
    const launch = vi.fn();
    const close = vi.fn();
    const attach = vi.fn(async (processId: number) => ({
      processId,
      onLine: () => undefined,
      close,
    }));
    const adapter = await createWindowsQuickTestAdapter({
      rootPath: 'C:/workspace/app',
      runId: 'run-attached',
      target,
      launch,
      attach,
      runPowerShell: async () => 'attached',
    });

    adapter.dispose();

    expect(attach).toHaveBeenCalledWith(123);
    expect(launch).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes a process that the adapter launched when replay is disposed', async () => {
    const close = vi.fn();
    const adapter = await createWindowsQuickTestAdapter({
      rootPath: 'C:/workspace/app',
      runId: 'run-owned',
      target: 'C:/apps/MyApp.exe',
      launch: async () => ({ processId: 321, onLine: () => undefined, close }),
      runPowerShell: async () => 'launched',
    });

    adapter.dispose();

    expect(close).toHaveBeenCalledOnce();
  });

  it('does not close an attached process when its UI Automation probe fails', async () => {
    const close = vi.fn();

    await expect(
      createWindowsQuickTestAdapter({
        rootPath: 'C:/workspace/app',
        runId: 'run-no-window',
        target: 'pid:456',
        attach: async () => ({ processId: 456, onLine: () => undefined, close }),
        runPowerShell: async () => {
          throw new Error('window missing');
        },
      })
    ).rejects.toThrow('does not expose a UI Automation window');

    expect(close).not.toHaveBeenCalled();
  });

  it.each(['pid:0', 'pid:-1', 'not-an-executable.txt'])('rejects invalid Windows target %s', async (target) => {
    await expect(
      createWindowsQuickTestAdapter({
        rootPath: 'C:/workspace/app',
        runId: 'run-invalid',
        target,
        launch: vi.fn(),
        attach: vi.fn(),
        runPowerShell: async () => '',
      })
    ).rejects.toThrow('valid Windows .exe path or process id target');
  });
});
