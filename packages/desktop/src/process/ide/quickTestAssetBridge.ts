/** Persistent Quick Test scenarios, run history and visual baselines. */
import { bridge } from '@office-ai/platform';
import { randomUUID } from 'node:crypto';
import { promises as fsp, type Dirent } from 'node:fs';
import * as path from 'node:path';
import sharp from 'sharp';
import { compareQuickTestRuns, type QuickTestRunDiff } from './quickTestRunCompare';
import {
  createReplayScenario,
  replayScenario,
  type ReplayEvidenceContext,
  type ReplayPageAdapter,
  type ReplayRunMode,
  type ReplayRunResult,
  type ReplayScenario,
} from './quickTestReplay';
import type { CdpWebContents, RuntimeTrace } from './quickTestTracer';
import {
  compareRgbaImages,
  createVisualBaseline,
  createVisualCheckpoint,
  type RgbaImage,
  type VisualBaseline,
  type VisualComparisonResult,
  type VisualIgnoreRegion,
} from './quickTestVisualRegression';
import type { UnderstandResult } from './understandTypes';

export const QT_ASSET_CHANNELS = {
  list: 'ide.qt-assets-list',
  archiveRun: 'ide.qt-assets-archive-run',
  saveScenario: 'ide.qt-assets-save-scenario',
  replay: 'ide.qt-assets-replay',
  compareRuns: 'ide.qt-assets-compare-runs',
  saveBaseline: 'ide.qt-assets-save-baseline',
  compareVisual: 'ide.qt-assets-compare-visual',
  remove: 'ide.qt-assets-remove',
} as const;

export type StoredQuickTestRun = { id: string; name: string; savedAt: number; trace: RuntimeTrace };
export type QuickTestAssetState = {
  version: 1;
  scenarios: ReplayScenario[];
  runs: StoredQuickTestRun[];
  baselines: VisualBaseline[];
};
export type RootRequest = { rootPath: string };
export type ArchiveRunRequest = RootRequest & { trace: RuntimeTrace; name?: string };
export type SaveScenarioRequest = RootRequest & { trace: RuntimeTrace; name?: string };
export type ReplayScenarioRequest = RootRequest & {
  tabId?: string;
  scenarioId: string;
  mode?: ReplayRunMode;
  target?: string;
};
export type CompareRunsRequest = RootRequest & { baselineRunId: string; currentRunId: string };
export type SaveBaselineRequest = RootRequest & {
  name: string;
  screenshotPath: string;
  mode: 'viewport' | 'fullPage';
  url?: string;
};
export type CompareVisualRequest = RootRequest & {
  baselineId: string;
  screenshotPath: string;
  ignoredRegions?: VisualIgnoreRegion[];
};
export type RemoveAssetRequest = RootRequest & { kind: 'scenario' | 'run' | 'baseline'; id: string };

const EMPTY_STATE: QuickTestAssetState = { version: 1, scenarios: [], runs: [], baselines: [] };

export const quickTestAssetChannels = {
  list: bridge.buildProvider<UnderstandResult<QuickTestAssetState>, RootRequest>(QT_ASSET_CHANNELS.list),
  archiveRun: bridge.buildProvider<UnderstandResult<StoredQuickTestRun>, ArchiveRunRequest>(
    QT_ASSET_CHANNELS.archiveRun
  ),
  saveScenario: bridge.buildProvider<UnderstandResult<ReplayScenario>, SaveScenarioRequest>(
    QT_ASSET_CHANNELS.saveScenario
  ),
  replay: bridge.buildProvider<UnderstandResult<ReplayRunResult>, ReplayScenarioRequest>(QT_ASSET_CHANNELS.replay),
  compareRuns: bridge.buildProvider<UnderstandResult<QuickTestRunDiff>, CompareRunsRequest>(
    QT_ASSET_CHANNELS.compareRuns
  ),
  saveBaseline: bridge.buildProvider<UnderstandResult<VisualBaseline>, SaveBaselineRequest>(
    QT_ASSET_CHANNELS.saveBaseline
  ),
  compareVisual: bridge.buildProvider<UnderstandResult<VisualComparisonResult>, CompareVisualRequest>(
    QT_ASSET_CHANNELS.compareVisual
  ),
  remove: bridge.buildProvider<UnderstandResult<boolean>, RemoveAssetRequest>(QT_ASSET_CHANNELS.remove),
};

