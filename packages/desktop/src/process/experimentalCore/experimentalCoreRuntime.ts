/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getResourceCoordinator, type IResourceCoordinator } from '@process/resource/resourceCoordinator';
import type { CompanyCoreRunner } from '@process/agentRuntime/companyCoreRunner';
import type { CoreContextComposer } from '@process/agentRuntime/contextTypes';
import type { ResolvedSurface, SurfaceRegistry } from '@process/agentRuntime/surfaceRegistry';
import { buildSurfaceHarnessPrompt } from '@process/agentRuntime/surfaceRegistry/harnesses';
import { AgentMeshService, type AgentMessageKind } from '@process/agentRuntime/agentMesh';
import {
  describeOrchestrationProposal,
  ORCHESTRATION_CAPABILITY_PROMPT,
  parseOrchestrationProposal,
  shouldOfferOrchestration,
  type OrchestrationProposal,
} from '@process/agentRuntime/orchestrationCapability';
import {
  MemoryDurableEventStore,
  type DurableEventKind,
  type DurableEventPayload,
  type DurableEventStore,
} from '@process/services/agentChat/durability';
import type {
  DurablePermissionStore,
  PermissionGrantLifetime,
  PermissionRequest,
} from '@process/services/agentChat/permission';
import type { CoreTelemetryRecorder } from '@process/services/diagnostics/coreTelemetry';
import {
  AcpCoreAdapter,
  CodexAppServerAdapter,
  errorMessage,
  requireWorkspace,
  TomnyCoreAdapter,
  type CoreAdapter,
  type CoreAdapterEvent,
  type CoreMcpServer,
  type DetectedCoreTarget,
} from './adapters';
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
  type:
    | 'started'
    | 'delta'
    | 'status'
    | 'thinking'
    | 'step'
    | 'tool-call'
    | 'tool-result'
    | 'permission'
    | 'orchestration-created'
    | 'completed'
    | 'error'
    | 'cancelled';
  timestamp: number;
  sequence: number;
  text?: string;
  mode?: 'append' | 'replace';
  permissionId?: string;
  tool?: string;
  callId?: string;
  phase?: 'requested' | 'running';
  outcome?: 'success' | 'error';
  workspace?: string;
  detail?: string;
  orchestrationKind?: 'team' | 'company';
  orchestrationId?: string;
};

export type ExperimentalCoreRunSnapshot = {
  requestId: string;
  sessionId: string;
  targetId: string;
  startedAt: number;
  partialText: string;
  events: ExperimentalCoreEvent[];
  pendingPermissionIds: string[];
};

export type ExperimentalCoreRuntimeDeps = {
  detectTargets: () => Promise<DetectedCoreTarget[]>;
  adapters: CoreAdapter[];
  coordinator?: Pick<IResourceCoordinator, 'requestLease' | 'releaseLease'>;
  sessionStore?: CoreSessionStore;
  eventStore?: DurableEventStore;
  permissionStore?: DurablePermissionStore;
  surfaceRegistry?: SurfaceRegistry;
  companyRunner?: CompanyCoreRunner;
  agentMeshService?: AgentMeshService;
  contextComposer?: CoreContextComposer;
  resolveCapabilityHosts?: (serverNames: string[]) => Promise<CoreMcpServer[]>;
  telemetry?: CoreTelemetryRecorder;
};

export type ExperimentalCoreContextIdentity = {
  surface?: string;
  agentId?: string;
  personalId?: string;
  permissionScopes?: string[];
  capabilityGrants?: string[];
  availableCapabilities?: string[];
  modelCapabilities?: string[];
};

const normalizeContextIdentity = (
  identity?: ExperimentalCoreContextIdentity
): Required<ExperimentalCoreContextIdentity> => ({
  surface: identity?.surface?.trim() || 'chat',
  agentId: identity?.agentId?.trim() || 'tomny',
  personalId: identity?.personalId?.trim() || 'default',
  permissionScopes: [...(identity?.permissionScopes ?? [])],
  capabilityGrants: [...(identity?.capabilityGrants ?? [])],
  availableCapabilities: [...(identity?.availableCapabilities ?? [])],
  modelCapabilities: [...(identity?.modelCapabilities ?? [])],
});

const toolMatchesPattern = (tool: string, pattern: string): boolean =>
  pattern === '*' || tool === pattern || (pattern.endsWith('*') && tool.startsWith(pattern.slice(0, -1)));

