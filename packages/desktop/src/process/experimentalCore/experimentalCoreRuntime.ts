/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getResourceCoordinator, type IResourceCoordinator } from '@process/resource/resourceCoordinator';
import type { CompanyCoreRunner } from '@process/agentRuntime/companyCoreRunner';
import { AcpCoreAdapter } from './acpCoreAdapter';
import { CodexAppServerAdapter } from './codexAppServerAdapter';
import { errorMessage, requireWorkspace, type CoreAdapter, type DetectedCoreTarget } from './coreAdapter';
import { detectCoreTargets } from './coreRegistry';
import type {
  ExperimentalCoreModel,
  ExperimentalPermissionMode,
  ExperimentalTargetKind,
} from './experimentalCoreProtocol';
import {
  MemoryCoreSessionStore,
  type CoreSessionCheckpoint,
  type CoreSessionMessage,
  type CoreSessionStore,
} from './sessionCheckpointStore';
import { TomnyCoreAdapter } from './tomnyCoreAdapter';

export type ExperimentalCoreTarget = {
  id: string;
  name: string;
  kind: ExperimentalTargetKind;
  available: boolean;
  detail?: string;
  models: ExperimentalCoreModel[];
  defaultModelKey?: string;
};

export type ExperimentalCoreEvent = {
  requestId: string;
  sessionId: string;
  targetId: string;
  type: 'started' | 'delta' | 'status' | 'permission' | 'completed' | 'error' | 'cancelled';
  timestamp: number;
  text?: string;
  mode?: 'append' | 'replace';
  permissionId?: string;
  tool?: string;
  detail?: string;
};

export type ExperimentalCoreRuntimeDeps = {
  detectTargets: () => Promise<DetectedCoreTarget[]>;
  adapters: CoreAdapter[];
  coordinator?: Pick<IResourceCoordinator, 'requestLease' | 'releaseLease'>;
  sessionStore?: CoreSessionStore;
  companyRunner?: CompanyCoreRunner;
};

type ActiveRequest = { controller: AbortController; sessionId: string };
type PendingPermission = { requestId: string; resolve: (approved: boolean) => void };

const kindForTarget = (target: DetectedCoreTarget): ExperimentalTargetKind => {
  if (target.protocol === 'tomny-json-stream') return 'builtin';
  if (target.protocol === 'openclaw-gateway') return 'remote';
  if (target.protocol === 'codex-app-server') return 'cli';
  return 'acp';
};

const defaultDeps = (): ExperimentalCoreRuntimeDeps => ({
  detectTargets: detectCoreTargets,
  adapters: [new TomnyCoreAdapter(), new CodexAppServerAdapter(), new AcpCoreAdapter()],
  coordinator: getResourceCoordinator(),
});

const MAX_PORTABLE_CONTEXT_CHARS = 80_000;
export const EXPERIMENTAL_COMPANY_TARGET_ID = 'company';

const encodeCompanyModelKey = (targetId: string, modelKey?: string): string =>
  JSON.stringify([targetId, modelKey ?? '']);

const decodeCompanyModelKey = (value?: string): { targetId: string; modelKey?: string } | undefined => {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return undefined;
    return { targetId: parsed[0], modelKey: typeof parsed[1] === 'string' && parsed[1] ? parsed[1] : undefined };
  } catch {
    return undefined;
  }
};

export const buildPortableHandoffPrompt = (input: {
  messages: CoreSessionMessage[];
  prompt: string;
  fromTargetId?: string;
  toTargetId: string;
  workspace: string;
}): string => {
  const rendered = input.messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
    .join('\n\n');
  const truncated = rendered.length > MAX_PORTABLE_CONTEXT_CHARS;
  const transcript = truncated ? rendered.slice(-MAX_PORTABLE_CONTEXT_CHARS) : rendered;
  return [
    'Tomny Core portable session handoff.',
    `Previous agent: ${input.fromTargetId ?? 'recovered session'}`,
    `Current agent: ${input.toTargetId}`,
    `Workspace: ${input.workspace}`,
    'Continue the same task using the workspace and transcript as source of truth. Do not repeat prior answers.',
    truncated ? '[Earlier transcript omitted to stay within the portable context budget.]' : '',
    transcript,
    `Current user request: ${input.prompt}`,
  ]
    .filter(Boolean)
    .join('\n\n');
};

const assertCompatibleSession = (checkpoint: CoreSessionCheckpoint, workspace: string): void => {
  if (checkpoint.workspace !== workspace) {
    throw new Error('The saved portable session belongs to a different workspace.');
  }
};

const transportKey = (
  sessionId: string,
  targetId: string,
  modelKey: string | undefined,
  permissionMode: ExperimentalPermissionMode
): string => JSON.stringify([sessionId, targetId, modelKey ?? '', permissionMode]);

