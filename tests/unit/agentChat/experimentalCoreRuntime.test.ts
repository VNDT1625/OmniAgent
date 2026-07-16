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
import type {
  CoreAdapter,
  CoreRunInput,
  DetectedCoreTarget,
} from '../../../packages/desktop/src/process/experimentalCore/coreAdapter';
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

  beforeEach(() => {
    adapter = makeAdapter();
    events = [];
    coordinator = {
      requestLease: vi.fn().mockResolvedValue({ id: 'agent-lease' }),
      releaseLease: vi.fn(),
    };
    runtime = new ExperimentalCoreRuntime((event) => events.push(event), {
      detectTargets: vi.fn().mockResolvedValue([target]),
      adapters: [adapter],
      coordinator,
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
    expect(runtime.resolvePermission(permission?.permissionId ?? '', true)).toBe(true);
    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'status' && event.text === 'approved')).toBe(true)
    );
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
      });

      const recovered = new JsonCoreSessionStore(filePath);
      await recovered.initialize();

      await expect(recovered.get('disk-session')).resolves.toMatchObject({
        status: 'interrupted',
        messages: [{ text: 'api_key[REDACTED]' }],
      });
      expect(await readFile(filePath, 'utf8')).not.toContain('top-secret');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
