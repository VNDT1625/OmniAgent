import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type { BrowserTabId, IBrowserViewManager } from '../../browser/browserViewManager';
import {
  readQuickTestAssetState,
  writeQuickTestAssetState,
  type QuickTestAssetState,
} from '../../ide/quickTestAssetBridge';
import {
  createReplayScenario,
  replayScenario,
  type ReplayPageAdapter,
  type ReplayRunResult,
  type ReplayScenario,
} from '../../ide/quickTestReplay';
import { createQuickTestTracer, type QuickTestTracer, type RuntimeTrace } from '../../ide/quickTestTracer';
import { resolveRunPlanResponse, type RunPlanResponse } from '../../ide/runTarget/runTargetBridge';
import type { RunService } from '../../ide/runTarget/runTargetPlanner';
import { createAppLauncher, type RunningApp } from '../../testing/appLauncher';
import type { AppUnderTest, ServiceSpec } from '../../testing/testingTypes';
import type { ITerminalManager } from '../../terminal/terminalManager';

export type QuickTestStartMode = 'frontend' | 'full' | 'services';

export type QuickTestLifecycleStartRequest = {
  rootPath: string;
  mode: QuickTestStartMode;
  serviceIds?: string[];
  url?: string;
  tabId?: BrowserTabId;
  /** Whether to attach the browser tab to the visible surface. Defaults to false. */
  visible?: boolean;
};

export type QuickTestLifecycleSession = {
  sessionId: string;
  rootPath: string;
  mode: QuickTestStartMode;
  tabId?: BrowserTabId;
  url: string;
  services: Array<Pick<RunService, 'id' | 'name' | 'kind' | 'command' | 'cwd'>>;
  running: boolean;
  /** Whether the browser surface is currently visible. */
  visible: boolean;
  observing: boolean;
  recordedEvents: number;
  terminalSessionIds: string[];
};

export type QuickTestLifecycleService = {
  discover: (request: { rootPath: string }) => Promise<RunPlanResponse>;
  start: (request: QuickTestLifecycleStartRequest) => Promise<QuickTestLifecycleSession>;
  observe: (request: { sessionId: string }) => Promise<QuickTestLifecycleSession>;
  status: (request: { sessionId: string }) => Promise<QuickTestLifecycleSession>;
  save: (request: { sessionId: string; name?: string }) => Promise<ReplayScenario>;
  replay: (request: { rootPath: string; testId: string; tabId?: BrowserTabId }) => Promise<ReplayRunResult>;
  stop: (request: { sessionId: string; keepTab?: boolean }) => Promise<QuickTestLifecycleSession>;
  close: (request: { sessionId: string }) => Promise<QuickTestLifecycleSession>;
  /** Show or hide the browser surface without stopping the session or terminals. */
  setVisibility: (request: { sessionId: string; visible: boolean }) => Promise<QuickTestLifecycleSession>;
};

export type QuickTestLifecycleDeps = {
  viewManager: IBrowserViewManager;
  discover?: (rootPath: string) => Promise<RunPlanResponse>;
  launcher?: QuickTestLifecycleLauncher;
  readAssets?: (rootPath: string) => Promise<QuickTestAssetState>;
  writeAssets?: (rootPath: string, state: QuickTestAssetState) => Promise<void>;
  createTracer?: (tabId: BrowserTabId) => QuickTestTracer;
  randomId?: () => string;
};

export type QuickTestLifecycleRunningApp = RunningApp & {
  terminalSessionIds?: string[];
  isRunning?: () => boolean;
};

export type QuickTestLifecycleLauncher = {
  start: (app: AppUnderTest) => Promise<QuickTestLifecycleRunningApp>;
};

type ActiveSession = {
  id: string;
  rootPath: string;
  mode: QuickTestStartMode;
  tabId?: BrowserTabId;
  ownsTab: boolean;
  url: string;
  services: RunService[];
  runningApp: QuickTestLifecycleRunningApp;
  running: boolean;
  visible: boolean;
  tracer?: QuickTestTracer;
  lastTrace?: RuntimeTrace;
};

const normalizedRoot = (value: string): string => {
  const rootPath = value?.trim();
  if (!rootPath) throw new Error('A project root path is required.');
  return path.resolve(rootPath);
};

