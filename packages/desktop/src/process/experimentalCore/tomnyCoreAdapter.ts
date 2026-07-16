/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import {
  errorMessage,
  formatSpawnLabel,
  requireWorkspace,
  throwIfAborted,
  type CoreAdapter,
  type CoreAdapterEvent,
  type CoreRunInput,
  type DetectedCoreTarget,
} from './coreAdapter';
import type {
  ExperimentalCoreModel,
  ExperimentalPermissionMode,
  ExperimentalSessionIdentity,
} from './experimentalCoreProtocol';
import type { IProvider } from '@/common/config/storage';
import { getReadyProviderStore } from '@process/services/tomnyProviderBridge';
import type { IProviderStore } from '@process/services/tomnyProviderStore';

import { BoundedSessionPool } from './sessionPool';

type TomnyStreamEvent = Record<string, unknown> & { type?: string };

type PendingTurn = {
  msgId: string;
  emit: (event: CoreAdapterEvent) => void;
  permissionMode: ExperimentalPermissionMode;
  requestPermission: (request: { tool: string; detail?: string }) => Promise<boolean>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type TomnyProcess = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  pending?: PendingTurn;
  stderrTail: string;
  isBusy: () => boolean;
  dispose: () => void;
};

const READY_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 90_000;
const STDERR_TAIL_LIMIT = 4_000;

export const waitForTomnyTurn = (
  turn: Promise<void>,
  onTimeout: () => void,
  timeoutMs = TURN_TIMEOUT_MS
): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(
        new Error(
          `Tomny did not complete within ${Math.ceil(timeoutMs / 1000)}s. The selected provider or model did not finish the response.`
        )
      );
    }, timeoutMs);
    void turn.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

const execFileAsync = promisify(execFile);

type TomnyEnvironment = Record<string, string | undefined>;
type TomnyConfigRecord = Record<string, unknown>;
type TomnyProviderSource = Pick<IProviderStore, 'list' | 'get'>;

const defaultProviderSource: TomnyProviderSource = {
  list: async () => (await getReadyProviderStore()).list(),
  get: async (id) => (await getReadyProviderStore()).get(id),
};

