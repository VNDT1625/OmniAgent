/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanyCoreRunInput } from '../../../packages/desktop/src/process/agentRuntime/companyCoreRunner';
import { createAgentMeshService } from '../../../packages/desktop/src/process/agentRuntime/agentMesh/service';
import {
  createBuiltinSurfaceManifests,
  createSurfaceRegistry,
} from '../../../packages/desktop/src/process/agentRuntime/surfaceRegistry';
import { MemoryDurableEventStore } from '../../../packages/desktop/src/process/services/agentChat/durability';
import {
  MemoryPermissionRepository,
  PermissionStore,
} from '../../../packages/desktop/src/process/services/agentChat/permission';
import type {
  CoreAdapter,
  CoreRunInput,
  DetectedCoreTarget,
} from '../../../packages/desktop/src/process/experimentalCore/adapters/coreAdapter';
import {
  JsonCoreSessionStore,
  MemoryCoreSessionStore,
  redactCheckpointText,
} from '../../../packages/desktop/src/process/experimentalCore/sessionCheckpointStore';

import {
  ExperimentalCoreRuntime,
  type ExperimentalCoreEvent,
} from '../../../packages/desktop/src/process/experimentalCore/experimentalCoreRuntime';

const target: DetectedCoreTarget = {
  id: 'codex',
  name: 'Codex CLI',
  protocol: 'codex-app-server',
  candidates: ['codex'],
  args: ['app-server'],
  detail: 'direct',
  runnable: true,
  detected: true,
  available: true,
  command: 'codex.exe',
};

const makeAdapter = (): CoreAdapter => ({
  protocol: 'codex-app-server',
  listModels: vi
    .fn()
    .mockResolvedValue([{ key: 'gpt::medium', modelId: 'gpt', label: 'GPT (medium)', isDefault: true }]),
  run: vi.fn(async (input: CoreRunInput) => {
    input.emit({ type: 'delta', text: `reply:${input.prompt}`, mode: 'append' });
  }),
  dispose: vi.fn().mockResolvedValue(undefined),
});