const absoluteCwd = (rootPath: string, relativeCwd: string): string => {
  const cwd = path.resolve(rootPath, relativeCwd || '.');
  const relative = path.relative(rootPath, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw new Error(`Service cwd escapes the repo: ${relativeCwd}`);
  return cwd;
};

const serviceSpec = (rootPath: string, service: RunService): ServiceSpec => ({
  name: service.name,
  command: service.command,
  cwd: absoluteCwd(rootPath, service.cwd),
});

/** Launch repo commands in the shared IDE terminal manager so output remains visible and attachable. */
export const createTerminalQuickTestLauncher = (
  manager: ITerminalManager,
  options: { probe?: (url: string) => Promise<boolean>; sleep?: (ms: number) => Promise<void> } = {}
): QuickTestLifecycleLauncher => {
  const probe =
    options.probe ??
    (async (url: string): Promise<boolean> => {
      try {
        await fetch(url, { signal: AbortSignal.timeout(2500) });
        return true;
      } catch {
        return false;
      }
    });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    start: async (app) => {
      const commands = [
        ...(app.services ?? []).map((service) => ({
          name: service.name || 'Quick Test service',
          command: service.command,
          cwd: service.cwd,
        })),
        ...(app.command ? [{ name: 'Quick Test app', command: app.command, cwd: app.cwd }] : []),
      ];
      const terminalSessionIds: string[] = [];
      const stopOwned = (): void => {
        const known = new Set(manager.list().map((session) => session.id));
        for (const id of terminalSessionIds) {
          if (known.has(id)) manager.remove(id);
        }
      };
      try {
        for (const command of commands) {
          const terminal = manager.create({ cwd: command.cwd, title: command.name });
          terminalSessionIds.push(terminal.id);
          manager.write(terminal.id, `${command.command}\r`);
        }
        const url = app.url?.trim() ?? '';
        if (url) {
          const deadline = Date.now() + (app.readyTimeoutMs ?? 60_000);
          while (!(await probe(url))) {
            if (Date.now() >= deadline) throw new Error(`The app did not become reachable at ${url}.`);
            await sleep(500);
          }
        }
        return {
          url,
          terminalSessionIds,
          isRunning: () => {
            const owned = new Set(terminalSessionIds);
            return manager.list().some((session) => owned.has(session.id) && session.status === 'running');
          },
          stop: async () => stopOwned(),
        };
      } catch (error) {
        stopOwned();
        throw error;
      }
    },
  };
};

const selectServices = (plan: RunPlanResponse, mode: QuickTestStartMode, serviceIds: string[]): RunService[] => {
  const services = plan.plan.services;
  if (mode === 'frontend') {
    const frontend = services.find((service) => service.kind === 'frontend');
    return frontend ? [frontend] : [];
  }
  if (mode === 'services') {
    if (serviceIds.length === 0) throw new Error('At least one service ID is required in services mode.');
    const wanted = new Set(serviceIds);
    const selected = services.filter((service) => wanted.has(service.id));
    const missing = serviceIds.filter((id) => !selected.some((service) => service.id === id));
    if (missing.length > 0) throw new Error(`Unknown Quick Test services: ${missing.join(', ')}`);
    return selected;
  }
  const orchestrator = services.find((service) => service.orchestrator);
  return orchestrator ? [orchestrator] : services;
};

const resolveLaunch = (
  rootPath: string,
  discovered: RunPlanResponse,
  request: QuickTestLifecycleStartRequest,
  selected: RunService[]
): { app: AppUnderTest; url: string } => {
  const saved = discovered.saved.find((config) => config.platform === 'web');
  const candidate = discovered.plan.candidates.find((item) => item.platform === 'web');
  const frontend = selected.find((service) => service.kind === 'frontend') ?? selected.find((service) => service.url);
  const url = request.url?.trim() || frontend?.url?.trim() || saved?.url?.trim() || candidate?.url?.trim() || '';
  const main = frontend ?? (selected.length === 1 ? selected[0] : undefined);
  const prerequisites = main ? selected.filter((service) => service.id !== main.id) : selected;
  const fallbackCommand = selected.length === 0 ? saved?.command || candidate?.command : undefined;
  const fallbackCwd = selected.length === 0 ? saved?.cwd || candidate?.cwd || '' : '';
  const app: AppUnderTest = {
    ...(main?.command || fallbackCommand ? { command: main?.command || fallbackCommand } : {}),
    cwd: absoluteCwd(rootPath, main?.cwd ?? fallbackCwd),
    url,
    services: prerequisites.map((service) => serviceSpec(rootPath, service)),
  };
  if (!app.command && app.services?.length === 0 && !url) {
    throw new Error('No runnable web service or URL was found. Call quick_test_discover and choose a service first.');
  }
  return { app, url };
};

const pageAdapter = (viewManager: IBrowserViewManager, tabId: BrowserTabId): ReplayPageAdapter => ({
  navigate: (url) => viewManager.loadURL(tabId, url),
  click: async (selector) => {
    const contents = viewManager.getWebContents(tabId);
    if (!contents) throw new Error('The Quick Test browser tab is unavailable.');
    const matched = await contents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(
        selector
      )}); if (!(el instanceof HTMLElement)) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`
    );
    if (matched !== true) throw new Error(`Replay element was not found: ${selector}`);
  },
  input: async (selector, value) => {
    const contents = viewManager.getWebContents(tabId);
    if (!contents) throw new Error('The Quick Test browser tab is unavailable.');
    const matched = await contents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(
        selector
      )}); if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return false; const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set; if (setter) setter.call(el, ${JSON.stringify(
        value
      )}); else el.value = ${JSON.stringify(
        value
      )}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`
    );
    if (matched !== true) throw new Error(`Replay input was not found: ${selector}`);
  },
});

