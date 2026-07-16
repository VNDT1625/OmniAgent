/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModelState,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  formatSpawnLabel,
  requireWorkspace,
  throwIfAborted,
  type CoreAdapter,
  type CoreAdapterEvent,
  type CoreRunInput,
  type DetectedCoreTarget,
} from './coreAdapter';
import {
  buildExperimentalSessionKey,
  type ExperimentalCoreModel,
  type ExperimentalPermissionMode,
} from './experimentalCoreProtocol';

type AcpSession = { sessionId: string; connection: ClientSideConnection };
type AcpPermissionHandler = {
  mode: ExperimentalPermissionMode;
  request: (request: { tool: string; detail?: string }) => Promise<boolean>;
};

const ACP_HANDSHAKE_TIMEOUT_MS = 15_000;

type AcpProcess = {
  child: ChildProcessWithoutNullStreams;
  connection: ClientSideConnection;
  sessions: Map<string, AcpSession>;
  permissions: Map<string, AcpPermissionHandler>;
  stderrTail: string;
};

const textUpdate = (params: SessionNotification): string => {
  const update = params.update;
  if (update.sessionUpdate !== 'agent_message_chunk') return '';
  return update.content.type === 'text' ? update.content.text : '';
};

const selectedPermission = (
  params: RequestPermissionRequest,
  kinds: Array<'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'>
): RequestPermissionResponse => {
  const selected = kinds.flatMap((kind) => params.options.filter((option) => option.kind === kind))[0];
  if (!selected) return { outcome: { outcome: 'cancelled' } };
  return { outcome: { outcome: 'selected', optionId: selected.optionId } };
};

export const resolveAcpPermission = async (
  params: RequestPermissionRequest,
  handler: AcpPermissionHandler | undefined
): Promise<RequestPermissionResponse> => {
  if (!handler || handler.mode === 'read-only') {
    return selectedPermission(params, ['reject_once', 'reject_always']);
  }
  if (handler.mode === 'full-access') {
    return selectedPermission(params, ['allow_always', 'allow_once']);
  }
  const detail = params.toolCall.rawInput === undefined ? undefined : JSON.stringify(params.toolCall.rawInput);
  const approved = await handler.request({
    tool: params.toolCall.title ?? params.toolCall.kind ?? 'ACP tool',
    detail,
  });
  return approved
    ? selectedPermission(params, ['allow_once', 'allow_always'])
    : selectedPermission(params, ['reject_once', 'reject_always']);
};