/** Direct core with durable conversation checkpoints and transport process reuse. */
export class ExperimentalCoreRuntime {
  private readonly active = new Map<string, ActiveRequest>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly deps: ExperimentalCoreRuntimeDeps;
  private readonly sessionStore: CoreSessionStore;
  private readonly initialized: Promise<void>;
  private readonly transportCursors = new Map<string, number>();
  private readonly modelCatalog = new Map<string, ExperimentalCoreModel[]>();
  private targets: DetectedCoreTarget[] = [];

  public constructor(
    private readonly emit: (event: ExperimentalCoreEvent) => void,
    deps: Partial<ExperimentalCoreRuntimeDeps> = {}
  ) {
    this.deps = { ...defaultDeps(), ...deps };
    this.sessionStore = this.deps.sessionStore ?? new MemoryCoreSessionStore();
    this.initialized = this.sessionStore.initialize();
  }

  public async listTargets(): Promise<ExperimentalCoreTarget[]> {
    this.targets = await this.deps.detectTargets();
    const targets = await Promise.all(
      this.targets.map(async (target) => {
        const adapter = this.deps.adapters.find((candidate) => candidate.protocol === target.protocol);
        const models = target.available && adapter ? await this.modelsFor(target, adapter) : [];
        return {
          id: target.id,
          name: target.name,
          kind: kindForTarget(target),
          available: target.available && Boolean(adapter),
          detail: target.detected ? target.detail : `${target.detail} - executable not found`,
          models,
          defaultModelKey: models.find((model) => model.isDefault)?.key ?? models[0]?.key,
        };
      })
    );
    const companyModels = this.deps.companyRunner ? await this.companyModels() : [];
    if (this.deps.companyRunner && companyModels.length > 0) {
      targets.unshift({
        id: EXPERIMENTAL_COMPANY_TARGET_ID,
        name: 'Company · Tomny Core',
        kind: 'builtin',
        available: true,
        detail: 'Persisted Company roles running concurrently through direct core adapters',
        models: companyModels,
        defaultModelKey: companyModels[0]?.key,
      });
    }
    return targets;
  }

  public async listModels(targetId: string, workspace: string): Promise<ExperimentalCoreModel[]> {
    if (this.targets.length === 0) this.targets = await this.deps.detectTargets();
    if (targetId === EXPERIMENTAL_COMPANY_TARGET_ID) {
      requireWorkspace(workspace);
      return this.deps.companyRunner ? this.companyModels(workspace) : [];
    }
    const target = this.targets.find((candidate) => candidate.id === targetId);
    if (!target?.available) return [];
    const adapter = this.deps.adapters.find((candidate) => candidate.protocol === target.protocol);
    if (!adapter) return [];
    return this.modelsFor(target, adapter, requireWorkspace(workspace));
  }

  public async listSessions(): Promise<CoreSessionCheckpoint[]> {
    await this.initialized;
    return this.sessionStore.list();
  }

  public async forkSession(sessionId: string): Promise<CoreSessionCheckpoint> {
    await this.initialized;
    return this.sessionStore.fork(sessionId, crypto.randomUUID(), Date.now());
  }

  public start(
    requestId: string,
    targetId: string,
    prompt: string,
    workspace = '',
    modelKey?: string,
    permissionMode: ExperimentalPermissionMode = 'workspace-write',
    requestedSessionId?: string,
    companyId?: string
  ): { requestId: string; sessionId: string } {
    const sessionId = requestedSessionId ?? crypto.randomUUID();
    if ([...this.active.values()].some((active) => active.sessionId === sessionId)) {
      queueMicrotask(() =>
        this.push({
          requestId,
          sessionId,
          targetId,
          type: 'error',
          text: 'This core session is already running.',
        })
      );
      return { requestId, sessionId };
    }
    const controller = new AbortController();
    this.active.set(requestId, { controller, sessionId });
    void this.run(
      requestId,
      sessionId,
      targetId,
      prompt,
      workspace,
      modelKey,
      permissionMode,
      controller.signal,
      companyId
    );
    return { requestId, sessionId };
  }

  public resolvePermission(permissionId: string, approved: boolean): boolean {
    const pending = this.permissions.get(permissionId);
    if (!pending) return false;
    this.permissions.delete(permissionId);
    pending.resolve(approved);
    return true;
  }

  public async cancel(requestId: string): Promise<boolean> {
    const active = this.active.get(requestId);
    if (!active) return false;
    active.controller.abort();
    this.denyPermissionsForRequest(requestId);
    return true;
  }

  public async dispose(): Promise<void> {
    for (const active of this.active.values()) active.controller.abort();
    for (const pending of this.permissions.values()) pending.resolve(false);
    this.permissions.clear();
    this.active.clear();
    this.transportCursors.clear();
    await Promise.allSettled(this.deps.adapters.map((adapter) => adapter.dispose()));
  }

