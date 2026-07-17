/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpCoreAdapter } from '@process/experimentalCore/adapters/acpCoreAdapter';
import { evaluateAcpCompatibility } from '@process/experimentalCore/adapters/acpCompatibility';
import type { CoreAdapterEvent, CoreRunInput, DetectedCoreTarget } from '@process/experimentalCore/adapters';
import { CORE_ADAPTER_DEFINITIONS } from '@process/experimentalCore/coreRegistry';

const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/fake-acp-cli/index.js');
const acpDefinitions = CORE_ADAPTER_DEFINITIONS.filter((definition) => definition.protocol === 'acp');
const activeAdapters = new Set<AcpCoreAdapter>();

const fixtureTarget = (definition: (typeof acpDefinitions)[number], scenario = 'happy'): DetectedCoreTarget => ({
  ...definition,
  command: process.execPath,
  args: [fixturePath, scenario],
  detected: true,
  available: true,
});

const runInput = (
  target: DetectedCoreTarget,
  events: CoreAdapterEvent[],
  controller = new AbortController()
): CoreRunInput => ({
  sessionId: `acceptance-${target.id}`,
  target,
  prompt: 'hello fixture',
  workspace: process.cwd(),
  permissionMode: 'workspace-write',
  signal: controller.signal,
  emit: (event) => events.push(event),
  requestPermission: vi.fn(async () => true),
});

const createAdapter = (): AcpCoreAdapter => {
  const adapter = new AcpCoreAdapter();
  activeAdapters.add(adapter);
  return adapter;
};

afterEach(async () => {
  await Promise.all([...activeAdapters].map((adapter) => adapter.dispose()));
  activeAdapters.clear();
});

describe('declared ACP target acceptance', () => {
  it.each(acpDefinitions)(
    '$id completes handshake, model discovery and streamed text using the generic contract',
    async (definition) => {
      const adapter = createAdapter();
      const target = fixtureTarget(definition);
      const events: CoreAdapterEvent[] = [];

      await expect(adapter.listModels(target, process.cwd())).resolves.toEqual([
        { key: 'fake-model-1', modelId: 'fake-model-1', label: 'Fake Model', isDefault: true },
      ]);
      await expect(adapter.run(runInput(target, events))).resolves.toBeUndefined();
      expect(
        events
          .filter((event) => event.type === 'delta')
          .map((event) => event.text)
          .join('')
      ).toBe('Fake response to: hello fixture');
    }
  );

  it('preserves a tool lifecycle without reporting an in-progress update as a result', async () => {
    const adapter = createAdapter();
    const target = fixtureTarget(acpDefinitions[0], 'tool');
    const events: CoreAdapterEvent[] = [];

    await adapter.run(runInput(target, events));

    expect(events.filter((event) => event.type === 'tool-call')).toEqual([
      {
        type: 'tool-call',
        tool: 'Read fixture file',
        callId: 'fixture-tool-1',
        text: 'Read fixture file',
        phase: 'requested',
      },
      {
        type: 'tool-call',
        tool: 'Read fixture file',
        callId: 'fixture-tool-1',
        text: 'Read fixture file',
        phase: 'running',
      },
    ]);
    expect(events.filter((event) => event.type === 'tool-result')).toEqual([
      {
        type: 'tool-result',
        tool: 'Read fixture file',
        callId: 'fixture-tool-1',
        text: 'Read fixture file',
        outcome: 'success',
      },
    ]);
  });

  it('cancels a pending ACP prompt when the caller aborts', async () => {
    const adapter = createAdapter();
    const target = fixtureTarget(acpDefinitions[0], 'cancel');
    const controller = new AbortController();
    const pending = adapter.run(runInput(target, [], controller));

    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toThrow(/cancel/i);
  });

  it('retries a transient prompt failure while keeping one logical turn', async () => {
    const adapter = createAdapter();
    const target = fixtureTarget(acpDefinitions[0], 'retry');
    const events: CoreAdapterEvent[] = [];

    await expect(adapter.run(runInput(target, events))).resolves.toBeUndefined();

    expect(events).toContainEqual({ type: 'delta', text: '', mode: 'replace' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'status', text: expect.stringContaining('Retry') }));
    expect(
      events
        .filter((event) => event.type === 'delta')
        .map((event) => event.text)
        .join('')
    ).toContain('Fake response to: hello fixture');
  });

  it('accepts a capability-degraded ACP agent while exposing no guessed model', async () => {
    const adapter = createAdapter();
    const target = fixtureTarget(acpDefinitions[0], 'degraded');
    const events: CoreAdapterEvent[] = [];

    await expect(adapter.listModels(target, process.cwd())).resolves.toEqual([]);
    await expect(adapter.run(runInput(target, events))).resolves.toBeUndefined();
    expect(
      evaluateAcpCompatibility(
        { protocolVersion: 1, agentCapabilities: {} },
        { required: ['text'], preferred: ['image', 'model-selection'] },
        [1]
      ).status
    ).toBe('degraded');
  });

  it('rejects an incompatible handshake before creating a session', async () => {
    const adapter = createAdapter();
    const target = fixtureTarget(acpDefinitions[0], 'incompatible');

    await expect(adapter.run(runInput(target, []))).rejects.toThrow(/protocol version/i);
  });
});