const appProviderModelKey = (providerId: string, modelId: string): string =>
  `app-provider:${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;

const parseAppProviderModelKey = (modelKey?: string): { providerId: string; modelId: string } | undefined => {
  const match = /^app-provider:([^:]+):(.+)$/u.exec(modelKey ?? '');
  if (!match?.[1] || !match[2]) return undefined;
  return { providerId: decodeURIComponent(match[1]), modelId: decodeURIComponent(match[2]) };
};

export const appProviderModels = (providers: IProvider[]): ExperimentalCoreModel[] => {
  const models: ExperimentalCoreModel[] = [];
  for (const provider of providers) {
    if (provider.enabled === false) continue;
    for (const modelId of provider.models) {
      if (provider.model_enabled?.[modelId] === false) continue;
      models.push({
        key: appProviderModelKey(provider.id, modelId),
        modelId,
        label: `${modelId} (${provider.name})`,
        providerId: provider.id,
        isDefault: models.length === 0,
      });
    }
  }
  return models;
};

const tomnyProviderType = (platform: string): string => {
  const normalized = platform.toLowerCase();
  if (normalized.includes('anthropic') || normalized === 'claude') return 'anthropic';
  if (normalized.includes('bedrock')) return 'bedrock';
  if (normalized.includes('vertex')) return 'vertex';
  return 'openai';
};

const appProviderEnvironment = async (
  modelKey: string | undefined,
  source: TomnyProviderSource
): Promise<NodeJS.ProcessEnv> => {
  const selected = parseAppProviderModelKey(modelKey);
  if (!selected) return process.env;
  const provider = await source.get(selected.providerId);
  if (!provider) throw new Error(`The selected Tomny provider no longer exists: ${selected.providerId}`);
  return {
    ...process.env,
    PROVIDER: tomnyProviderType(provider.platform),
    MODEL: selected.modelId,
    API_KEY: provider.api_key.split(/[,\n]/u)[0]?.trim() ?? '',
    BASE_URL: provider.base_url.trim(),
  };
};

const DEFAULT_PROVIDER_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  bedrock: 'anthropic.claude-sonnet-4-20250514-v1:0',
  vertex: 'claude-sonnet-4@20250514',
};

const objectRecord = (value: unknown): TomnyConfigRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as TomnyConfigRecord) : {};

const stringValue = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const configuredModel = (providerName: string, section: TomnyConfigRecord, fallbackModel = ''): string => {
  const providerType = stringValue(section.provider) || providerName;
  return stringValue(section.model) || fallbackModel || DEFAULT_PROVIDER_MODELS[providerType] || '';
};

export const parseTomnyModelCatalog = (
  configText: string,
  environment: TomnyEnvironment = {}
): ExperimentalCoreModel[] => {
  let config: TomnyConfigRecord;
  try {
    config = configText.trim() ? (parseToml(configText) as TomnyConfigRecord) : {};
  } catch {
    return [];
  }

  const defaultConfig = objectRecord(config.default);
  const providers = objectRecord(config.providers);
  const profiles = objectRecord(config.profiles);
  const defaultProvider = environment.PROVIDER?.trim() || stringValue(defaultConfig.provider) || 'anthropic';
  const defaultProviderConfig = objectRecord(providers[defaultProvider]);
  const defaultModel =
    environment.MODEL?.trim() ||
    stringValue(defaultConfig.model) ||
    configuredModel(defaultProvider, defaultProviderConfig);

  const models: ExperimentalCoreModel[] = [];
  const keys = new Set<string>();
  const add = (model: ExperimentalCoreModel): void => {
    if (!model.modelId || keys.has(model.key)) return;
    keys.add(model.key);
    models.push(model);
  };

  if (defaultModel) {
    add({
      key: `provider:${defaultProvider}:${defaultModel}`,
      modelId: defaultModel,
      label: `${defaultModel} (${defaultProvider})`,
      providerId: defaultProvider,
      isDefault: true,
    });
  }

  for (const [providerName, value] of Object.entries(providers)) {
    const section = objectRecord(value);
    const model = configuredModel(providerName, section);
    if (!model) continue;
    add({
      key: `provider:${providerName}:${model}`,
      modelId: model,
      label: `${model} (${providerName})`,
      providerId: providerName,
      isDefault: false,
    });
  }

  for (const [profileName, value] of Object.entries(profiles)) {
    const profile = objectRecord(value);
    const providerName = stringValue(profile.provider) || defaultProvider;
    const providerConfig = objectRecord(providers[providerName]);
    const model = configuredModel(providerName, profile, configuredModel(providerName, providerConfig, defaultModel));
    if (!model) continue;
    add({
      key: `profile:${profileName}`,
      modelId: model,
      label: `${model} (${profileName})`,
      providerId: providerName,
      isDefault: false,
    });
  }

  return models;
};

export const tomnyModeForPermission = (
  permissionMode: ExperimentalPermissionMode
): 'default' | 'auto_edit' | 'yolo' => {
  if (permissionMode === 'read-only') return 'default';
  if (permissionMode === 'full-access') return 'yolo';
  return 'auto_edit';
};

const tomnyRuntimeScope = (modelKey?: string): string => {
  const appProvider = parseAppProviderModelKey(modelKey);
  if (appProvider) return 'app-provider:' + appProvider.providerId;
  const provider = /^provider:([^:]+):/u.exec(modelKey ?? '');
  if (provider?.[1]) return 'provider:' + provider[1];
  const profile = /^profile:(.+)$/u.exec(modelKey ?? '');
  if (profile?.[1]) return 'profile:' + profile[1];
  return 'default';
};

/** Keep one Tomny engine per workspace/provider while model and permission remain hot-swappable. */
export const tomnyRuntimeKey = (identity: ExperimentalSessionIdentity): string =>
  JSON.stringify([
    identity.sessionId ?? '',
    identity.targetId,
    identity.workspace.trim(),
    tomnyRuntimeScope(identity.modelKey),
  ]);

const tomnyDynamicModel = (modelKey?: string): string | undefined => {
  const appProvider = parseAppProviderModelKey(modelKey);
  if (appProvider) return appProvider.modelId;
  const provider = /^provider:[^:]+:(.+)$/u.exec(modelKey ?? '');
  if (provider?.[1]) return provider[1];
  if (!modelKey || modelKey.startsWith('profile:')) return undefined;
  return modelKey;
};

export const tomnyModelArgs = (modelKey?: string): string[] => {
  if (!modelKey || parseAppProviderModelKey(modelKey)) return [];
  const profile = /^profile:(.+)$/u.exec(modelKey);
  if (profile?.[1]) return ['--profile', profile[1]];
  const provider = /^provider:([^:]+):(.+)$/u.exec(modelKey);
  if (provider?.[1] && provider[2]) return ['--provider', provider[1], '--model', provider[2]];
  return ['--model', modelKey];
};

const textField = (event: TomnyStreamEvent, key: string): string => (typeof event[key] === 'string' ? event[key] : '');

export const normalizeTomnyStreamEvent = (event: TomnyStreamEvent): CoreAdapterEvent | null => {
  if (event.type === 'text_delta') {
    const text = textField(event, 'text');
    return text ? { type: 'delta', text, mode: 'append' } : null;
  }
  if (event.type === 'thinking') {
    const text = textField(event, 'text');
    return text ? { type: 'status', text } : null;
  }
  if (event.type === 'info') {
    const text = textField(event, 'message');
    return text ? { type: 'status', text } : null;
  }
  if (event.type === 'tool_running') {
    const tool = textField(event, 'tool_name');
    return tool ? { type: 'status', text: `Tomny is running ${tool}` } : null;
  }
  return null;
};

const eventError = (event: TomnyStreamEvent): string => {
  const value = event.error;
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return 'Tomny CLI reported an unknown error.';
  const message = (value as Record<string, unknown>).message;
  return typeof message === 'string' && message.trim() ? message : 'Tomny CLI reported an unknown error.';
};

const writeCommand = (runtime: TomnyProcess, command: Record<string, unknown>): void => {
  runtime.child.stdin.write(`${JSON.stringify(command)}\n`);
};

const spawnTarget = (
  target: DetectedCoreTarget,
  cwd: string,
  modelKey?: string,
  environment: NodeJS.ProcessEnv = process.env
): ChildProcessWithoutNullStreams => {
  if (!target.command) throw new Error('Tomny CLI executable was not found.');
  const args = [...target.args];
  args.push(...tomnyModelArgs(modelKey));
  return spawn(target.command, args, {
    cwd,
    env: environment,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/iu.test(target.command),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

/** Direct host for the bundled Tomny CLI JSON stream protocol. */
export class TomnyCoreAdapter implements CoreAdapter {
  public readonly protocol = 'tomny-json-stream' as const;

  public constructor(private readonly providerSource: TomnyProviderSource = defaultProviderSource) {}

  public async listModels(target: DetectedCoreTarget): Promise<ExperimentalCoreModel[]> {
    if (!target.command) return [];
    const configuredProviders = appProviderModels(await this.providerSource.list());
    if (configuredProviders.length > 0) return configuredProviders;
    try {
      const { stdout } = await execFileAsync(target.command, ['config', 'path'], {
        windowsHide: true,
        timeout: 5_000,
        shell: process.platform === 'win32' && /\.(cmd|bat)$/iu.test(target.command),
      });
      const configPath = stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean);
      if (!configPath) return parseTomnyModelCatalog('', process.env);
      return parseTomnyModelCatalog(await readFile(configPath, 'utf8'), process.env);
    } catch {
      return parseTomnyModelCatalog('', process.env);
    }
  }
  private readonly processes = new BoundedSessionPool<TomnyProcess>({ maxSessions: 8, idleTimeoutMs: 5 * 60_000 });

  public async run(input: CoreRunInput): Promise<void> {
    throwIfAborted(input.signal);
    const cwd = requireWorkspace(input.workspace);
    const key = tomnyRuntimeKey({
      sessionId: input.sessionId,
      targetId: input.target.id,
      workspace: cwd,
      modelKey: input.modelKey,
    });
    const runtime = await this.getProcess(key, input.target, cwd, input.modelKey);
    await runtime.ready;
    if (runtime.pending) throw new Error('Tomny CLI is already processing a message in this session.');

    const dynamicModel = tomnyDynamicModel(input.modelKey);
    if (dynamicModel) writeCommand(runtime, { type: 'set_config', model: dynamicModel });
    writeCommand(runtime, { type: 'set_mode', mode: tomnyModeForPermission(input.permissionMode) });
    const msgId = crypto.randomUUID();
    const turn = new Promise<void>((resolve, reject) => {
      runtime.pending = {
        msgId,
        emit: input.emit,
        permissionMode: input.permissionMode,
        requestPermission: input.requestPermission,
        resolve,
        reject,
      };
    });
    let abortTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      try {
        writeCommand(runtime, { type: 'stop' });
      } catch {
        this.processes.invalidate(key, runtime);
        return;
      }
      abortTimer = setTimeout(() => this.processes.invalidate(key, runtime), 1_500);
      abortTimer.unref();
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    try {
      writeCommand(runtime, { type: 'message', msg_id: msgId, content: input.prompt });
      await waitForTomnyTurn(turn, () => {
        if (runtime.pending?.msgId !== msgId) return;
        runtime.pending = undefined;
        this.processes.invalidate(key, runtime);
      });
      this.processes.touch(key);
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      if (abortTimer) clearTimeout(abortTimer);
    }
  }

  public async dispose(): Promise<void> {
    await this.processes.disposeAll();
  }

  private getProcess(key: string, target: DetectedCoreTarget, cwd: string, modelKey?: string): Promise<TomnyProcess> {
    return this.processes.getOrCreate(key, () => this.startProcess(key, target, cwd, modelKey));
  }

  private async startProcess(
    key: string,
    target: DetectedCoreTarget,
    cwd: string,
    modelKey?: string
  ): Promise<TomnyProcess> {
    const environment = await appProviderEnvironment(modelKey, this.providerSource);
    const child = spawnTarget(target, cwd, modelKey, environment);
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: Error) => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const runtime: TomnyProcess = {
      child,
      ready,
      stderrTail: '',
      isBusy: () => Boolean(runtime.pending),
      dispose: () => {
        if (child.stdin.writable) child.stdin.end();
        if (!child.killed) child.kill();
      },
    };
    const readyTimer = setTimeout(
      () =>
        rejectReady?.(new Error(`${formatSpawnLabel(target)} did not emit ready within ${READY_TIMEOUT_MS / 1000}s.`)),
      READY_TIMEOUT_MS
    );

    child.stdin.on('error', () => this.processes.invalidate(key, runtime));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      runtime.stderrTail = (runtime.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let event: TomnyStreamEvent;
      try {
        event = JSON.parse(line) as TomnyStreamEvent;
      } catch {
        return;
      }
      if (event.type === 'ready') {
        clearTimeout(readyTimer);
        resolveReady?.();
        return;
      }
      if (event.type === 'tool_request') {
        const callId = textField(event, 'call_id');
        if (!callId) return;
        const pending = runtime.pending;
        if (!pending || pending.permissionMode === 'read-only') {
          writeCommand(runtime, { type: 'tool_deny', call_id: callId, reason: 'Read-only mode' });
          return;
        }
        if (pending.permissionMode === 'full-access') {
          writeCommand(runtime, { type: 'tool_approve', call_id: callId, scope: 'always' });
          return;
        }
        const tool = textField(event, 'tool_name') || 'Tomny tool';
        const detail = event.input === undefined ? undefined : JSON.stringify(event.input);
        void pending
          .requestPermission({ tool, detail })
          .then((approved) => {
            writeCommand(
              runtime,
              approved
                ? { type: 'tool_approve', call_id: callId, scope: 'once' }
                : { type: 'tool_deny', call_id: callId, reason: 'Denied by user' }
            );
          })
          .catch(() => {
            try {
              writeCommand(runtime, { type: 'tool_deny', call_id: callId, reason: 'Permission request failed' });
            } catch {
              this.processes.invalidate(key, runtime);
            }
          });
        return;
      }
      const pending = runtime.pending;
      if (!pending) {
        if (event.type === 'error') rejectReady?.(new Error(eventError(event)));
        return;
      }
      const normalized = normalizeTomnyStreamEvent(event);
      if (normalized) pending.emit(normalized);
      if (event.type === 'stream_end') {
        runtime.pending = undefined;
        pending.resolve();
      } else if (event.type === 'error') {
        runtime.pending = undefined;
        pending.reject(new Error(eventError(event)));
      }
    });

    child.once('exit', (code) => {
      clearTimeout(readyTimer);
      this.processes.invalidate(key, runtime);
      const suffix = runtime.stderrTail.trim() ? `\n${runtime.stderrTail.trim()}` : '';
      const error = new Error(`${formatSpawnLabel(target)} exited with code ${String(code)}.${suffix}`);
      rejectReady?.(error);
      runtime.pending?.reject(error);
      runtime.pending = undefined;
    });
    child.once('error', (error) => {
      clearTimeout(readyTimer);
      this.processes.invalidate(key, runtime);
      const wrapped = new Error(`Failed to start ${formatSpawnLabel(target)}: ${errorMessage(error)}`);
      rejectReady?.(wrapped);
      runtime.pending?.reject(wrapped);
      runtime.pending = undefined;
    });

    await ready;
    return runtime;
  }
}