const dataDir = (rootPath: string): string => path.join(rootPath, '.omni', 'quick-test');
const statePath = (rootPath: string): string => path.join(dataDir(rootPath), 'assets.json');

export const readQuickTestAssetState = async (rootPath: string): Promise<QuickTestAssetState> => {
  const raw = await fsp.readFile(statePath(rootPath), 'utf8').catch((): null => null);
  if (!raw) return { ...EMPTY_STATE, scenarios: [], runs: [], baselines: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<QuickTestAssetState>;
    return {
      version: 1,
      scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      baselines: Array.isArray(parsed.baselines) ? parsed.baselines : [],
    };
  } catch {
    return { ...EMPTY_STATE, scenarios: [], runs: [], baselines: [] };
  }
};

export const writeQuickTestAssetState = async (rootPath: string, state: QuickTestAssetState): Promise<void> => {
  await fsp.mkdir(dataDir(rootPath), { recursive: true });
  const target = statePath(rootPath);
  const temporary = target + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fsp.rename(temporary, target);
};

const decodeImage = async (filePath: string): Promise<RgbaImage> => {
  const decoded = await sharp(filePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: decoded.info.width, height: decoded.info.height, data: new Uint8Array(decoded.data) };
};

const REPLAY_EVIDENCE_LIMIT = 40;

const replayEvidenceDir = (rootPath: string): string => path.join(dataDir(rootPath), 'replay-evidence');

const pruneReplayEvidence = async (rootPath: string): Promise<void> => {
  const directory = replayEvidenceDir(rootPath);
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((): Dirent[] => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => entry.name)
    .toSorted()
    .toReversed();
  await Promise.all(
    files.slice(REPLAY_EVIDENCE_LIMIT - 1).map((name) => fsp.rm(path.join(directory, name), { force: true }))
  );
};

const captureFailureScreenshot = async (
  webContents: CdpWebContents,
  rootPath: string,
  context: ReplayEvidenceContext
): Promise<string | undefined> => {
  if (context.status !== 'failed') return undefined;
  const capturable = webContents as CdpWebContents & {
    capturePage?: () => Promise<{ isEmpty: () => boolean; toPNG: () => Buffer }>;
  };
  if (!capturable.capturePage) return undefined;
  const image = await capturable.capturePage();
  if (image.isEmpty()) return undefined;
  const directory = replayEvidenceDir(rootPath);
  await fsp.mkdir(directory, { recursive: true });
  await pruneReplayEvidence(rootPath);
  const stepId = context.step.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  const target = path.join(directory, `${Date.now()}-${String(context.stepIndex).padStart(3, '0')}-${stepId}.png`);
  await fsp.writeFile(target, image.toPNG());
  return target;
};

const collectWebStepEvidence = async (
  webContents: CdpWebContents,
  rootPath: string,
  context: ReplayEvidenceContext
) => {
  const selector = context.step.kind === 'navigate' ? null : context.step.selector;
  const page = (await webContents.executeJavaScript(`(() => {
    const selector = ${JSON.stringify(selector)};
    const target = selector ? document.querySelector(selector) : null;
    const active = document.activeElement;
    const describe = (element) => {
      if (!(element instanceof Element)) return undefined;
      const id = element.id ? '#' + element.id : '';
      const classes = Array.from(element.classList || []).slice(0, 2).map((name) => '.' + name).join('');
      return element.tagName.toLowerCase() + id + classes;
    };
    const rect = target instanceof Element ? target.getBoundingClientRect() : null;
    return {
      pageUrl: location.href,
      pageTitle: document.title,
      activeElement: describe(active),
      ...(selector ? {
        target: {
          selector,
          exists: Boolean(target),
          ...(target instanceof Element ? {
            tagName: target.tagName.toLowerCase(),
            role: target.getAttribute('role') || undefined,
            text: String(target.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160) || undefined,
            rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined
          } : {})
        }
      } : {})
    };
  })()`)) as {
    pageUrl?: string;
    pageTitle?: string;
    activeElement?: string;
    target?: {
      selector: string;
      exists: boolean;
      tagName?: string;
      role?: string;
      text?: string;
      rect?: { x: number; y: number; width: number; height: number };
    };
  };
  const screenshotPath = await captureFailureScreenshot(webContents, rootPath, context);
  return { ...page, ...(screenshotPath ? { screenshotPath } : {}) };
};

