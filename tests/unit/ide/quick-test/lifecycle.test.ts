import { describe, expect, it, vi } from 'vitest';

import type { IBrowserViewManager } from '@/process/browser/browserViewManager';
import type { QuickTestAssetState } from '@/process/ide/quickTestAssetBridge';
import type { RuntimeTrace } from '@/process/ide/quickTestTracer';
import type { RunPlanResponse } from '@/process/ide/runTarget/runTargetBridge';
import {
  createQuickTestLifecycleService,
  createTerminalQuickTestLauncher,
} from '@/process/services/quick-test/lifecycle';
import type { IAppLauncher } from '@/process/testing/appLauncher';
import type { ITerminalManager } from '@/process/terminal/terminalManager';

const plan = (): RunPlanResponse => ({
  plan: {
    support: { web: true, android: false, desktop: false },
    candidates: [{ platform: 'web', command: 'npm run dev', cwd: 'web', url: 'http://localhost:5173' }],
    services: [
      {
        id: 'api',
        name: 'API',
        kind: 'backend',
        command: 'python api.py',
        cwd: 'server',
      },
      {
        id: 'web',
        name: 'Web',
        kind: 'frontend',
        command: 'npm run dev',
        cwd: 'web',
        url: 'http://localhost:5173',
      },
    ],
    packageManager: 'npm',
    hasRunData: true,
  },
  saved: [],
  source: { graphLoaded: true, graphHasRunbook: true, runbookCommandCount: 2, manifestFileCount: 1 },
});

const trace = (): RuntimeTrace => ({
  platform: 'web',
  rootPath: 'C:\\repo',
  events: [
    { kind: 'navigate', url: 'http://localhost:5173', at: 1 },
    { kind: 'click', selector: '#submit', at: 2 },
  ],
  firstError: null,
  startedAt: 1,
  stoppedAt: 3,
});

const setup = () => {
  const tabs = new Map<string, { executeJavaScript: ReturnType<typeof vi.fn> }>();
  let executeJavaScriptResult = true;
  const loadURL = vi.fn(async () => undefined);
  const destroyTab = vi.fn((id: string) => tabs.delete(id));
  const createTab = vi.fn(() => {
    const id = `tab-${tabs.size + 1}`;
    tabs.set(id, { executeJavaScript: vi.fn(async () => executeJavaScriptResult) });
    return id;
  });
  const hide = vi.fn();
  const setVisible = vi.fn();
  const viewManager = {
    createTab,
    destroyTab,
    loadURL,
    setVisible,
    hide,
    getWebContents: vi.fn((id: string) => tabs.get(id)),
  } as unknown as IBrowserViewManager;
  const stop = vi.fn(async () => undefined);
  const launcher = {
    start: vi.fn(async (app) => ({ url: app.url ?? '', stop })),
  } satisfies IAppLauncher;
  const assets: QuickTestAssetState = { version: 1, scenarios: [], runs: [], baselines: [] };
  const tracer = {
    start: vi.fn(async () => true),
    finalizeCoverage: vi.fn(async () => undefined),
    stop: vi.fn(() => trace()),
    isActive: vi.fn(() => true),
    hasError: vi.fn(() => false),
    recordedCount: vi.fn(() => 2),
    currentEvents: vi.fn(() => trace().events),
  };
  const service = createQuickTestLifecycleService({
    viewManager,
    discover: async () => plan(),
    launcher,
    readAssets: async () => assets,
    writeAssets: async (_rootPath, next) => Object.assign(assets, next),
    createTracer: () => tracer,
    randomId: () => 'session-1',
  });
  return {
    service,
    launcher,
    stop,
    loadURL,
    createTab,
    destroyTab,
    hide,
    setVisible,
    tabs,
    assets,
    setExecuteJavaScriptResult: (value: boolean) => (executeJavaScriptResult = value),
  };
};