const permissionIdentityFor = (
  contextIdentity: Required<ExperimentalCoreContextIdentity>,
  surfaceId: string,
  surface: ResolvedSurface | undefined,
  tool: string
): { subjectId: string; surfaceId: string; capabilityId: string } => ({
  subjectId: contextIdentity.agentId,
  surfaceId,
  capabilityId:
    surface?.capabilities.find((capability) =>
      capability.toolPatterns.some((pattern) => toolMatchesPattern(tool, pattern))
    )?.id ?? 'core',
});
type ActiveRequest = {
  controller: AbortController;
  sessionId: string;
  targetId: string;
  startedAt: number;
  partialText: string;
  cancelledByUser: boolean;
  lifecycleInterrupted: boolean;
};
type PendingPermission = {
  requestId: string;
  sessionId: string;
  targetId: string;
  authorizationRequest: PermissionRequest;
  resolve: (approved: boolean) => void;
};

const kindForTarget = (target: DetectedCoreTarget): ExperimentalTargetKind => {
  if (target.protocol === 'tomny-json-stream') return 'builtin';
  if (target.protocol === 'openclaw-gateway' || target.protocol === 'tomny-remote-v1') return 'remote';
  if (target.protocol === 'codex-app-server') return 'cli';
  return 'acp';
};

const defaultDeps = (): ExperimentalCoreRuntimeDeps => ({
  detectTargets: detectCoreTargets,
  adapters: [new TomnyCoreAdapter(), new CodexAppServerAdapter(), new AcpCoreAdapter()],
  coordinator: getResourceCoordinator(),
});

const MAX_PORTABLE_CONTEXT_CHARS = 80_000;
const MAX_REPLAY_EVENTS_PER_RUN = 1_000;
export const EXPERIMENTAL_COMPANY_TARGET_ID = 'company';
const durableKindForEvent = (event: ExperimentalCoreEvent): DurableEventKind => {
  if (event.type === 'started') return 'run.started';
  if (event.type === 'status') return 'run.status';
  if (event.type === 'thinking') return 'run.thinking';
  if (event.type === 'step') return 'run.step';
  if (event.type === 'delta') return 'run.delta';
  if (event.type === 'completed') return 'run.completed';
  if (event.type === 'error') return 'run.error';
  if (event.type === 'cancelled') return 'run.cancelled';
  if (event.type === 'permission') return 'permission.requested';
  if (event.type === 'tool-call') return 'tool.started';
  if (event.type === 'tool-result') return event.outcome === 'error' ? 'tool.error' : 'tool.completed';
  return 'custom';
};

