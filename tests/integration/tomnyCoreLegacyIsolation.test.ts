/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withPersistentAgentRetry } from '@process/agentRuntime/retryPolicy';
import { createBuiltinSurfaceManifests, createSurfaceRegistry } from '@process/agentRuntime/surfaceRegistry';
import { MemoryDurableEventStore } from '@process/services/agentChat/durability';
import { withCliAgent } from '@process/services/agentChat/cliAgentChat';
import type { CliAgentDriver } from '@process/services/agentChat/cliAgentDriver';
import type { CoreAdapter, CoreRunInput, DetectedCoreTarget } from '@process/experimentalCore/adapters/coreAdapter';
import { ExperimentalCoreRuntime, type ExperimentalCoreEvent } from '@process/experimentalCore/experimentalCoreRuntime';
import { MemoryCoreSessionStore } from '@process/experimentalCore/sessionCheckpointStore';

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

describe('Tomny Core standalone replacement acceptance', () => {
  let backendPortDescriptor: PropertyDescriptor | undefined;
  let legacyBackendAccesses = 0;

  beforeEach(() => {
    backendPortDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__backendPort');
    Object.defineProperty(globalThis, '__backendPort', {
      configurable: true,
      get: () => {
        legacyBackendAccesses += 1;
        throw new Error('Legacy AionCore backend is disabled for this acceptance test.');
      },
    });
  });

  afterEach(() => {
    if (backendPortDescriptor) Object.defineProperty(globalThis, '__backendPort', backendPortDescriptor);
    else delete (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
    vi.restoreAllMocks();
  });

  it('keeps chat routing off the provider and legacy backend for CLI models', async () => {
    const provider = vi.fn(async () => {
      throw new Error('Provider fallback must not handle a CLI model.');
    });
    const driver: CliAgentDriver = {
      run: vi.fn(async () => 'standalone answer'),
    };
    const chat = withCliAgent(provider, driver, {
      surface: 'ide',
      workspace: 'C:/workspace',
      permissionMode: 'workspace-write',
    });

    await expect(
      chat({
        model: 'cli:codex?model=gpt-5.6',
        messages: [{ role: 'user', content: 'Inspect the repository' }],
      })
    ).resolves.toBe('standalone answer');
    expect(driver.run).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex', modelId: 'gpt-5.6' }));
    expect(provider).not.toHaveBeenCalled();
    expect(legacyBackendAccesses).toBe(0);
  });

  it('runs harness, retry, durable replay and session continuation with AionCore disabled', async () => {
    const events: ExperimentalCoreEvent[] = [];
    const sessionStore = new MemoryCoreSessionStore();
    const eventStore = new MemoryDurableEventStore();
    const attempts: number[] = [];
    const adapter: CoreAdapter = {
      protocol: 'codex-app-server',
      listModels: vi.fn(async () => [
        { key: 'gpt-5.6::medium', modelId: 'gpt-5.6', label: 'GPT-5.6 (medium)', isDefault: true },
      ]),
      run: vi.fn(async (input: CoreRunInput) => {
        await withPersistentAgentRetry({
          signal: input.signal,
          retryDelayMs: 0,
          batchDelayMs: 0,
          operation: async (attempt) => {
            attempts.push(attempt);
            if (attempt === 1) throw Object.assign(new Error('provider overloaded'), { status: 429 });
            input.emit({ type: 'delta', text: `answer:${input.prompt}`, mode: 'replace' });
          },
          onStatus: (status) => input.emit({ type: 'status', text: status.message }),
          agentLabel: 'Codex',
        });
      }),
      dispose: vi.fn(async () => undefined),
    };
    const resolveCapabilityHosts = vi.fn(async (names: string[]) =>
      names.map((name) => ({ name, url: `http://127.0.0.1/${name}` }))
    );
    const createRuntime = (): ExperimentalCoreRuntime =>
      new ExperimentalCoreRuntime((event) => events.push(event), {
        detectTargets: vi.fn(async () => [target]),
        adapters: [adapter],
        sessionStore,
        eventStore,
        resolveCapabilityHosts,
        surfaceRegistry: createSurfaceRegistry({
          manifests: createBuiltinSurfaceManifests(),
          defaultSurfaceId: 'chat',
        }),
      });

    const runtime = createRuntime();
    await runtime.listTargets();
    const started = runtime.start(
      'standalone-first',
      'codex',
      'first request',
      'C:/workspace',
      'gpt-5.6::medium',
      'workspace-write',
      undefined,
      undefined,
      {
        surface: 'ide',
        agentId: 'tomny',
        personalId: 'default',
        permissionScopes: ['workspace.read', 'workspace.write'],
        capabilityGrants: ['surface.ide'],
        availableCapabilities: ['surface.ide'],
      }
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'standalone-first' && event.type === 'completed')).toBe(true)
    );

    expect(attempts).toEqual([1, 2]);
    expect(resolveCapabilityHosts).toHaveBeenCalledWith(['aionui-ide']);
    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'ide',
        mcpServers: [{ name: 'aionui-ide', url: 'http://127.0.0.1/aionui-ide' }],
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ requestId: 'standalone-first', type: 'status', text: expect.stringContaining('Retry') })
    );
    await expect(runtime.replayEvents({ sessionId: started.sessionId })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: 'standalone-first', type: 'started' }),
        expect.objectContaining({ requestId: 'standalone-first', type: 'completed' }),
      ])
    );

    const restartedRuntime = createRuntime();
    await restartedRuntime.listTargets();
    restartedRuntime.start(
      'standalone-second',
      'codex',
      'continue after restart',
      'C:/workspace',
      'gpt-5.6::medium',
      'workspace-write',
      started.sessionId,
      undefined,
      {
        surface: 'ide',
        agentId: 'tomny',
        personalId: 'default',
        permissionScopes: ['workspace.read', 'workspace.write'],
        capabilityGrants: ['surface.ide'],
        availableCapabilities: ['surface.ide'],
      }
    );
    await vi.waitFor(() =>
      expect(events.some((event) => event.requestId === 'standalone-second' && event.type === 'completed')).toBe(true)
    );

    const secondPrompt = vi.mocked(adapter.run).mock.calls.at(-1)?.[0].prompt ?? '';
    expect(secondPrompt).toContain('User: first request');
    expect(secondPrompt).toContain('Assistant: answer:');
    await expect(sessionStore.get(started.sessionId)).resolves.toEqual(
      expect.objectContaining({ status: 'completed', surface: 'ide' })
    );
    expect(legacyBackendAccesses).toBe(0);
  });
});