const pageAdapter = (webContents: CdpWebContents, rootPath: string): ReplayPageAdapter => ({
  navigate: async (url) => {
    const navigable = webContents as CdpWebContents & { loadURL?: (target: string) => Promise<void> };
    if (navigable.loadURL) await navigable.loadURL(url);
    else {
      await webContents.executeJavaScript(`location.assign(${JSON.stringify(url)})`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  },
  click: async (selector) => {
    await webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLElement)) throw new Error('Replay element was not found.');
      element.scrollIntoView({ block: 'center', inline: 'center' }); element.click();
    })()`);
  },
  collectStepEvidence: (context) => collectWebStepEvidence(webContents, rootPath, context),
  input: async (selector, value) => {
    await webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error('Replay input was not found.');
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, ${JSON.stringify(value)}); else element.value = ${JSON.stringify(value)};
      element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  },
});

export type QuickTestAssetBridgeDeps = {
  getWebContents: (tabId?: string) => CdpWebContents | null;
  createNativeAdapter?: (input: {
    rootPath: string;
    runId: string;
    scenario: ReplayScenario;
    target?: string;
  }) => Promise<ReplayPageAdapter & { dispose?: () => Promise<void> | void }>;
};
const root = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error('A folder path is required.');
  return normalized;
};
const resultError = (error: unknown): UnderstandResult<never> => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
  code: 'error',
});

export const registerQuickTestAssetBridge = (deps: QuickTestAssetBridgeDeps): void => {
  quickTestAssetChannels.list.provider(async (request) => {
    try {
      return { ok: true, data: await readQuickTestAssetState(root(request.rootPath)) };
    } catch (error) {
      return resultError(error);
    }
  });
  quickTestAssetChannels.archiveRun.provider(async (request) => {
    try {
      const rootPath = root(request.rootPath);
      const state = await readQuickTestAssetState(rootPath);
      const run: StoredQuickTestRun = {
        id: randomUUID(),
        name: request.name?.trim() || new Date(request.trace.startedAt).toLocaleString(),
        savedAt: Date.now(),
        trace: request.trace,
      };
      state.runs = [run, ...state.runs].slice(0, 30);
      await writeQuickTestAssetState(rootPath, state);
      return { ok: true, data: run };
    } catch (error) {
      return resultError(error);
    }
  });
  quickTestAssetChannels.saveScenario.provider(async (request) => {
    try {
      const rootPath = root(request.rootPath);
      const state = await readQuickTestAssetState(rootPath);
      const scenario = createReplayScenario(request.trace, { name: request.name });
      if (scenario.steps.length === 0) throw new Error('The trace has no replayable interactions.');
      state.scenarios = [scenario, ...state.scenarios.filter((item) => item.id !== scenario.id)].slice(0, 50);
      await writeQuickTestAssetState(rootPath, state);
      return { ok: true, data: scenario };
    } catch (error) {
      return resultError(error);
    }
  });
  quickTestAssetChannels.replay.provider(async (request) => {
    try {
      const scenario = (await readQuickTestAssetState(root(request.rootPath))).scenarios.find(
        (item) => item.id === request.scenarioId
      );
      if (!scenario) throw new Error('Replay scenario was not found.');
      if (scenario.platform !== 'web') {
        if (!deps.createNativeAdapter) throw new Error('Native replay is unavailable in this Quick Test session.');
        const adapter = await deps.createNativeAdapter({
          rootPath: root(request.rootPath),
          runId: randomUUID(),
          scenario,
          target: request.target,
        });
        try {
          return { ok: true, data: await replayScenario(scenario, adapter, request.mode) };
        } finally {
          await adapter.dispose?.();
        }
      }
      const webContents = deps.getWebContents(request.tabId);
      if (!webContents) throw new Error('The Quick Test browser is unavailable.');
      return {
        ok: true,
        data: await replayScenario(scenario, pageAdapter(webContents, root(request.rootPath)), request.mode),
      };
    } catch (error) {
      return resultError(error);
    }
  });
  quickTestAssetChannels.compareRuns.provider(async (request) => {
    try {
      const state = await readQuickTestAssetState(root(request.rootPath));
      const baseline = state.runs.find((item) => item.id === request.baselineRunId);
      const current = state.runs.find((item) => item.id === request.currentRunId);
      if (!baseline || !current) throw new Error('Both Quick Test runs are required.');
      return { ok: true, data: compareQuickTestRuns(baseline.trace, current.trace) };
    } catch (error) {
      return resultError(error);
    }
  });
  quickTestAssetChannels.saveBaseline.provider(async (request) => {
    try {
      const rootPath = root(request.rootPath);
      const image = await decodeImage(request.screenshotPath);
      const dir = path.join(dataDir(rootPath), 'baselines');
      await fsp.mkdir(dir, { recursive: true });
      const id = randomUUID();
      const target = path.join(dir, id + '.png');
      await fsp.copyFile(request.screenshotPath, target);
      const checkpoint = createVisualCheckpoint({
        id,
        name: request.name.trim() || 'Visual checkpoint',
        screenshotPath: target,
        captureMode: request.mode === 'fullPage' ? 'full-page' : 'viewport',
        capturedAt: Date.now(),
        image: { width: image.width, height: image.height },
        viewport: { width: image.width, height: image.height },
        ...(request.url ? { url: request.url } : {}),
      });
      const baseline = createVisualBaseline(checkpoint);
      const state = await readQuickTestAssetState(rootPath);
      state.baselines = [baseline, ...state.baselines].slice(0, 30);
      await writeQuickTestAssetState(rootPath, state);
      return { ok: true, data: baseline };
    } catch (error) {
      return resultError(error);
    }
  });
  quickTestAssetChannels.compareVisual.provider(async (request) => {
    try {
      const state = await readQuickTestAssetState(root(request.rootPath));
      const baseline = state.baselines.find((item) => item.checkpoint.id === request.baselineId);
      if (!baseline) throw new Error('Visual baseline was not found.');
      const [expected, actual] = await Promise.all([
        decodeImage(baseline.checkpoint.screenshotPath),
        decodeImage(request.screenshotPath),
      ]);
      return {
        ok: true,
        data: compareRgbaImages(expected, actual, {
          ...baseline.comparison,
          ignoredRegions: request.ignoredRegions ?? baseline.comparison.ignoredRegions,
        }),
      };
    } catch (error) {
      return resultError(error);
    }
  });
  quickTestAssetChannels.remove.provider(async (request) => {
    try {
      const rootPath = root(request.rootPath);
      const state = await readQuickTestAssetState(rootPath);
      if (request.kind === 'scenario') state.scenarios = state.scenarios.filter((item) => item.id !== request.id);
      if (request.kind === 'run') state.runs = state.runs.filter((item) => item.id !== request.id);
      if (request.kind === 'baseline') {
        const removed = state.baselines.find((item) => item.checkpoint.id === request.id);
        state.baselines = state.baselines.filter((item) => item.checkpoint.id !== request.id);
        if (removed) await fsp.rm(removed.checkpoint.screenshotPath, { force: true });
      }
      await writeQuickTestAssetState(rootPath, state);
      return { ok: true, data: true };
    } catch (error) {
      return resultError(error);
    }
  });
};