const durablePayloadForEvent = (event: ExperimentalCoreEvent): DurableEventPayload =>
  JSON.parse(JSON.stringify(event)) as DurableEventPayload;

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
  private readonly runEvents = new Map<string, ExperimentalCoreEvent[]>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly deps: ExperimentalCoreRuntimeDeps;
  private readonly sessionStore: CoreSessionStore;
  private readonly eventStore: DurableEventStore;
  private readonly agentMeshService: AgentMeshService;
  private readonly initialized: Promise<void>;
  private readonly transportCursors = new Map<string, number>();
  private readonly modelCatalog = new Map<string, ExperimentalCoreModel[]>();
  private nextEventSequence = 1;
  private targets: DetectedCoreTarget[] = [];

  public constructor(
    private readonly emit: (event: ExperimentalCoreEvent) => void,
    deps: Partial<ExperimentalCoreRuntimeDeps> = {}
  ) {
    this.deps = { ...defaultDeps(), ...deps };
    this.sessionStore = this.deps.sessionStore ?? new MemoryCoreSessionStore();
    this.eventStore = this.deps.eventStore ?? new MemoryDurableEventStore();
    this.agentMeshService = this.deps.agentMeshService ?? new AgentMeshService();
    this.initialized = Promise.all([
      this.sessionStore.initialize(),
      this.eventStore.initialize(),
      this.deps.permissionStore?.initialize(),
    ]).then(async () => {
      this.nextEventSequence = (await this.eventStore.latestSequence()) + 1;
    });
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

  /** Replay persisted events after renderer refresh, completed turns, or a Main-process restart. */
  public async replayEvents(query: {
    sessionId?: string;
    requestId?: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<ExperimentalCoreEvent[]> {
    await this.initialized;
    const events = await this.eventStore.query(query);
    return events.map((event) => {
      const payload = event.payload as unknown as ExperimentalCoreEvent;
      return { ...payload, sequence: event.sequence, timestamp: event.timestamp };
    });
  }
  /** Snapshot active Main-process turns so a recreated renderer can reattach without restarting them. */
  public listActiveRuns(): ExperimentalCoreRunSnapshot[] {
    return [...this.active.entries()]
      .map(([requestId, active]) => ({
        requestId,
        sessionId: active.sessionId,
        targetId: active.targetId,
        startedAt: active.startedAt,

        partialText: active.partialText,
        events: [...(this.runEvents.get(requestId) ?? [])],
        pendingPermissionIds: [...this.permissions.entries()]
          .filter(([, pending]) => pending.requestId === requestId)
          .map(([permissionId]) => permissionId),
      }))
      .toSorted((left, right) => right.startedAt - left.startedAt);
  }

  /** Restart the unfinished user turn after the Electron Main process itself exited. */
  public async resumeInterrupted(
    sessionId: string,
    requestId: string = crypto.randomUUID()
  ): Promise<{ requestId: string; sessionId: string }> {
    await this.initialized;
    const checkpoint = await this.sessionStore.get(sessionId);
    if (!checkpoint) throw new Error(`Core session not found: ${sessionId}`);
    if (checkpoint.status !== 'interrupted') throw new Error('Only an interrupted core session can be resumed.');
    const pending = checkpoint.messages.at(-1);
    if (pending?.role !== 'user') throw new Error('The interrupted core session has no pending user turn.');
    return this.launch(
      requestId,
      checkpoint.targetId,
      pending.text,
      checkpoint.workspace,
      checkpoint.modelKey,
      checkpoint.permissionMode,
      checkpoint.id,
      checkpoint.companyId,
      true,
      {
        surface: checkpoint.surface,
        agentId: checkpoint.agentId,
        personalId: checkpoint.personalId,
        permissionScopes: checkpoint.permissionScopes,
        capabilityGrants: checkpoint.capabilityGrants,
        availableCapabilities: checkpoint.availableCapabilities,
        modelCapabilities: checkpoint.modelCapabilities,
      }
    );
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
    companyId?: string,
    contextIdentity?: ExperimentalCoreContextIdentity
  ): { requestId: string; sessionId: string } {
    return this.launch(
      requestId,
      targetId,
      prompt,
      workspace,
      modelKey,
      permissionMode,
      requestedSessionId,
      companyId,
      false,
      contextIdentity
    );
  }

  private launch(
    requestId: string,
    targetId: string,
    prompt: string,
    workspace: string,
    modelKey: string | undefined,
    permissionMode: ExperimentalPermissionMode,
    requestedSessionId: string | undefined,
    companyId: string | undefined,
    resumePendingTurn: boolean,
    contextIdentity: ExperimentalCoreContextIdentity | undefined
  ): { requestId: string; sessionId: string } {
    const sessionId = requestedSessionId ?? crypto.randomUUID();
    const resolvedContextIdentity = normalizeContextIdentity(contextIdentity);
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
    this.runEvents.set(requestId, []);
    this.active.set(requestId, {
      controller,
      sessionId,
      targetId,
      startedAt: Date.now(),
      partialText: '',
      cancelledByUser: false,
      lifecycleInterrupted: false,
    });
    void this.run(
      requestId,
      sessionId,
      targetId,
      prompt,
      workspace,
      modelKey,
      permissionMode,
      controller.signal,
      companyId,
      resumePendingTurn,
      resolvedContextIdentity
    );
    return { requestId, sessionId };
  }

  public async resolvePermission(
    permissionId: string,
    approved: boolean,
    lifetime: PermissionGrantLifetime = 'allow-once'
  ): Promise<boolean> {
    const pending = this.permissions.get(permissionId);
    if (!pending) return false;
    this.permissions.delete(permissionId);
    if (!approved || !this.deps.permissionStore) {
      pending.resolve(approved);
      return true;
    }
    try {
      await this.deps.permissionStore.createGrant({
        scope: {
          subjectId: pending.authorizationRequest.subjectId,
          sessionId: lifetime === 'persistent' ? '*' : pending.authorizationRequest.sessionId,
          surfaceId: pending.authorizationRequest.surfaceId,
          capabilityId: pending.authorizationRequest.capabilityId,
          toolPattern: pending.authorizationRequest.tool,
        },
        effect: 'allow',
        lifetime,
      });
      const decision = await this.deps.permissionStore.authorize(pending.authorizationRequest);
      pending.resolve(decision.allowed);
      return true;
    } catch (error) {
      pending.resolve(false);
      throw error;
    }
  }

  public async cancel(requestId: string): Promise<boolean> {
    const active = this.active.get(requestId);
    if (!active) return false;

    active.cancelledByUser = true;
    active.controller.abort();
    this.denyPermissionsForRequest(requestId);
    return true;
  }

  public async dispose(): Promise<void> {
    for (const active of this.active.values()) {
      active.lifecycleInterrupted = true;
      active.controller.abort();
    }
    for (const pending of this.permissions.values()) pending.resolve(false);
    this.permissions.clear();
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

  private async requestPermission(
    requestId: string,
    sessionId: string,
    targetId: string,
    request: { tool: string; detail?: string },
    identity: { subjectId: string; surfaceId: string; capabilityId: string } = {
      subjectId: 'tomny',
      surfaceId: 'chat',
      capabilityId: 'core',
    }
  ): Promise<boolean> {
    const authorizationRequest: PermissionRequest = {
      subjectId: identity.subjectId,
      sessionId,
      surfaceId: identity.surfaceId,
      capabilityId: identity.capabilityId,
      tool: request.tool,
    };
    if (this.deps.permissionStore) {
      const decision = await this.deps.permissionStore.authorize(authorizationRequest);
      if (decision.allowed) return true;
      if (decision.reason === 'explicit-deny') return false;
    }
    const permissionId = crypto.randomUUID();
    return new Promise<boolean>((resolve) => {
      this.permissions.set(permissionId, {
        requestId,
        sessionId,
        targetId,
        authorizationRequest,
        resolve,
      });
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

  private async runCompanyInMesh(input: {
    requestId: string;
    sessionId: string;
    targetId: string;
    companyId: string;
    goal: string;
    signal: AbortSignal;
    run: (signal: AbortSignal) => Promise<string>;
  }): Promise<string> {
    const agentId = 'president';
    const taskId = `company:${input.companyId}`;
    let summary = '';
    let failure: unknown;
    const controller = this.agentMeshService.create(input.requestId, {
      maxConcurrent: 1,
      onEvent: (event) => {
        if (event.type !== 'task-status') return;
        this.push({
          requestId: input.requestId,
          sessionId: input.sessionId,
          targetId: input.targetId,
          type: 'status',
          text: `${event.task.agentId}: ${event.status}${event.detail ? ' · ' + event.detail : ''}`,
        });
      },
    });
    if (!controller.listAgents().some((agent) => agent.agentId === agentId)) {
      controller.registerAgent({
        agentId,
        grants: [
          {
            fromAgentId: agentId,
            toAgentId: '*',
            actions: ['task', 'question', 'progress', 'result', 'handoff', 'control'],
          },
        ],
      });
    }
    controller.submitTask({ taskId, agentId, objective: input.goal }, async (_task, context) => {
      try {
        summary = await input.run(AbortSignal.any([input.signal, context.signal]));
        return { summary };
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    await controller.waitForIdle();
    if (failure) throw failure;
    const status = controller.getStatus(taskId);
    if (status === 'cancelled' || status === 'interrupted') throw new Error('The request was cancelled.');
    if (status === 'failed') throw new Error('The Company run failed.');
    return summary;
  }

  private async executeApprovedOrchestration(input: {
    proposal: OrchestrationProposal;
    requestId: string;
    sessionId: string;
    targetId: string;
    target: DetectedCoreTarget;
    adapter: CoreAdapter;
    workspace: string;
    modelKey?: string;
    permissionMode: ExperimentalPermissionMode;
    signal: AbortSignal;
    originalPrompt: string;
    surface: string;
    mcpServers: CoreMcpServer[];
    permissionIdentity: (tool: string) => { subjectId: string; surfaceId: string; capabilityId: string };
  }): Promise<string> {
    const runAgent = async (prompt: string, runSignal: AbortSignal = input.signal): Promise<string> => {
      let response = '';
      await this.withAgentLease(() =>
        input.adapter.run({
          sessionId: crypto.randomUUID(),
          target: input.target,
          prompt,
          workspace: input.workspace,
          modelKey: input.modelKey,
          permissionMode: input.permissionMode,
          surface: input.surface,
          mcpServers: input.mcpServers,
          signal: runSignal,
          emit: (event) => {
            if (event.type === 'delta') response = event.mode === 'replace' ? event.text : response + event.text;
            else
              this.pushAdapterEvent({
                requestId: input.requestId,
                sessionId: input.sessionId,
                targetId: input.targetId,
                workspace: input.workspace,
                event,
              });
          },
          requestPermission: (request) =>
            this.requestPermission(
              input.requestId,
              input.sessionId,
              input.targetId,
              request,
              input.permissionIdentity(request.tool)
            ),
        })
      );
      return response;
    };

    if (input.proposal.kind === 'company') {
      if (!this.deps.companyRunner) throw new Error('The Company core runner is unavailable.');
      const companyId = await this.deps.companyRunner.create(input.proposal);
      this.push({
        requestId: input.requestId,
        sessionId: input.sessionId,
        targetId: input.targetId,
        type: 'orchestration-created',
        orchestrationKind: 'company',
        orchestrationId: companyId,
        text: `Approved Company created: ${companyId}`,
      });
      return this.runCompanyInMesh({
        requestId: input.requestId,
        sessionId: input.sessionId,
        targetId: input.targetId,
        companyId,
        goal: input.originalPrompt,
        signal: input.signal,
        run: (companySignal) =>
          this.deps.companyRunner!.run({
            companyId,
            goal: input.originalPrompt,
            model: input.modelKey,
            signal: companySignal,
            chat: ({ messages, signal: chatSignal }) =>
              runAgent(
                [
                  'You are executing one approved Company role. Do not create or propose another Team or Company.',
                  ...messages.map((message) => message.role.toUpperCase() + ': ' + message.content),
                ].join('\n\n'),
                chatSignal ?? input.signal
              ),
            onEvent: (event) => {
              if (event.type === 'status') {
                this.push({
                  requestId: input.requestId,
                  sessionId: input.sessionId,
                  targetId: input.targetId,
                  type: 'status',
                  text: event.text,
                });
              } else {
                void this.requestPermission(
                  input.requestId,
                  input.sessionId,
                  input.targetId,
                  {
                    tool: event.tool,
                    detail: event.detail,
                  },
                  input.permissionIdentity(event.tool)
                ).then(event.resolve);
              }
            },
          }),
      });
    }

    const results = new Map<string, string>();
    const mesh = this.agentMeshService.create(input.requestId, {
      maxConcurrent: input.proposal.parallelism,
      totalTokenBudget: input.proposal.estimatedTokens,
      onEvent: (event) => {
        if (event.type !== 'task-status') return;
        this.push({
          requestId: input.requestId,
          sessionId: input.sessionId,
          targetId: input.targetId,
          type: 'status',
          text: `${event.task.agentId}: ${event.status}${event.detail ? ' · ' + event.detail : ''}`,
        });
      },
    });
    const communicationActions: AgentMessageKind[] = ['task', 'question', 'progress', 'result', 'handoff', 'control'];
    mesh.registerAgent({
      agentId: 'leader',
      grants: [{ fromAgentId: 'leader', toAgentId: '*', actions: communicationActions }],
    });
    for (const role of input.proposal.roles) {
      mesh.registerAgent({
        agentId: role.id,
        parentAgentId: 'leader',
        grants: [
          { fromAgentId: role.id, toAgentId: '*', actions: communicationActions.filter((kind) => kind !== 'control') },
        ],
      });
    }
    for (const role of input.proposal.roles) {
      mesh.submitTask(
        {
          taskId: role.id,
          agentId: role.id,
          objective: role.responsibility,
          dependsOn: role.dependsOn,
          estimatedTokens:
            role.estimatedTokens ??
            (input.proposal.estimatedTokens
              ? Math.max(1, Math.floor(input.proposal.estimatedTokens / input.proposal.roles.length))
              : undefined),
        },
        async (_task, context) => {
          const dependencies = role.dependsOn
            .map((dependency) => results.get(dependency))
            .filter((result): result is string => Boolean(result));
          const response = await runAgent(
            [
              `You are the ${role.name} in an approved temporary Team.`,
              `Responsibility: ${role.responsibility}`,
              `Shared user goal: ${input.originalPrompt}`,
              dependencies.length > 0 ? `Dependency results:\n${dependencies.join('\n\n')}` : '',
              'Do not create or propose another Team or Company. Return a concise evidence-based result to the leader.',
            ]
              .filter(Boolean)
              .join('\n\n'),
            AbortSignal.any([input.signal, context.signal])
          );
          results.set(role.id, response);
          return { summary: response, tokensUsed: role.estimatedTokens };
        }
      );
    }
    await mesh.waitForIdle();
    const reports = input.proposal.roles
      .map((role) => `${role.name}:\n${results.get(role.id) ?? '[No result]'}`)
      .join('\n\n');
    return runAgent(
      [
        'You are the leader of an approved temporary Team.',
        `Original user goal: ${input.originalPrompt}`,
        `Team reports:\n${reports}`,
        'Synthesize the final answer. Resolve disagreements, state incomplete work honestly, and do not propose another orchestration.',
      ].join('\n\n')
    );
  }

  private push(event: Omit<ExperimentalCoreEvent, 'timestamp' | 'sequence'>): void {
    const complete = { ...event, timestamp: Date.now(), sequence: this.nextEventSequence++ };
    const journal = this.runEvents.get(event.requestId) ?? [];
    journal.push(complete);
    if (journal.length > MAX_REPLAY_EVENTS_PER_RUN) journal.splice(0, journal.length - MAX_REPLAY_EVENTS_PER_RUN);
    this.runEvents.set(event.requestId, journal);
    void this.eventStore
      .append({
        sessionId: complete.sessionId,
        requestId: complete.requestId,
        kind: durableKindForEvent(complete),
        visibility: complete.type === 'permission' || complete.type === 'thinking' ? 'private' : 'public',
        payload: durablePayloadForEvent(complete),
        timestamp: complete.timestamp,
      })
      .catch((error) => console.warn('[TomnyCore] Event journal append failed:', errorMessage(error)));
    this.emit(complete);
  }

  private observeAdapterTelemetry(requestId: string, event: CoreAdapterEvent): void {
    const telemetry = this.deps.telemetry;
    if (!telemetry) return;
    let operation: Promise<void> | undefined;
    if (event.type === 'delta' && event.text) operation = telemetry.firstToken(requestId);
    else if (event.type === 'tool-call') operation = telemetry.toolStarted(requestId, event.tool);
    else if (event.type === 'tool-result') operation = telemetry.toolCompleted(requestId, event.tool, event.outcome);
    void operation?.catch((error) => console.warn('[TomnyCore] Telemetry event failed:', errorMessage(error)));
  }

  private recordTerminalTelemetry(requestId: string, state: 'completed' | 'cancelled' | 'failed'): void {
    const telemetry = this.deps.telemetry;
    if (!telemetry) return;
    const operation =
      state === 'completed'
        ? telemetry.complete(requestId)
        : state === 'cancelled'
          ? telemetry.cancel(requestId)
          : telemetry.fail(requestId);
    void operation.catch((error) => console.warn('[TomnyCore] Telemetry terminal event failed:', errorMessage(error)));
  }

  private pushAdapterEvent(input: {
    requestId: string;
    sessionId: string;
    targetId: string;
    workspace: string;
    event: CoreAdapterEvent;
  }): void {
    this.push({
      requestId: input.requestId,
      sessionId: input.sessionId,
      targetId: input.targetId,
      workspace: input.workspace,
      ...input.event,
    });
  }

  private async withAgentLease<T>(run: () => Promise<T>): Promise<T> {
    const lease = await this.deps.coordinator?.requestLease({ kind: 'agent', estCostMB: 96 });
    try {
      return await run();
    } finally {
      if (lease) this.deps.coordinator?.releaseLease(lease.id);
    }
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
    companyId?: string,
    resumePendingTurn = false,
    contextIdentity: Required<ExperimentalCoreContextIdentity> = normalizeContextIdentity()
  ): Promise<void> {
    let checkpoint: CoreSessionCheckpoint | undefined;
    let activeTransportKey: string | undefined;
    let transportSucceeded = false;
    let assistantText = '';
    try {
      await this.initialized;
      const normalizedPrompt = prompt.trim();
      const normalizedWorkspace = requireWorkspace(workspace);
      if (!normalizedPrompt) throw new Error('Prompt cannot be empty.');
      try {
        await this.deps.telemetry?.startRun({ runId: requestId, sessionId, targetId });
      } catch (error) {
        console.warn('[TomnyCore] Telemetry start failed:', errorMessage(error));
      }

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
      const surfaceResolution = this.deps.surfaceRegistry?.resolve({
        surfaceId: contextIdentity.surface,
        model: {
          targetKind: kindForTarget(target),
          protocol: target.protocol,
          modelId: companyModel?.modelKey ?? modelKey,
          capabilities: contextIdentity.modelCapabilities,
        },
        permissionMode,
        grantedPermissionScopes: contextIdentity.permissionScopes,
        explicitlyGrantedCapabilityIds: contextIdentity.capabilityGrants,
        availableCapabilityIds: contextIdentity.availableCapabilities,
      });
      if (surfaceResolution?.ok === false) {
        throw new Error(surfaceResolution.issues.map((issue) => issue.message).join(' '));
      }
      const resolvedSurface = surfaceResolution?.ok ? surfaceResolution.value : undefined;
      const resolvedSurfaceId = resolvedSurface?.manifest.id ?? contextIdentity.surface;
      const permissionIdentity = (tool: string) =>
        permissionIdentityFor(contextIdentity, resolvedSurfaceId, resolvedSurface, tool);

      const mcpServerNames = (resolvedSurface?.capabilities ?? [])
        .filter((capability) => capability.kind === 'mcp' && Boolean(capability.serverName))
        .map((capability) => capability.serverName!);
      const mcpServers = this.deps.resolveCapabilityHosts ? await this.deps.resolveCapabilityHosts(mcpServerNames) : [];

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
      const pendingMessage = checkpoint.messages.at(-1);
      const isResumingPendingMessage =
        resumePendingTurn && pendingMessage?.role === 'user' && pendingMessage.text === normalizedPrompt;
      const priorMessages = isResumingPendingMessage ? checkpoint.messages.slice(0, -1) : [...checkpoint.messages];
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
      checkpoint.companyId = companyId;
      checkpoint.permissionMode = permissionMode;
      checkpoint.surface = resolvedSurfaceId;
      checkpoint.agentId = contextIdentity.agentId;
      checkpoint.personalId = contextIdentity.personalId;
      checkpoint.permissionScopes = contextIdentity.permissionScopes;
      checkpoint.capabilityGrants = contextIdentity.capabilityGrants;
      checkpoint.availableCapabilities = contextIdentity.availableCapabilities;
      checkpoint.modelCapabilities = contextIdentity.modelCapabilities;
      if (!isResumingPendingMessage) checkpoint.messages.push({ role: 'user', text: normalizedPrompt, timestamp: now });
      checkpoint.status = 'running';
      checkpoint.updatedAt = now;
      checkpoint.lastError = undefined;
      await this.sessionStore.save(checkpoint);

      this.push({ requestId, sessionId, targetId, type: 'started' });
      if (resolvedSurfaceId !== contextIdentity.surface) {
        this.push({
          requestId,
          sessionId,
          targetId,
          type: 'status',
          text: `Surface ${contextIdentity.surface} is unavailable; using ${resolvedSurfaceId}.`,
        });
      }
      if (previousTargetId && previousTargetId !== targetId) {
        this.push({
          requestId,
          sessionId,
          targetId,
          type: 'status',
          text: `Handing off portable context from ${previousTargetId} to ${targetId}...`,
        });
      }
      if (signal.aborted) throw new Error('The request was cancelled.');
      const portablePrompt = needsHandoff
        ? buildPortableHandoffPrompt({
            messages: portableMessages,
            prompt: normalizedPrompt,
            fromTargetId: previousTargetId,
            toTargetId: targetId,
            workspace: normalizedWorkspace,
          })
        : normalizedPrompt;
      const capabilityContract = resolvedSurface?.capabilities.length
        ? [
            `[Surface: ${resolvedSurface.manifest.id}]`,
            'Use only capabilities explicitly supplied by the active surface:',
            ...resolvedSurface.capabilities.map(
              (capability) => `- ${capability.id}: ${capability.toolPatterns.join(', ')}`
            ),
          ].join('\n')
        : '';
      const surfaceHarness = buildSurfaceHarnessPrompt(resolvedSurface);
      const surfacePrelude = [capabilityContract, surfaceHarness].filter(Boolean).join('\n\n');
      let effectivePrompt = surfacePrelude ? `${surfacePrelude}\n\n${portablePrompt}` : portablePrompt;
      if (this.deps.contextComposer) {
        try {
          effectivePrompt = await this.deps.contextComposer.composePrompt({
            agentId: contextIdentity.agentId,
            personalId: contextIdentity.personalId,
            surface: resolvedSurfaceId,
            prompt: effectivePrompt,
          });
        } catch (error) {
          console.warn(
            '[TomnyCore] Context composition failed; continuing without personalization:',
            errorMessage(error)
          );
        }
      }
      if (isCompany) {
        assistantText = await this.runCompanyInMesh({
          requestId,
          sessionId,
          targetId,
          companyId: companyId!.trim(),
          goal: effectivePrompt,
          signal,
          run: (companySignal) =>
            this.deps.companyRunner!.run({
              companyId: companyId!.trim(),
              goal: effectivePrompt,
              model: companyModel?.modelKey,
              signal: companySignal,
              chat: async ({ messages, model, signal: chatSignal }) => {
                let response = '';
                await adapter.run({
                  sessionId: crypto.randomUUID(),
                  target,
                  prompt: messages.map((message) => message.role.toUpperCase() + ': ' + message.content).join('\n\n'),
                  workspace: normalizedWorkspace,
                  modelKey: model ?? companyModel?.modelKey,
                  permissionMode,
                  surface: resolvedSurfaceId,
                  mcpServers,
                  signal: chatSignal,
                  emit: (event) => {
                    this.observeAdapterTelemetry(requestId, event);
                    if (event.type === 'delta')
                      response = event.mode === 'replace' ? event.text : response + event.text;
                    else
                      this.pushAdapterEvent({ requestId, sessionId, targetId, workspace: normalizedWorkspace, event });
                  },
                  requestPermission: (request) =>
                    this.requestPermission(requestId, sessionId, targetId, request, permissionIdentity(request.tool)),
                });
                return response;
              },
              onEvent: (event) => {
                if (event.type === 'status')
                  this.push({ requestId, sessionId, targetId, type: 'status', text: event.text });
                else {
                  void this.requestPermission(
                    requestId,
                    sessionId,
                    targetId,
                    {
                      tool: event.tool,
                      detail: event.detail,
                    },
                    permissionIdentity(event.tool)
                  ).then(event.resolve);
                }
              },
            }),
        });
        this.push({ requestId, sessionId, targetId, type: 'delta', text: assistantText, mode: 'replace' });
      } else {
        let candidateResponse = '';
        await this.withAgentLease(() =>
          adapter.run({
            sessionId,
            target,
            prompt: shouldOfferOrchestration(normalizedPrompt)
              ? [ORCHESTRATION_CAPABILITY_PROMPT, `User request:\n${effectivePrompt}`].join('\n\n')
              : effectivePrompt,
            workspace: normalizedWorkspace,
            modelKey,
            permissionMode,
            surface: resolvedSurfaceId,
            mcpServers,
            signal,
            emit: (event) => {
              this.observeAdapterTelemetry(requestId, event);
              if (event.type === 'delta') {
                candidateResponse = event.mode === 'replace' ? event.text : candidateResponse + event.text;

                const active = this.active.get(requestId);
                if (active) active.partialText = candidateResponse;
                return;
              }
              this.pushAdapterEvent({ requestId, sessionId, targetId, workspace: normalizedWorkspace, event });
            },
            requestPermission: (request) =>
              this.requestPermission(requestId, sessionId, targetId, request, permissionIdentity(request.tool)),
          })
        );
        const proposal = parseOrchestrationProposal(candidateResponse);
        if (!proposal) {
          assistantText = candidateResponse;
        } else {
          this.push({
            requestId,
            sessionId,
            targetId,
            type: 'status',
            text: `Agent proposed an approved-gated ${proposal.kind}.`,
          });
          const orchestrationTool = `orchestration.create.${proposal.kind}`;
          const approved = await this.requestPermission(
            requestId,
            sessionId,
            targetId,
            { tool: orchestrationTool, detail: describeOrchestrationProposal(proposal) },
            permissionIdentity(orchestrationTool)
          );
          if (approved) {
            assistantText = await this.executeApprovedOrchestration({
              proposal,
              requestId,
              sessionId,
              targetId,
              target,
              adapter,
              workspace: normalizedWorkspace,
              modelKey,
              permissionMode,
              signal,
              originalPrompt: normalizedPrompt,
              surface: resolvedSurfaceId,
              mcpServers,
              permissionIdentity,
            });
          } else {
            assistantText = `The ${proposal.kind} proposal was declined. No agents or company were created.`;
          }
        }
        this.push({ requestId, sessionId, targetId, type: 'delta', text: assistantText, mode: 'replace' });
      }
      const activeState = this.active.get(requestId);
      const lifecycleInterrupted = signal.aborted && activeState?.lifecycleInterrupted === true;
      transportSucceeded = !signal.aborted;
      checkpoint.status = lifecycleInterrupted ? 'interrupted' : signal.aborted ? 'cancelled' : 'completed';
      this.recordTerminalTelemetry(requestId, signal.aborted ? 'cancelled' : 'completed');
      if (!lifecycleInterrupted) {
        this.push({ requestId, sessionId, targetId, type: signal.aborted ? 'cancelled' : 'completed' });
      }
    } catch (error) {
      const message = errorMessage(error);
      const activeState = this.active.get(requestId);
      const lifecycleInterrupted = signal.aborted && activeState?.lifecycleInterrupted === true;
      const cancelledByUser = signal.aborted && activeState?.cancelledByUser === true;
      if (activeTransportKey) this.transportCursors.delete(activeTransportKey);
      if (checkpoint) {
        checkpoint.status = lifecycleInterrupted ? 'interrupted' : cancelledByUser ? 'cancelled' : 'error';
        checkpoint.lastError = lifecycleInterrupted || cancelledByUser ? undefined : message;
      }
      if (!lifecycleInterrupted) {
        this.recordTerminalTelemetry(requestId, cancelledByUser ? 'cancelled' : 'failed');
        this.push({
          requestId,
          sessionId,
          targetId,
          type: cancelledByUser ? 'cancelled' : 'error',
          text: cancelledByUser ? undefined : message,
        });
      }
    } finally {
      if (checkpoint) {
        if (assistantText) checkpoint.messages.push({ role: 'assistant', text: assistantText, timestamp: Date.now() });
        if (transportSucceeded && activeTransportKey) {
          this.transportCursors.set(activeTransportKey, checkpoint.messages.length);
        }
        checkpoint.updatedAt = Date.now();
        await this.sessionStore.save(checkpoint).catch((): void => undefined);
      }
      this.denyPermissionsForRequest(requestId);
      this.active.delete(requestId);

      this.runEvents.delete(requestId);
    }
  }
}