  private async modelsFor(
    target: DetectedCoreTarget,
    adapter: CoreAdapter,
    workspace = ''
  ): Promise<ExperimentalCoreModel[]> {
    const cacheKey = JSON.stringify([target.id, workspace]);
    const cached = this.modelCatalog.get(cacheKey) ?? [];
    try {
      const models = await adapter.listModels(target, workspace || undefined);
      if (models.length > 0) this.modelCatalog.set(cacheKey, models);
      return models.length > 0 ? models : cached;
    } catch {
      return cached;
    }
  }

  private async companyModels(workspace = ''): Promise<ExperimentalCoreModel[]> {
    const available = this.targets.filter((target) => target.available);
    const catalogs = await Promise.all(
      available.map(async (target) => {
        const adapter = this.deps.adapters.find((candidate) => candidate.protocol === target.protocol);
        if (!adapter) return [];
        const models = await this.modelsFor(target, adapter, workspace);
        if (models.length === 0) {
          return [
            {
              key: encodeCompanyModelKey(target.id),
              modelId: '',
              label: target.name + ' · agent default',
              providerId: target.id,
              isDefault: false,
            },
          ];
        }
        return models.map((model) => ({
          ...model,
          key: encodeCompanyModelKey(target.id, model.key),
          label: target.name + ' · ' + model.label,
          providerId: target.id,
          isDefault: false,
        }));
      })
    );
    return catalogs.flat();
  }