describe('experimental direct core runtime', () => {
  let adapter: CoreAdapter;

  let coordinator: { requestLease: ReturnType<typeof vi.fn>; releaseLease: ReturnType<typeof vi.fn> };
  let events: ExperimentalCoreEvent[];
  let runtime: ExperimentalCoreRuntime;
  let meshService: ReturnType<typeof createAgentMeshService>;

  beforeEach(() => {
    adapter = makeAdapter();
    events = [];
    meshService = createAgentMeshService();
    coordinator = {
      requestLease: vi.fn().mockResolvedValue({ id: 'agent-lease' }),
      releaseLease: vi.fn(),
    };
    runtime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      agentMeshService: meshService,
    });
  });

  it('lists direct targets and models without aioncore collaborators', async () => {
    await expect(runtime.listTargets()).resolves.toEqual([
      expect.objectContaining({ id: 'codex', available: true, defaultModelKey: 'gpt::medium' }),
    ]);
    expect(adapter.listModels).toHaveBeenCalledWith(target, undefined);
  });

  it('runs a selected Company through a direct adapter without AionCore', async () => {
    const companyRunner = {
      run: vi.fn(async (input: CompanyCoreRunInput) => {
        await input.chat({
          messages: [{ role: 'user' as const, content: input.goal }],
          model: input.model,
          signal: input.signal,
        });
        input.onEvent({ type: 'status' as const, text: 'worker: done' });
        return 'company summary';
      }),
    };
    const companyRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      companyRunner,
      agentMeshService: meshService,
    });
    const targets = await companyRuntime.listTargets();
    const company = targets.find((item) => item.id === 'company');
    companyRuntime.start(
      'company-request',
      'company',
      'build feature',
      'C:/workspace',
      company?.defaultModelKey,
      'workspace-write',
      undefined,
      'engineering'
    );

    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'company-request' && event.type === 'completed')).toBe(true)
    );
    expect(companyRunner.run).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'engineering' }));
    expect(events).toContainEqual(
      expect.objectContaining({ requestId: 'company-request', type: 'delta', text: 'company summary' })
    );
    expect(meshService.listSessions()).toContain('company-request');
    expect(meshService.snapshot('company-request')).toEqual(
      expect.objectContaining({
        sessionId: 'company-request',
        agents: [expect.objectContaining({ agentId: 'president' })],
        tasks: [expect.objectContaining({ status: 'completed' })],
      })
    );
  });

  it('lets the shared AgentMesh service inspect and interrupt the active Company task', async () => {
    const companyRunner = {
      create: vi.fn(),
      run: vi.fn(
        (input: CompanyCoreRunInput) =>
          new Promise<string>((_resolve, reject) => {
            const abort = () => reject(new Error('company interrupted through AgentMesh'));
            if (input.signal.aborted) abort();
            else input.signal.addEventListener('abort', abort, { once: true });
          })
      ),
    };
    const companyRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      companyRunner,
      agentMeshService: meshService,
    });
    const targets = await companyRuntime.listTargets();
    companyRuntime.start(
      'company-interrupt',
      'company',
      'long-running company goal',
      'C:/workspace',
      targets.find((item) => item.id === 'company')?.defaultModelKey,
      'workspace-write',
      undefined,
      'engineering'
    );

    await vi.waitFor(() =>
      expect(meshService.snapshot('company-interrupt').tasks).toContainEqual(
        expect.objectContaining({ status: 'working' })
      )
    );
    meshService.stop('company-interrupt', 'president', 'company:engineering', 'interrupt');

    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          requestId: 'company-interrupt',
          type: 'error',
          text: 'company interrupted through AgentMesh',
        })
      )
    );
    expect(meshService.snapshot('company-interrupt').tasks).toContainEqual(
      expect.objectContaining({ status: 'interrupted' })
    );
  });

  it('does not hold an outer agent lease while Company roles request their own leases', async () => {
    let activeLease = false;
    const singleSlotCoordinator = {
      requestLease: vi.fn(async () => {
        if (activeLease) return new Promise<{ id: string }>(() => undefined);
        activeLease = true;
        return { id: 'single-agent-slot' };
      }),
      releaseLease: vi.fn(() => {
        activeLease = false;
      }),
    };
    const companyRunner = {
      create: vi.fn(),
      run: vi.fn(async () => {
        const lease = await singleSlotCoordinator.requestLease();
        singleSlotCoordinator.releaseLease(lease.id);
        return 'company result';
      }),
    };
    const companyRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator: singleSlotCoordinator,
      companyRunner,
    });
    const targets = await companyRuntime.listTargets();
    companyRuntime.start(
      'company-single-slot',
      'company',
      'coordinate roles',
      'C:/workspace',
      targets.find((item) => item.id === 'company')?.defaultModelKey,
      'workspace-write',
      undefined,
      'engineering'
    );

    await vi.waitFor(
      () =>
        expect(events.some((event) => event.requestId === 'company-single-slot' && event.type === 'completed')).toBe(
          true
        ),
      { timeout: 300 }
    );
    expect(singleSlotCoordinator.requestLease).toHaveBeenCalledTimes(1);
  });

  it('discovers models with the selected workspace instead of guessing globally', async () => {
    await runtime.listTargets();
    const discovered = await runtime.listModels('codex', 'C:/workspace');
    vi.mocked(adapter.listModels).mockRejectedValueOnce(new Error('temporary discovery failure'));

    await expect(runtime.listModels('codex', 'C:/workspace')).resolves.toEqual(discovered);
    expect(adapter.listModels).toHaveBeenLastCalledWith(target, 'C:/workspace');
  });

  it('streams and completes consecutive prompts through the same adapter', async () => {
    await runtime.listTargets();
    runtime.start('request-1', 'codex', 'hello', 'C:/workspace');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'completed')).toBe(true));
    runtime.start('request-2', 'codex', 'again', 'C:/workspace');
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'request-2' && event.type === 'completed')).toBe(true)
    );

    expect(adapter.run).toHaveBeenCalledTimes(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: 'request-1', type: 'delta', text: 'reply:hello' }),
        expect.objectContaining({ requestId: 'request-2', type: 'delta', text: 'reply:again' }),
      ])
    );
  });

  it('pauses a protected tool until the renderer resolves permission', async () => {
    vi.mocked(adapter.run).mockImplementationOnce(async (input) => {
      const approved = await input.requestPermission({ tool: 'terminal', detail: 'bun test' });
      input.emit({ type: 'status', text: approved ? 'approved' : 'denied' });
    });

    await runtime.listTargets();
    runtime.start('permission-request', 'codex', 'run tests', 'C:/workspace');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'permission')).toBe(true));
    const permission = events.find((event) => event.type === 'permission');

    expect(permission).toEqual(
      expect.objectContaining({
        requestId: 'permission-request',
        tool: 'terminal',
        detail: 'bun test',
      })
    );
    expect(await runtime.resolvePermission(permission?.permissionId ?? '', true)).toBe(true);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'status' && event.text === 'approved')).toBe(true)
    );
  });

  it('does not create a proposed Team until the user approves it', async () => {
    let calls = 0;
    vi.mocked(adapter.run).mockImplementation(async (input) => {
      calls += 1;
      input.emit({
        type: 'delta',
        mode: 'replace',
        text:
          calls === 1
            ? '<tomny_orchestration_proposal>{"kind":"team","name":"Delivery","reason":"Frontend and backend can run independently","parallelism":2,"estimatedTokens":3000,"roles":[{"id":"frontend","name":"Frontend","responsibility":"Build the UI","dependsOn":[]},{"id":"backend","name":"Backend","responsibility":"Build the API","dependsOn":[]}]}</tomny_orchestration_proposal>'
            : `agent-result-${calls}`,
      });
    });

    await runtime.listTargets();
    runtime.start(
      'team-proposal',
      'codex',
      'Build the full frontend and backend application, design the database, then run QA and security testing.',
      'C:/workspace'
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'permission' && event.tool === 'orchestration.create.team')).toBe(
        true
      )
    );
    expect(adapter.run).toHaveBeenCalledTimes(1);
    const permission = events.find(
      (event) => event.type === 'permission' && event.tool === 'orchestration.create.team'
    );
    runtime.resolvePermission(permission?.permissionId ?? '', true);

    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'team-proposal' && event.type === 'completed')).toBe(true)
    );
    expect(adapter.run).toHaveBeenCalledTimes(4);
    expect(meshService.listSessions()).toContain('team-proposal');
    expect(meshService.snapshot('team-proposal').agents.map((agent) => agent.agentId)).toEqual([
      'leader',
      'frontend',
      'backend',
    ]);
    expect(meshService.canSend('team-proposal', 'leader', 'frontend', 'control')).toBe(true);
    expect(meshService.canSend('team-proposal', 'frontend', 'backend', 'question')).toBe(true);
  });

  it('creates nothing when an orchestration proposal is denied', async () => {
    vi.mocked(adapter.run).mockImplementationOnce(async (input) => {
      input.emit({
        type: 'delta',
        mode: 'replace',
        text: '<tomny_orchestration_proposal>{"kind":"team","name":"Review","reason":"Parallel review","parallelism":2,"roles":[{"id":"code","name":"Code","responsibility":"Review code","dependsOn":[]},{"id":"test","name":"Test","responsibility":"Review tests","dependsOn":[]}]}</tomny_orchestration_proposal>',
      });
    });
    await runtime.listTargets();
    runtime.start(
      'team-denied',
      'codex',
      'Audit the full frontend and backend implementation, then run independent QA and security reviews.',
      'C:/workspace'
    );
    await vi.waitFor(() => expect(events.some((event) => event.type === 'permission')).toBe(true));
    const permission = events.find((event) => event.type === 'permission');
    runtime.resolvePermission(permission?.permissionId ?? '', false);

    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'team-denied' && event.type === 'completed')).toBe(true)
    );
    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  it('rejects requests that do not include an explicit workspace', async () => {
    await runtime.listTargets();
    runtime.start('missing-workspace', 'codex', 'inspect files');
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'missing-workspace' && event.type === 'error')).toBe(true)
    );

    expect(adapter.run).not.toHaveBeenCalled();
    expect(events).toContainEqual(
      expect.objectContaining({
        requestId: 'missing-workspace',
        type: 'error',
        text: 'Select a workspace before starting the agent.',
      })
    );
  });

  it('passes the user-selected workspace to every adapter run', async () => {
    await runtime.listTargets();
    runtime.start('workspace-request', 'codex', 'inspect files', 'C:/NDT/PJ/sample');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'completed')).toBe(true));

    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: 'C:/NDT/PJ/sample',
      })
    );
  });

  it('checkpoints and resumes an isolated conversation session', async () => {
    await runtime.listTargets();
    const started = runtime.start('session-request-1', 'codex', 'hello', 'C:/workspace');
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'session-request-1' && event.type === 'completed')).toBe(true)
    );

    runtime.start(
      'session-request-2',
      'codex',
      'again',
      'C:/workspace',
      undefined,
      'workspace-write',
      started.sessionId
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'session-request-2' && event.type === 'completed')).toBe(true)
    );

    const sessions = await runtime.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: started.sessionId, status: 'completed' });
    expect(sessions[0]?.messages.map((message) => [message.role, message.text])).toEqual([
      ['user', 'hello'],
      ['assistant', 'reply:hello'],
      ['user', 'again'],
      ['assistant', 'reply:again'],
    ]);
    expect(vi.mocked(adapter.run).mock.calls[1]?.[0].sessionId).toBe(started.sessionId);
  });

  it('rehydrates context when the user changes model inside a saved session', async () => {
    await runtime.listTargets();
    const started = runtime.start('model-request-1', 'codex', 'first question', 'C:/workspace', 'gpt::medium');
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'model-request-1' && event.type === 'completed')).toBe(true)
    );

    runtime.start(
      'model-request-2',
      'codex',
      'continue',
      'C:/workspace',
      'gpt::high',
      'workspace-write',
      started.sessionId
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'model-request-2' && event.type === 'completed')).toBe(true)
    );

    expect(vi.mocked(adapter.run).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        modelKey: 'gpt::high',
        prompt: expect.stringContaining('Assistant: reply:first question'),
      })
    );
    await expect(runtime.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: started.sessionId, modelKey: 'gpt::high' }),
    ]);
  });

  it('hands one portable session across providers and only sends each transport its missing context', async () => {
    const claudeTarget: DetectedCoreTarget = {
      ...target,
      id: 'claude',
      name: 'Claude Code',
      protocol: 'acp',
      candidates: ['claude-agent-acp'],
      command: 'claude-agent-acp.exe',
    };
    const codexAdapter = makeAdapter();
    const claudeAdapter: CoreAdapter = {
      ...makeAdapter(),
      protocol: 'acp',
    };
    vi.mocked(codexAdapter.run).mockImplementation(async (input) => {
      input.emit({ type: 'delta', text: 'codex answer', mode: 'append' });
    });
    vi.mocked(claudeAdapter.run).mockImplementation(async (input) => {
      input.emit({ type: 'delta', text: 'claude answer', mode: 'append' });
    });
    const portableRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target, claudeTarget]),
      adapters: [codexAdapter, claudeAdapter],
      coordinator,
    });
    await portableRuntime.listTargets();

    const started = portableRuntime.start('portable-codex-1', 'codex', 'first question', 'C:/workspace');
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'portable-codex-1' && event.type === 'completed')).toBe(true)
    );
    portableRuntime.start(
      'portable-claude',
      'claude',
      'review the work',
      'C:/workspace',
      undefined,
      'workspace-write',
      started.sessionId
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'portable-claude' && event.type === 'completed')).toBe(true)
    );
    portableRuntime.start(
      'portable-codex-2',
      'codex',
      'finish it',
      'C:/workspace',
      undefined,
      'workspace-write',
      started.sessionId
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'portable-codex-2' && event.type === 'completed')).toBe(true)
    );

    const claudePrompt = vi.mocked(claudeAdapter.run).mock.calls[0]?.[0].prompt ?? '';
    const returningCodexPrompt = vi.mocked(codexAdapter.run).mock.calls[1]?.[0].prompt ?? '';
    expect(claudePrompt).toContain('Previous agent: codex');
    expect(claudePrompt).toContain('Assistant: codex answer');
    expect(returningCodexPrompt).toContain('Previous agent: claude');
    expect(returningCodexPrompt).toContain('Assistant: claude answer');
    expect(returningCodexPrompt).not.toContain('Assistant: codex answer');

    await expect(portableRuntime.listSessions()).resolves.toEqual([
      expect.objectContaining({
        id: started.sessionId,
        targetId: 'codex',
        transitions: [
          expect.objectContaining({ fromTargetId: 'codex', toTargetId: 'claude' }),
          expect.objectContaining({ fromTargetId: 'claude', toTargetId: 'codex' }),
        ],
      }),
    ]);
  });

  it('forks a checkpoint without mutating the source session', async () => {
    await runtime.listTargets();
    const started = runtime.start('fork-source-request', 'codex', 'hello', 'C:/workspace');
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'fork-source-request' && event.type === 'completed')).toBe(true)
    );

    const forked = await runtime.forkSession(started.sessionId);
    const sessions = await runtime.listSessions();
    const source = sessions.find((session) => session.id === started.sessionId);

    expect(forked).toMatchObject({ parentId: started.sessionId, status: 'idle' });
    expect(forked.id).not.toBe(started.sessionId);
    expect(forked.messages).toEqual(source?.messages);
  });

  it('recovers an interrupted checkpoint by hydrating a fresh transport session', async () => {
    const sessionStore = new MemoryCoreSessionStore();
    await sessionStore.save({
      id: 'recovered-session',
      targetId: 'codex',
      workspace: 'C:/workspace',
      permissionMode: 'workspace-write',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { role: 'user', text: 'prior question', timestamp: 1 },
        { role: 'assistant', text: 'prior answer', timestamp: 2 },
      ],
    });
    const recoveredRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      sessionStore,
    });
    await recoveredRuntime.listTargets();

    recoveredRuntime.start(
      'recovery-request',
      'codex',
      'continue',
      'C:/workspace',
      undefined,
      'workspace-write',
      'recovered-session'
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'recovery-request' && event.type === 'completed')).toBe(true)
    );

    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'recovered-session',
        prompt: expect.stringContaining('Assistant: prior answer'),
      })
    );
  });

  it('redacts common credentials before checkpoint persistence', () => {
    expect(redactCheckpointText('api_key=top-secret password=hunter2 Bearer abc.def.ghi')).toBe(
      'api_key[REDACTED] password[REDACTED] Bearer [REDACTED]'
    );
    expect(redactCheckpointText('send sk-abcdefghijklmnopqrstuvwxyz now')).toBe('send [REDACTED] now');
  });

  it('atomically persists redacted checkpoints and marks a crashed run interrupted', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tomny-checkpoint-'));
    const filePath = path.join(directory, 'sessions.json');
    try {
      const store = new JsonCoreSessionStore(filePath);
      await store.initialize();
      await store.save({
        id: 'disk-session',
        targetId: 'tomny',
        workspace: 'C:/workspace',
        permissionMode: 'workspace-write',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
        messages: [{ role: 'user', text: 'api_key=top-secret', timestamp: 1 }],
        lastError: 'request failed with Bearer leaked.error.token',
      });

      const recovered = new JsonCoreSessionStore(filePath);
      await recovered.initialize();

      await expect(recovered.get('disk-session')).resolves.toMatchObject({
        status: 'interrupted',
        messages: [{ text: 'api_key[REDACTED]' }],
      });
      expect(await readFile(filePath, 'utf8')).not.toContain('top-secret');
      expect(await readFile(filePath, 'utf8')).not.toContain('leaked.error.token');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('replays a bounded active turn snapshot after the renderer reconnects', async () => {
    let finish: (() => void) | undefined;
    vi.mocked(adapter.run).mockImplementationOnce(async (input) => {
      input.emit({ type: 'delta', text: 'partial', mode: 'append' });

      input.emit({ type: 'status', text: 'working' });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await runtime.listTargets();
    const started = runtime.start('reattach-request', 'codex', 'long task', 'C:/workspace');
    await vi.waitFor(() => expect(runtime.listActiveRuns()[0]?.partialText).toBe('partial'));

    const snapshot = runtime.listActiveRuns()[0];
    expect(snapshot).toMatchObject({
      requestId: 'reattach-request',
      sessionId: started.sessionId,
      targetId: 'codex',
      partialText: 'partial',
      events: [expect.objectContaining({ type: 'started' }), expect.objectContaining({ text: 'working' })],
    });
    expect(snapshot?.events[1]?.sequence).toBeGreaterThan(snapshot?.events[0]?.sequence ?? 0);

    finish?.();
    await vi.waitFor(() => expect(runtime.listActiveRuns()).toHaveLength(0));
  });

  it('restarts one interrupted user turn without duplicating its checkpoint message', async () => {
    const sessionStore = new MemoryCoreSessionStore();
    await sessionStore.save({
      id: 'resume-session',
      targetId: 'codex',
      workspace: 'C:/workspace',
      modelKey: 'gpt::medium',
      permissionMode: 'workspace-write',
      status: 'running',
      createdAt: 1,
      updatedAt: 1,
      messages: [
        { role: 'user', text: 'prior', timestamp: 1 },
        { role: 'assistant', text: 'prior answer', timestamp: 2 },
        { role: 'user', text: 'unfinished request', timestamp: 3 },
      ],
    });
    const resumedRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      sessionStore,
    });
    await resumedRuntime.listTargets();

    const started = await resumedRuntime.resumeInterrupted('resume-session', 'resumed-request');
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'resumed-request' && event.type === 'completed')).toBe(true)
    );

    expect(started).toEqual({ requestId: 'resumed-request', sessionId: 'resume-session' });
    expect(vi.mocked(adapter.run)).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Current user request: unfinished request'),
      })
    );
    const checkpoint = (await resumedRuntime.listSessions())[0];
    expect(checkpoint?.messages.filter((message) => message.text === 'unfinished request')).toHaveLength(1);
  });

  it('marks a graceful core shutdown interrupted so the turn can resume', async () => {
    const sessionStore = new MemoryCoreSessionStore();
    vi.mocked(adapter.run).mockImplementationOnce(
      (input) =>
        new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('shutdown')), { once: true });
        })
    );
    const shutdownRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      sessionStore,
    });
    await shutdownRuntime.listTargets();
    const started = shutdownRuntime.start('shutdown-request', 'codex', 'keep working', 'C:/workspace');
    await vi.waitFor(async () => expect((await sessionStore.get(started.sessionId))?.status).toBe('running'));

    await shutdownRuntime.dispose();

    await vi.waitFor(async () => expect((await sessionStore.get(started.sessionId))?.status).toBe('interrupted'));
  });

  it('keeps an explicit user stop cancelled instead of resumable', async () => {
    const sessionStore = new MemoryCoreSessionStore();
    vi.mocked(adapter.run).mockImplementationOnce(
      (input) =>
        new Promise<void>((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
        })
    );
    const stoppedRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      sessionStore,
    });
    await stoppedRuntime.listTargets();
    const started = stoppedRuntime.start('stop-request', 'codex', 'stop me', 'C:/workspace');
    await vi.waitFor(async () => expect((await sessionStore.get(started.sessionId))?.status).toBe('running'));

    await stoppedRuntime.cancel('stop-request');

    await vi.waitFor(async () => expect((await sessionStore.get(started.sessionId))?.status).toBe('cancelled'));
  });

  it('composes surface context for the transport without persisting the composed prompt', async () => {
    const sessionStore = new MemoryCoreSessionStore();
    const contextComposer = {
      composePrompt: vi.fn(
        async (input: { agentId: string; personalId: string; surface: string; prompt: string }) =>
          '[surface=' + input.surface + '] ' + input.prompt
      ),
    };
    const contextRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      sessionStore,
      contextComposer,
    });
    await contextRuntime.listTargets();

    const started = contextRuntime.start(
      'context-request',
      'codex',
      'compose this',
      'C:/workspace',
      undefined,
      'workspace-write',
      undefined,
      undefined,
      { surface: 'music', agentId: 'tomny', personalId: 'default' }
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'context-request' && event.type === 'completed')).toBe(true)
    );

    expect(contextComposer.composePrompt).toHaveBeenCalledWith({
      agentId: 'tomny',
      personalId: 'default',
      surface: 'music',
      prompt: 'compose this',
    });
    expect(adapter.run).toHaveBeenCalledWith(expect.objectContaining({ prompt: '[surface=music] compose this' }));
    const checkpoint = await sessionStore.get(started.sessionId);
    expect(checkpoint).toEqual(
      expect.objectContaining({
        surface: 'music',
        agentId: 'tomny',
        personalId: 'default',
      })
    );
    expect(checkpoint?.messages[0]?.text).toBe('compose this');
    expect(checkpoint?.messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
      'compose this',
    ]);
  });

  it('persists and replays completed run events after the in-memory run is gone', async () => {
    const eventStore = new MemoryDurableEventStore();
    const durableRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      eventStore,
    });
    await durableRuntime.listTargets();
    const started = durableRuntime.start('durable-request', 'codex', 'remember events', 'C:/workspace');
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'durable-request' && event.type === 'completed')).toBe(true)
    );

    const replay = await durableRuntime.replayEvents({ sessionId: started.sessionId });
    expect(replay.map((event) => event.type)).toEqual(expect.arrayContaining(['started', 'delta', 'completed']));
    expect(replay.map((event) => event.sequence)).toEqual(
      replay.map((event) => event.sequence).toSorted((a, b) => a - b)
    );
  });

  it('activates only explicitly granted capabilities for a registered surface', async () => {
    const resolveCapabilityHosts = vi.fn(async (names: string[]) =>
      names.map((name) => ({ name, url: 'http://127.0.0.1/mcp' }))
    );
    const contextComposer = {
      composePrompt: vi.fn(
        async (input: { agentId: string; personalId: string; surface: string; prompt: string }) => input.prompt
      ),
    };
    const surfaceRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      contextComposer,
      resolveCapabilityHosts,
      surfaceRegistry: createSurfaceRegistry({
        manifests: createBuiltinSurfaceManifests(),
        defaultSurfaceId: 'chat',
      }),
    });
    await surfaceRuntime.listTargets();
    surfaceRuntime.start(
      'surface-request',
      'codex',
      'mix a track',
      'C:/workspace',
      undefined,
      'workspace-write',
      undefined,
      undefined,
      {
        surface: 'music',
        agentId: 'tomny',
        personalId: 'default',
        permissionScopes: ['music.read', 'music.write'],
        capabilityGrants: ['surface.music'],
        availableCapabilities: ['surface.music'],
      }
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'surface-request' && event.type === 'completed')).toBe(true)
    );

    expect(contextComposer.composePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'music',
        prompt: expect.stringContaining('[Surface: music]'),
      })
    );
    expect(resolveCapabilityHosts).toHaveBeenCalledWith(['aionui-music']);
    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'music',
        prompt: expect.stringContaining('music_*'),
        mcpServers: [{ name: 'aionui-music', url: 'http://127.0.0.1/mcp' }],
      })
    );
  });

  it('uses a durable scoped permission grant without reopening the approval modal', async () => {
    const permissionStore = new PermissionStore(new MemoryPermissionRepository());
    await permissionStore.initialize();
    await permissionStore.createGrant({
      scope: {
        subjectId: 'tomny',
        sessionId: 'permission-session',
        surfaceId: 'chat',
        capabilityId: 'core',
        toolPattern: 'shell',
      },
      effect: 'allow',
      lifetime: 'session',
    });
    vi.mocked(adapter.run).mockImplementationOnce(async (input) => {
      const approved = await input.requestPermission({ tool: 'shell' });
      if (!approved) throw new Error('permission denied');
      input.emit({ type: 'delta', text: 'approved' });
    });
    const permissionRuntime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
      permissionStore,
    });
    await permissionRuntime.listTargets();
    permissionRuntime.start(
      'permission-request',
      'codex',
      'run tool',
      'C:/workspace',
      undefined,
      'workspace-write',
      'permission-session'
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'permission-request' && event.type === 'completed')).toBe(true)
    );

    expect(events.some((event) => event.requestId === 'permission-request' && event.type === 'permission')).toBe(false);
    expect(await permissionStore.queryAudit({ actions: ['request.evaluated'] })).toEqual([
      expect.objectContaining({ allowed: true, reason: 'explicit-allow', tool: 'shell' }),
    ]);
  });
  it('releases every resource lease during a deterministic cancellation soak', async () => {
    await runtime.listTargets();

    // oxlint-disable no-await-in-loop -- Ordered rounds prove each cancelled run releases its lease before reuse.

    for (let round = 0; round < 20; round += 1) {
      vi.mocked(adapter.run).mockImplementationOnce(
        (input) =>
          new Promise<void>((_resolve, reject) => {
            input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          })
      );
      const requestId = 'cancel-soak-' + round;
      runtime.start(
        requestId,
        'codex',
        'long task',
        'C:/workspace',
        undefined,
        'workspace-write',
        'cancel-session-' + round
      );
      await vi.waitFor(() => expect(adapter.run).toHaveBeenCalledTimes(round + 1));
      await expect(runtime.cancel(requestId)).resolves.toBe(true);
      await vi.waitFor(() =>
        expect(events.some((event) => event.requestId === requestId && event.type === 'cancelled')).toBe(true)
      );
      expect(coordinator.releaseLease).toHaveBeenCalledTimes(round + 1);
    }
    // oxlint-enable no-await-in-loop
  });

  it('always releases its resource lease when an adapter fails', async () => {
    vi.mocked(adapter.run).mockRejectedValueOnce(new Error('provider failed'));
    await runtime.listTargets();
    runtime.start('failed-request', 'codex', 'hello', 'C:/workspace');
    await vi.waitFor(() => expect(events.some((event) => event.type === 'error')).toBe(true));

    expect(coordinator.requestLease).toHaveBeenCalledWith({ kind: 'agent', estCostMB: 96 });
    expect(coordinator.releaseLease).toHaveBeenCalledWith('agent-lease');
  });
});