export const createQuickTestLifecycleService = (deps: QuickTestLifecycleDeps): QuickTestLifecycleService => {
  const discover = deps.discover ?? resolveRunPlanResponse;
  const launcher = deps.launcher ?? createAppLauncher();
  const readAssets = deps.readAssets ?? readQuickTestAssetState;
  const writeAssets = deps.writeAssets ?? writeQuickTestAssetState;
  const randomId = deps.randomId ?? randomUUID;
  const sessions = new Map<string, ActiveSession>();
  const closedSnapshots = new Map<string, QuickTestLifecycleSession>();
  const retainClosedSnapshot = (snapshot: QuickTestLifecycleSession): void => {
    closedSnapshots.delete(snapshot.sessionId);
    closedSnapshots.set(snapshot.sessionId, snapshot);
    while (closedSnapshots.size > 100) {
      const oldest = closedSnapshots.keys().next().value;
      if (typeof oldest !== 'string') break;
      closedSnapshots.delete(oldest);
    }
  };

  const requireSession = (sessionId: string): ActiveSession => {
    const session = sessions.get(sessionId?.trim());
    if (!session) throw new Error(`Quick Test session was not found: ${sessionId}`);
    return session;
  };

  const snapshot = (session: ActiveSession): QuickTestLifecycleSession => ({
    sessionId: session.id,
    rootPath: session.rootPath,
    mode: session.mode,
    ...(session.tabId ? { tabId: session.tabId } : {}),
    url: session.url,
    services: session.services.map(({ id, name, kind, command, cwd }) => ({ id, name, kind, command, cwd })),
    running: session.running && (session.runningApp.isRunning?.() ?? true),
    visible: session.visible,
    observing: session.tracer?.isActive() === true,
    recordedEvents: session.tracer?.recordedCount() ?? session.lastTrace?.events.length ?? 0,
    terminalSessionIds: session.runningApp.terminalSessionIds ?? [],
  });

  const finishObservation = async (session: ActiveSession): Promise<RuntimeTrace | undefined> => {
    const tracer = session.tracer;
    if (!tracer?.isActive()) return session.lastTrace;
    await tracer.finalizeCoverage();
    session.lastTrace = tracer.stop();
    session.tracer = undefined;
    return session.lastTrace;
  };

  const stopSession = async (session: ActiveSession, keepTab: boolean): Promise<QuickTestLifecycleSession> => {
    let cleanupError: unknown;
    try {
      await finishObservation(session);
    } catch (error) {
      cleanupError = error;
    }
    if (session.running) {
      try {
        await session.runningApp.stop();
        session.running = false;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (!keepTab && session.tabId && session.ownsTab) {
      try {
        deps.viewManager.destroyTab(session.tabId);
        session.tabId = undefined;
        session.visible = false;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (cleanupError) throw cleanupError;
    return snapshot(session);
  };

  const startWithVisibility = async (
    request: QuickTestLifecycleStartRequest,
    visible: boolean
  ): Promise<QuickTestLifecycleSession> => {
    const rootPath = normalizedRoot(request.rootPath);
    const discovered = await discover(rootPath);
    const selected = selectServices(discovered, request.mode, request.serviceIds ?? []);
    const { app, url } = resolveLaunch(rootPath, discovered, request, selected);
    const runningApp = await launcher.start(app);
    let tabId = request.tabId;
    let ownsTab = false;
    try {
      if (tabId && !deps.viewManager.getWebContents(tabId)) throw new Error(`Browser tab was not found: ${tabId}`);
      if (!tabId && url) {
        tabId = deps.viewManager.createTab({
          visible,
          // Hidden is a presentation state; keep it eligible for an explicit preview request.
          background: false,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        });
        ownsTab = true;
      }
      if (tabId && url) await deps.viewManager.loadURL(tabId, url);
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try {
        await runningApp.stop();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (tabId && ownsTab) {
        try {
          deps.viewManager.destroyTab(tabId);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        const message = error instanceof Error ? error.message : String(error);
        throw new AggregateError([error, ...cleanupErrors], `Quick Test startup failed: ${message}`);
      }
      throw error;
    }
    const baseId = randomId();
    let id = baseId;
    let suffix = 2;
    while (sessions.has(id) || closedSnapshots.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const session: ActiveSession = {
      id,
      rootPath,
      mode: request.mode,
      ...(tabId ? { tabId } : {}),
      ownsTab,
      url: runningApp.url || url,
      services: selected,
      runningApp,
      running: true,
      visible,
    };
    sessions.set(id, session);
    return snapshot(session);
  };

  const start = (request: QuickTestLifecycleStartRequest): Promise<QuickTestLifecycleSession> =>
    startWithVisibility(request, request.visible === true);

  const observe = async ({ sessionId }: { sessionId: string }): Promise<QuickTestLifecycleSession> => {
    const session = requireSession(sessionId);
    if (!session.tabId) throw new Error('This Quick Test session has no browser tab to observe.');
    if (session.tracer?.isActive()) return snapshot(session);
    const tracer =
      deps.createTracer?.(session.tabId) ??
      createQuickTestTracer({
        getWebContents: () => (session.tabId ? (deps.viewManager.getWebContents(session.tabId) ?? null) : null),
      });
    if (!(await tracer.start(session.rootPath))) throw new Error('The Quick Test browser tab is unavailable.');
    session.tracer = tracer;
    session.lastTrace = undefined;
    return snapshot(session);
  };

  const save = async ({ sessionId, name }: { sessionId: string; name?: string }): Promise<ReplayScenario> => {
    const session = requireSession(sessionId);
    const trace = await finishObservation(session);
    if (!trace) throw new Error('Start observation before saving a Quick Test scenario.');
    const scenario = createReplayScenario(trace, {
      name,
      run: {
        mode: session.mode,
        ...(session.mode === 'services' ? { serviceIds: session.services.map((service) => service.id) } : {}),
        ...(session.url ? { url: session.url } : {}),
      },
    });
    if (scenario.steps.length === 0) throw new Error('The trace has no replayable interactions.');
    const state = await readAssets(session.rootPath);
    state.scenarios = [scenario, ...state.scenarios.filter((item) => item.id !== scenario.id)].slice(0, 50);
    await writeAssets(session.rootPath, state);
    return scenario;
  };

  const replay = async ({
    rootPath: input,
    testId,
    tabId,
  }: {
    rootPath: string;
    testId: string;
    tabId?: BrowserTabId;
  }) => {
    const rootPath = normalizedRoot(input);
    const scenario = (await readAssets(rootPath)).scenarios.find((item) => item.id === testId.trim());
    if (!scenario) throw new Error(`Quick Test scenario was not found: ${testId}`);
    if (scenario.platform !== 'web') throw new Error('This lifecycle currently replays web scenarios only.');
    if (tabId) {
      if (!deps.viewManager.getWebContents(tabId)) throw new Error(`Browser tab was not found: ${tabId}`);
      return replayScenario(scenario, pageAdapter(deps.viewManager, tabId));
    }

    const firstUrl = scenario.steps.find((step) => step.kind === 'navigate')?.url;
    const replayUrl = scenario.run?.url || firstUrl;
    const started = await startWithVisibility(
      {
        rootPath,
        mode: scenario.run?.mode ?? 'full',
        ...(scenario.run?.serviceIds ? { serviceIds: scenario.run.serviceIds } : {}),
        ...(replayUrl ? { url: replayUrl } : {}),
      },
      false
    );
    if (!started.tabId) {
      await close({ sessionId: started.sessionId });
      throw new Error('The saved Quick Test scenario has no runnable web URL. Update its run configuration first.');
    }
    try {
      return await replayScenario(scenario, pageAdapter(deps.viewManager, started.tabId));
    } finally {
      await close({ sessionId: started.sessionId });
    }
  };

  const stop = async ({ sessionId, keepTab = false }: { sessionId: string; keepTab?: boolean }) => {
    const closed = closedSnapshots.get(sessionId?.trim());
    if (closed) return closed;
    return stopSession(requireSession(sessionId), keepTab);
  };

  const close = async ({ sessionId }: { sessionId: string }) => {
    const key = sessionId?.trim();
    const closed = closedSnapshots.get(key);
    if (closed) return closed;
    const session = requireSession(key);
    await stopSession(session, false);
    // A caller-owned tab is never destroyed by stopSession; close detaches this
    // lifecycle from it without taking ownership of the user's browser tab.
    session.tabId = undefined;
    const result = snapshot(session);
    sessions.delete(key);
    retainClosedSnapshot(result);
    return result;
  };

  const setVisibility = async ({ sessionId, visible }: { sessionId: string; visible: boolean }) => {
    const session = requireSession(sessionId);
    if (session.tabId) deps.viewManager.setVisible(session.tabId, visible);
    session.visible = visible;
    return snapshot(session);
  };

  return {
    discover: ({ rootPath }) => discover(normalizedRoot(rootPath)),
    start,
    observe,
    status: async ({ sessionId }) => closedSnapshots.get(sessionId?.trim()) ?? snapshot(requireSession(sessionId)),
    save,
    replay,
    stop,
    close,
    setVisibility,
  };
};