  private requestPermission(
    requestId: string,
    sessionId: string,
    targetId: string,
    request: { tool: string; detail?: string }
  ): Promise<boolean> {
    const permissionId = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      this.permissions.set(permissionId, { requestId, resolve });
      this.push({
        requestId,
        sessionId,
        targetId,
        type: 'permission',
        permissionId,
        tool: request.tool,
        detail: request.detail,
        text: request.tool,
      });
    });
  }

  private denyPermissionsForRequest(requestId: string): void {
    for (const [permissionId, pending] of this.permissions) {
      if (pending.requestId !== requestId) continue;
      this.permissions.delete(permissionId);
      pending.resolve(false);
    }
  }

  private push(event: Omit<ExperimentalCoreEvent, 'timestamp'>): void {
    this.emit({ ...event, timestamp: Date.now() });
  }

  private async run(
    requestId: string,
    sessionId: string,
    targetId: string,
    prompt: string,
    workspace: string,
    modelKey: string | undefined,
    permissionMode: ExperimentalPermissionMode,
    signal: AbortSignal,
    companyId?: string
  ): Promise<void> {
    let leaseId: string | undefined;
    let checkpoint: CoreSessionCheckpoint | undefined;
    let activeTransportKey: string | undefined;
    let transportSucceeded = false;
    let assistantText = '';
    try {
      await this.initialized;
      const normalizedPrompt = prompt.trim();
      const normalizedWorkspace = requireWorkspace(workspace);
      if (!normalizedPrompt) throw new Error('Prompt cannot be empty.');

      if (this.targets.length === 0) this.targets = await this.deps.detectTargets();
      const isCompany = targetId === EXPERIMENTAL_COMPANY_TARGET_ID;
      const companyModel = isCompany ? decodeCompanyModelKey(modelKey) : undefined;
      const transportTargetId =
        companyModel?.targetId ?? (isCompany ? this.targets.find((item) => item.available)?.id : targetId);
      const target = this.targets.find((candidate) => candidate.id === transportTargetId);
      if (!target?.available)
        throw new Error('The selected CLI is not installed or its direct adapter is unavailable.');
      const adapter = this.deps.adapters.find((candidate) => candidate.protocol === target.protocol);
      if (!adapter) throw new Error(`No direct adapter is registered for ${target.protocol}.`);
      if (isCompany && !this.deps.companyRunner) throw new Error('The Company core runner is unavailable.');
      if (isCompany && !companyId?.trim()) throw new Error('Select a company before starting the Company core.');

      const existing = await this.sessionStore.get(sessionId);
      if (existing) assertCompatibleSession(existing, normalizedWorkspace);
      const now = Date.now();
      checkpoint = existing ?? {
        id: sessionId,
        targetId,
        workspace: normalizedWorkspace,
        modelKey,
        permissionMode,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      const previousTargetId = existing?.targetId;
      const previousModelKey = existing?.modelKey;
      const priorMessages = [...checkpoint.messages];
      activeTransportKey = transportKey(sessionId, targetId, modelKey, permissionMode);
      const cursor = this.transportCursors.get(activeTransportKey) ?? 0;
      const portableMessages = priorMessages.slice(cursor);
      const needsHandoff = portableMessages.length > 0;
      if (existing && (previousTargetId !== targetId || previousModelKey !== modelKey)) {
        checkpoint.transitions = [
          ...(checkpoint.transitions ?? []),
          {
            fromTargetId: previousTargetId ?? targetId,
            toTargetId: targetId,
            fromModelKey: previousModelKey,
            toModelKey: modelKey,
            timestamp: now,
          },
        ];
      }
      checkpoint.targetId = targetId;
      checkpoint.modelKey = modelKey;
      checkpoint.permissionMode = permissionMode;
      checkpoint.messages.push({ role: 'user', text: normalizedPrompt, timestamp: now });
      checkpoint.status = 'running';
      checkpoint.updatedAt = now;
      checkpoint.lastError = undefined;
      await this.sessionStore.save(checkpoint);

      this.push({ requestId, sessionId, targetId, type: 'started' });
      if (previousTargetId && previousTargetId !== targetId) {
        this.push({
          requestId,
          sessionId,
          targetId,
          type: 'status',
          text: `Handing off portable context from ${previousTargetId} to ${targetId}...`,
        });
      }
      const lease = await this.deps.coordinator?.requestLease({ kind: 'agent', estCostMB: 96 });
      leaseId = lease?.id;
      if (signal.aborted) throw new Error('The request was cancelled.');
      const effectivePrompt = needsHandoff
        ? buildPortableHandoffPrompt({
            messages: portableMessages,
            prompt: normalizedPrompt,
            fromTargetId: previousTargetId,
            toTargetId: targetId,
            workspace: normalizedWorkspace,
          })
        : normalizedPrompt;
      if (isCompany) {
        assistantText = await this.deps.companyRunner!.run({
          companyId: companyId!.trim(),
          goal: effectivePrompt,
          model: companyModel?.modelKey,
          signal,
          chat: async ({ messages, model, signal: chatSignal }) => {
            let response = '';
            await adapter.run({
              sessionId: crypto.randomUUID(),
              target,
              prompt: messages.map((message) => message.role.toUpperCase() + ': ' + message.content).join('\n\n'),
              workspace: normalizedWorkspace,
              modelKey: model ?? companyModel?.modelKey,
              permissionMode,
              signal: chatSignal,
              emit: (event) => {
                if (event.type === 'delta') response = event.mode === 'replace' ? event.text : response + event.text;
                if (event.type === 'status')
                  this.push({ requestId, sessionId, targetId, type: 'status', text: event.text });
              },
              requestPermission: (request) => this.requestPermission(requestId, sessionId, targetId, request),
            });
            return response;
          },
          onEvent: (event) => {
            if (event.type === 'status')
              this.push({ requestId, sessionId, targetId, type: 'status', text: event.text });
            else {
              void this.requestPermission(requestId, sessionId, targetId, {
                tool: event.tool,
                detail: event.detail,
              }).then(event.resolve);
            }
          },
        });
        this.push({ requestId, sessionId, targetId, type: 'delta', text: assistantText, mode: 'replace' });
      } else {
        await adapter.run({
          sessionId,
          target,
          prompt: effectivePrompt,
          workspace: normalizedWorkspace,
          modelKey,
          permissionMode,
          signal,
          emit: (event) => {
            if (event.type === 'delta')
              assistantText = event.mode === 'replace' ? event.text : assistantText + event.text;
            this.push({ requestId, sessionId, targetId, ...event });
          },
          requestPermission: (request) => this.requestPermission(requestId, sessionId, targetId, request),
        });
      }
      transportSucceeded = true;
      checkpoint.status = signal.aborted ? 'cancelled' : 'completed';
      this.push({ requestId, sessionId, targetId, type: signal.aborted ? 'cancelled' : 'completed' });
    } catch (error) {
      const message = errorMessage(error);
      if (activeTransportKey) this.transportCursors.delete(activeTransportKey);
      if (checkpoint) {
        checkpoint.status = signal.aborted ? 'cancelled' : 'error';
        checkpoint.lastError = signal.aborted ? undefined : message;
      }
      this.push({
        requestId,
        sessionId,
        targetId,
        type: signal.aborted ? 'cancelled' : 'error',
        text: signal.aborted ? undefined : message,
      });
    } finally {
      if (checkpoint) {
        if (assistantText) checkpoint.messages.push({ role: 'assistant', text: assistantText, timestamp: Date.now() });
        if (transportSucceeded && activeTransportKey) {
          this.transportCursors.set(activeTransportKey, checkpoint.messages.length);
        }
        checkpoint.updatedAt = Date.now();
        await this.sessionStore.save(checkpoint).catch((): void => undefined);
      }
      if (leaseId) this.deps.coordinator?.releaseLease(leaseId);
      this.denyPermissionsForRequest(requestId);
      this.active.delete(requestId);
    }
  }
}
