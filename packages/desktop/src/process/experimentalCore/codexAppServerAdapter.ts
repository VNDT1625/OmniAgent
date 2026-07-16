/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
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

type JsonRecord = Record<string, unknown>;
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type ActiveTurn = {
  threadId: string;
  turnId?: string;
  emit: (event: CoreAdapterEvent) => void;
  resolve: () => void;
  reject: (error: Error) => void;
};

const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object';

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

export const codexSandboxForPermission = (
  permissionMode: ExperimentalPermissionMode
): 'read-only' | 'workspace-write' | 'danger-full-access' => {
  if (permissionMode === 'read-only') return 'read-only';
  if (permissionMode === 'full-access') return 'danger-full-access';
  return 'workspace-write';
};

const parseModelKey = (key?: string): { model?: string; effort?: string } => {
  if (!key) return {};
  const [model, effort] = key.split('::');
  return { model: model || undefined, effort: effort || undefined };
};

/** Direct Codex app-server v2 client. It never calls aioncore. */
export class CodexAppServerAdapter implements CoreAdapter {
  public readonly protocol = 'codex-app-server' as const;
  private child?: ChildProcessWithoutNullStreams;
  private target?: DetectedCoreTarget;
  private initialized?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly threads = new Map<string, string>();
  private activeTurn?: ActiveTurn;
  private stderrTail = '';

  public async listModels(target: DetectedCoreTarget): Promise<ExperimentalCoreModel[]> {
    await this.ensureStarted(target);
    const response = await this.request('model/list', { includeHidden: false, limit: 100 });
    if (!isRecord(response) || !Array.isArray(response.data)) return [];
    const models: ExperimentalCoreModel[] = [];
    for (const item of response.data) {
      if (!isRecord(item)) continue;
      const modelId = typeof item.model === 'string' ? item.model : typeof item.id === 'string' ? item.id : '';
      if (!modelId) continue;
      const displayName = typeof item.displayName === 'string' ? item.displayName : modelId;
      const efforts = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [];
      const defaultEffort = typeof item.defaultReasoningEffort === 'string' ? item.defaultReasoningEffort : '';
      if (efforts.length === 0) {
        models.push({ key: modelId, modelId, label: displayName, isDefault: item.isDefault === true });
        continue;
      }
      for (const rawEffort of efforts) {
        if (!isRecord(rawEffort) || typeof rawEffort.reasoningEffort !== 'string') continue;
        const effort = rawEffort.reasoningEffort;
        models.push({
          key: `${modelId}::${effort}`,
          modelId,
          label: `${displayName} (${effort})`,
          isDefault: item.isDefault === true && effort === defaultEffort,
        });
      }
    }
    return models;
  }

  public async run(input: CoreRunInput): Promise<void> {
    throwIfAborted(input.signal);
    await this.ensureStarted(input.target);
    if (this.activeTurn) throw new Error('Codex app-server is already processing a turn.');

    const cwd = requireWorkspace(input.workspace);
    const selected = parseModelKey(input.modelKey);
    const sessionKey = buildExperimentalSessionKey({
      sessionId: input.sessionId,
      targetId: input.target.id,
      workspace: cwd,
      modelKey: input.modelKey,
      permissionMode: input.permissionMode,
    });
    let threadId = this.threads.get(sessionKey);
    if (!threadId) {
      input.emit({ type: 'status', text: 'Starting a direct Codex thread?' });
      const started = await this.request('thread/start', {
        cwd,
        model: selected.model,
        approvalPolicy: 'never',
        sandbox: codexSandboxForPermission(input.permissionMode),
        ephemeral: true,
      });
      if (!isRecord(started) || !isRecord(started.thread) || typeof started.thread.id !== 'string') {
        throw new Error('Codex app-server returned an invalid thread/start response.');
      }
      threadId = started.thread.id;
      this.threads.set(sessionKey, threadId);
    }

    await new Promise<void>((resolve, reject) => {
      let turn: ActiveTurn;
      const onAbort = (): void => {
        if (turn.turnId)
          void this.request('turn/interrupt', { threadId, turnId: turn.turnId }).catch((): void => undefined);
        this.finishTurn(new Error('The request was cancelled.'));
      };
      const cleanup = (): void => input.signal.removeEventListener('abort', onAbort);
      turn = {
        threadId,
        emit: input.emit,
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.activeTurn = turn;
      input.signal.addEventListener('abort', onAbort, { once: true });
      void this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
        model: selected.model,
        effort: selected.effort,
      })
        .then((response) => {
          if (this.activeTurn !== turn) return;
          if (isRecord(response) && isRecord(response.turn) && typeof response.turn.id === 'string') {
            turn.turnId = response.turn.id;
          }
        })
        .catch((error) => this.finishTurn(error instanceof Error ? error : new Error(String(error))));
    });
  }

  public async dispose(): Promise<void> {
    this.failAll(new Error('Codex app-server was disposed.'));
    this.child?.kill();
    this.child = undefined;
    this.initialized = undefined;
    this.threads.clear();
  }

  private async ensureStarted(target: DetectedCoreTarget): Promise<void> {
    if (this.child && !this.child.killed && this.target?.command === target.command) {
      await this.initialized;
      return;
    }
    await this.dispose();
    this.target = target;
    const child = spawnTarget(target);
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.once('error', (error) => this.failAll(error));
    child.once('exit', (code) => {
      if (this.child !== child) return;
      const suffix = this.stderrTail.trim() ? `\n${this.stderrTail.trim()}` : '';
      this.failAll(new Error(`${formatSpawnLabel(target)} exited with code ${String(code)}.${suffix}`));
      this.child = undefined;
      this.initialized = undefined;
      this.threads.clear();
    });
    this.initialized = (async () => {
      await this.request('initialize', {
        clientInfo: { name: 'aionui-direct-core', title: 'AionUi Direct Core', version: '0.1.0' },
        capabilities: null,
      });
      this.notify('initialized');
    })();
    await this.initialized;
  }

  private request(method: string, params?: JsonRecord): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed) return Promise.reject(new Error('Codex app-server is not running.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params?: JsonRecord): void {
    this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private onLine(line: string): void {
    let message: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (isRecord(message.error)) {
        pending.reject(
          new Error(typeof message.error.message === 'string' ? message.error.message : JSON.stringify(message.error))
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const method = typeof message.method === 'string' ? message.method : '';
    const params = isRecord(message.params) ? message.params : {};
    const turn = this.activeTurn;
    if (!turn) return;
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      turn.emit({ type: 'delta', text: params.delta, mode: 'append' });
      return;
    }
    if (method === 'turn/completed') {
      const rawTurn = isRecord(params.turn) ? params.turn : {};
      if (rawTurn.status === 'failed') {
        const rawError = isRecord(rawTurn.error) ? rawTurn.error : {};
        this.finishTurn(new Error(typeof rawError.message === 'string' ? rawError.message : 'Codex turn failed.'));
      } else {
        this.finishTurn();
      }
    }
  }

  private finishTurn(error?: Error): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = undefined;
    if (error) turn.reject(error);
    else turn.resolve();
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.finishTurn(error);
  }
}