const spawnTarget = (target: DetectedCoreTarget): ChildProcessWithoutNullStreams => {
  if (!target.command) throw new Error(`${target.name} executable was not found.`);
  return spawn(target.command, target.args, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/iu.test(target.command),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
};

export const mapAcpSessionModels = (state?: SessionModelState | null): ExperimentalCoreModel[] =>
  state?.availableModels.map((model) => ({
    key: model.modelId,
    modelId: model.modelId,
    label: model.name || model.modelId,
    isDefault: model.modelId === state.currentModelId,
  })) ?? [];

/** Generic ACP stdio host shared by Claude, OpenCode, Cursor, Hermes and compatible CLIs. */
export class AcpCoreAdapter implements CoreAdapter {
  public readonly protocol = 'acp' as const;
  private readonly modelCache = new Map<string, { models: ExperimentalCoreModel[]; expiresAt: number }>();

  public async listModels(target: DetectedCoreTarget, workspace?: string): Promise<ExperimentalCoreModel[]> {
    const cached = this.modelCache.get(target.id);
    if (cached && cached.expiresAt > Date.now()) return cached.models;
    if (!workspace?.trim()) return cached?.models ?? [];
    try {
      const runtime = await this.getProcess(target);
      const created = await runtime.connection.newSession({ cwd: requireWorkspace(workspace), mcpServers: [] });
      const models = this.captureModels(target.id, created.models);

      return models;
    } catch {
      return cached?.models ?? [];
    }
  }
  private readonly processes = new Map<string, Promise<AcpProcess>>();
  private readonly emitters = new Map<string, (event: CoreAdapterEvent) => void>();

  public async run(input: CoreRunInput): Promise<void> {
    throwIfAborted(input.signal);
    const runtime = await this.getProcess(input.target);
    const cwd = requireWorkspace(input.workspace);
    const key = buildExperimentalSessionKey({
      sessionId: input.sessionId,
      targetId: input.target.id,
      workspace: cwd,
      modelKey: input.modelKey,
      permissionMode: input.permissionMode,
    });
    let session = runtime.sessions.get(key);
    if (!session) {
      input.emit({ type: 'status', text: `Starting direct ${input.target.name} ACP session...` });
      const created = await runtime.connection.newSession({ cwd, mcpServers: [] });
      this.captureModels(input.target.id, created.models);
      session = { sessionId: created.sessionId, connection: runtime.connection };
      runtime.sessions.set(key, session);
      if (input.modelKey) {
        await runtime.connection.unstable_setSessionModel({
          sessionId: created.sessionId,
          modelId: input.modelKey,
        });
      }
    }

    this.emitters.set(session.sessionId, input.emit);
    runtime.permissions.set(session.sessionId, {
      mode: input.permissionMode,
      request: input.requestPermission,
    });
    const onAbort = (): void => {
      void runtime.connection.cancel({ sessionId: session?.sessionId ?? '' }).catch((): void => undefined);
    };
    input.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await runtime.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: input.prompt }],
      });
      throwIfAborted(input.signal);
    } finally {
      input.signal.removeEventListener('abort', onAbort);
      this.emitters.delete(session.sessionId);
      runtime.permissions.delete(session.sessionId);
    }
  }

  private captureModels(targetId: string, state?: SessionModelState | null): ExperimentalCoreModel[] {
    if (!state) return this.modelCache.get(targetId)?.models ?? [];
    const models = mapAcpSessionModels(state);
    this.modelCache.set(targetId, { models, expiresAt: Date.now() + 5 * 60_000 });
    return models;
  }

  public async dispose(): Promise<void> {
    const processes = await Promise.allSettled(this.processes.values());
    for (const result of processes) {
      if (result.status === 'fulfilled') result.value.child.kill();
    }
    this.processes.clear();
    this.emitters.clear();
  }

  private getProcess(target: DetectedCoreTarget): Promise<AcpProcess> {
    const existing = this.processes.get(target.id);
    if (existing) return existing;
    const created = this.startProcess(target);
    this.processes.set(target.id, created);
    void created.then(
      (runtime) => {
        runtime.child.once('exit', () => {
          if (this.processes.get(target.id) === created) this.processes.delete(target.id);
        });
      },
      () => {
        if (this.processes.get(target.id) === created) this.processes.delete(target.id);
      }
    );
    return created;
  }

  private async startProcess(target: DetectedCoreTarget): Promise<AcpProcess> {
    const child = spawnTarget(target);
    const runtime: AcpProcess = {
      child,
      connection: undefined as unknown as ClientSideConnection,
      sessions: new Map(),
      permissions: new Map(),
      stderrTail: '',
    };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      runtime.stderrTail = `${runtime.stderrTail}${chunk}`.slice(-4000);
    });

    const client: Client = {
      requestPermission: async (params) => resolveAcpPermission(params, runtime.permissions.get(params.sessionId)),
      sessionUpdate: async (params) => {
        const emit = this.emitters.get(params.sessionId);
        if (!emit) return;
        const text = textUpdate(params);
        if (text) {
          emit({ type: 'delta', text, mode: 'append' });
          return;
        }
        const update = params.update;
        if (update.sessionUpdate === 'tool_call') emit({ type: 'status', text: update.title });
        if (update.sessionUpdate === 'tool_call_update') emit({ type: 'status', text: `Tool ${update.toolCallId}` });
      },
    };
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const connection = new ClientSideConnection(() => client, stream);
    runtime.connection = connection;

    const exited = new Promise<never>((_resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        const suffix = runtime.stderrTail.trim() ? `\n${runtime.stderrTail.trim()}` : '';
        reject(new Error(`${formatSpawnLabel(target)} exited with code ${String(code)}.${suffix}`));
      });
    });
    let timeout: NodeJS.Timeout | undefined;
    const handshakeTimeout = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error(formatSpawnLabel(target) + ' did not complete the ACP handshake within 15 seconds.')),
        ACP_HANDSHAKE_TIMEOUT_MS
      );
    });
    try {
      await Promise.race([
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: 'tomny-direct-core', title: 'Tomny Direct Core', version: '0.1.0' },
          clientCapabilities: {},
        }),
        exited,
        handshakeTimeout,
      ]);
      return runtime;
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}