describe('Quick Test lifecycle service', () => {
  it('starts the selected stack in one owned session and opens the shared browser tab', async () => {
    const { service, launcher, loadURL, setVisible } = setup();

    const result = await service.start({ rootPath: 'C:\\repo', mode: 'full' });

    expect(result).toMatchObject({ sessionId: 'session-1', tabId: 'tab-1', url: 'http://localhost:5173' });
    expect(launcher.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm run dev',
        services: [expect.objectContaining({ command: 'python api.py' })],
      })
    );
    expect(loadURL).toHaveBeenCalledWith('tab-1', 'http://localhost:5173');
    expect(result.visible).toBe(false);
    const shown = await service.setVisibility({ sessionId: 'session-1', visible: true });
    expect(shown.visible).toBe(true);
    expect(setVisible).toHaveBeenCalledWith('tab-1', true);
    const hidden = await service.setVisibility({ sessionId: 'session-1', visible: false });
    expect(hidden.visible).toBe(false);
    expect(setVisible).toHaveBeenLastCalledWith('tab-1', false);
  });

  it('records and saves a replayable workflow before closing only owned processes', async () => {
    const { service, stop, destroyTab, assets } = setup();
    await service.start({ rootPath: 'C:\\repo', mode: 'frontend' });
    await service.observe({ sessionId: 'session-1' });

    const scenario = await service.save({ sessionId: 'session-1', name: 'Login flow' });
    const closed = await service.close({ sessionId: 'session-1' });

    expect(scenario).toMatchObject({
      name: 'Login flow',
      steps: expect.arrayContaining([expect.objectContaining({ kind: 'click' })]),
    });
    expect(assets.scenarios).toHaveLength(1);
    expect(closed.running).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(destroyTab).toHaveBeenCalledOnce();

    await service.close({ sessionId: 'session-1' });
    expect(stop).toHaveBeenCalledOnce();
    expect(destroyTab).toHaveBeenCalledOnce();
  });

  it('destroys its tab even when both browser startup and process cleanup fail', async () => {
    const { service, stop, loadURL, destroyTab } = setup();
    loadURL.mockRejectedValueOnce(new Error('navigation failed'));
    stop.mockRejectedValueOnce(new Error('process cleanup failed'));

    await expect(service.start({ rootPath: 'C:\\repo', mode: 'frontend' })).rejects.toThrow(/navigation failed/);

    expect(stop).toHaveBeenCalledOnce();
    expect(destroyTab).toHaveBeenCalledOnce();
  });

  it('rejects unknown custom services without launching a terminal', async () => {
    const { service, launcher } = setup();

    await expect(service.start({ rootPath: 'C:\\repo', mode: 'services', serviceIds: ['missing'] })).rejects.toThrow(
      /unknown quick test services/i
    );
    expect(launcher.start).not.toHaveBeenCalled();
  });

  it('boots and tears down its own app stack when replaying a saved scenario without a browser call', async () => {
    const { service, launcher, stop, createTab, destroyTab, assets } = setup();
    await service.start({ rootPath: 'C:\\repo', mode: 'frontend' });
    await service.observe({ sessionId: 'session-1' });
    const scenario = await service.save({ sessionId: 'session-1', name: 'Saved flow' });
    await service.close({ sessionId: 'session-1' });
    expect(assets.scenarios).toHaveLength(1);
    vi.mocked(launcher.start).mockClear();
    stop.mockClear();
    destroyTab.mockClear();

    const result = await service.replay({ rootPath: 'C:\\repo', testId: scenario.id });

    expect(result.status).toBe('passed');
    expect(launcher.start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(createTab).toHaveBeenCalledWith(expect.objectContaining({ visible: false, background: false }));
    expect(destroyTab).toHaveBeenCalledOnce();
  });

  it('replays the exact custom service recipe saved with the scenario', async () => {
    const { service, launcher, stop, assets } = setup();
    await service.start({
      rootPath: 'C:\\repo',
      mode: 'services',
      serviceIds: ['api', 'web'],
    });
    await service.observe({ sessionId: 'session-1' });
    const scenario = await service.save({ sessionId: 'session-1', name: 'Custom stack' });
    await service.close({ sessionId: 'session-1' });
    vi.mocked(launcher.start).mockClear();
    stop.mockClear();

    await service.replay({ rootPath: 'C:\\repo', testId: scenario.id });

    expect(assets.scenarios[0]?.run).toEqual({
      mode: 'services',
      serviceIds: ['api', 'web'],
      url: 'http://localhost:5173',
    });
    expect(launcher.start).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'npm run dev',
        services: [expect.objectContaining({ command: 'python api.py' })],
      })
    );
  });

  it('uses the native value setter when replaying controlled form input', async () => {
    const { service, tabs, assets } = setup();
    const started = await service.start({ rootPath: 'C:\\repo', mode: 'frontend' });
    assets.scenarios.push({
      version: 1,
      id: 'scenario-input',
      name: 'Controlled input',
      platform: 'web',
      rootPath: 'C:\\repo',
      createdAt: 1,
      steps: [
        {
          id: 'input',
          kind: 'input',
          selector: '#email',
          value: 'dev@example.com',
          redacted: false,
          sourceAt: 1,
        },
      ],
    });

    await service.replay({ rootPath: 'C:\\repo', testId: 'scenario-input', tabId: started.tabId });

    const script = tabs.get(started.tabId ?? '')?.executeJavaScript.mock.calls[0]?.[0];
    expect(script).toContain('Object.getOwnPropertyDescriptor');
    expect(script).toContain('setter.call');
  });

  it('cleans up its hidden replay stack and tab when a replay step fails', async () => {
    const { service, stop, destroyTab, tabs, assets, setExecuteJavaScriptResult } = setup();
    assets.scenarios.push({
      version: 1,
      id: 'scenario-failing',
      name: 'Failing flow',
      platform: 'web',
      rootPath: 'C:\\repo',
      createdAt: 1,
      steps: [
        { id: 'navigate', kind: 'navigate', url: 'http://localhost:5173', sourceAt: 1 },
        { id: 'missing', kind: 'click', selector: '#missing', sourceAt: 2 },
      ],
    });
    setExecuteJavaScriptResult(false);

    const result = await service.replay({ rootPath: 'C:\\repo', testId: 'scenario-failing' });

    expect(result.status).toBe('failed');
    expect(stop).toHaveBeenCalledOnce();
    expect(destroyTab).toHaveBeenCalledOnce();
    expect(tabs.size).toBe(0);
  });

  it('removes terminals already created when a later terminal cannot start', async () => {
    const sessions = [{ id: 'quick-api', status: 'running' }];
    const manager = {
      create: vi
        .fn()
        .mockReturnValueOnce({ id: 'quick-api' })
        .mockImplementationOnce(() => {
          throw new Error('shell failed');
        }),
      write: vi.fn(),
      list: vi.fn(() => sessions),
      remove: vi.fn((id: string) => {
        const index = sessions.findIndex((item) => item.id === id);
        if (index >= 0) sessions.splice(index, 1);
      }),
    } as unknown as ITerminalManager;
    const launcher = createTerminalQuickTestLauncher(manager, { probe: async () => true });

    await expect(
      launcher.start({
        command: 'npm run dev',
        cwd: 'C:\\repo',
        services: [{ name: 'API', command: 'python api.py', cwd: 'C:\\repo\\server' }],
      })
    ).rejects.toThrow('shell failed');

    expect(manager.remove).toHaveBeenCalledWith('quick-api');
    expect(sessions).toHaveLength(0);
  });

  it('terminal launcher stops only terminal sessions that it created', async () => {
    const sessions = [
      { id: 'user-terminal', status: 'running' },
      { id: 'quick-terminal', status: 'running' },
    ];
    const manager = {
      create: vi.fn(() => ({ id: 'quick-terminal' })),
      write: vi.fn(),
      list: vi.fn(() => sessions),
      kill: vi.fn((id: string) => {
        const session = sessions.find((item) => item.id === id);
        if (session) session.status = 'exited';
      }),
      remove: vi.fn((id: string) => {
        const index = sessions.findIndex((item) => item.id === id);
        if (index >= 0) {
          if (sessions[index]?.status === 'running') sessions[index].status = 'exited';
          sessions.splice(index, 1);
        }
      }),
    } as unknown as ITerminalManager;
    const launcher = createTerminalQuickTestLauncher(manager, { probe: async () => true });

    const running = await launcher.start({ command: 'npm run dev', cwd: 'C:\\repo', url: 'http://localhost:5173' });
    await running.stop();

    expect(manager.write).toHaveBeenCalledWith('quick-terminal', 'npm run dev\r');
    expect(manager.remove).toHaveBeenCalledTimes(1);
    expect(manager.remove).toHaveBeenCalledWith('quick-terminal');
    expect(manager.kill).not.toHaveBeenCalled();
    expect(sessions).toEqual([{ id: 'user-terminal', status: 'running' }]);
  });
});
