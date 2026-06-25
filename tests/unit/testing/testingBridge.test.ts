/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests the Testing bridge (Yêu cầu 2b, Task 15.1 — UI plane) + the in-process
 * MCP host (Agent plane). Both planes drive the SAME orchestrator, so this
 * verifies:
 *  - registerTestingBridge wires list/getReport/run onto the typed channels;
 *  - the handlers project orchestrator sessions onto the renderer-facing shapes
 *    (newest-first list, structured+markdown report, run → finished summary);
 *  - the loopback MCP host starts, binds a 127.0.0.1 port, and stops cleanly.
 *
 * No real Electron window / display is used — the orchestrator is a hand-rolled
 * fake implementing ITestOrchestrator.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Capture each channel's registered handler so the test can invoke it directly.
const handlers = new Map<string, (req: unknown) => unknown>();
vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: vi.fn((channel: string) => ({
      provider: vi.fn((handler: (req: unknown) => unknown) => {
        handlers.set(channel, handler);
        return vi.fn();
      }),
      invoke: vi.fn(),
    })),
    buildEmitter: vi.fn(() => ({ emit: vi.fn(), on: vi.fn() })),
  },
}));

import { registerTestingBridge, TESTING_CHANNELS } from '@/process/testing/testingBridge';
import { startTestingMcpHost, stopTestingMcpHost } from '@/process/testing/testingMcpHost';
import type { ITestOrchestrator } from '@/process/testing/testOrchestrator';
import type { RunOptions } from '@/process/testing/testOrchestrator';
import type { TestScenario, TestSession } from '@/process/testing/testingTypes';

const makeSession = (id: string, name: string, status: TestSession['status'], passedSteps = 1): TestSession => ({
  id,
  scenario: {
    id: `scn-${id}`,
    name,
    platform: 'web',
    steps: [{ id: 's1', description: 'goto example.com' }],
  },
  visibility: 'hidden',
  status,
  results: [
    {
      step: { id: 's1', description: 'goto example.com' },
      passed: passedSteps > 0,
      detail: 'Navigated',
      screenshots: ['/shot/s1.png'],
      at: 1,
    },
  ],
  reportPath: `/reports/${id}/report.md`,
  videoPath: `/reports/${id}/recording.webm`,
  createdAt: 1,
  updatedAt: 2,
});

/** A fake orchestrator that records runs and returns canned sessions. */
const makeFakeOrchestrator = (initial: TestSession[] = []) => {
  const sessions = new Map<string, TestSession>(initial.map((s) => [s.id, s]));
  const runCalls: Array<{ scenario: TestScenario; options?: RunOptions }> = [];
  const orchestrator: ITestOrchestrator = {
    run: async (scenario, options) => {
      runCalls.push({ scenario, options });
      const session = makeSession(`run-${sessions.size + 1}`, scenario.name, 'passed');
      session.scenario = scenario;
      sessions.set(session.id, session);
      return session;
    },
    getSession: (id) => sessions.get(id),
    listSessions: () => [...sessions.values()],
  };
  return { orchestrator, runCalls };
};

afterEach(async () => {
  handlers.clear();
  await stopTestingMcpHost();
  vi.clearAllMocks();
});

describe('registerTestingBridge — UI plane', () => {
  it('lists sessions newest-first as summaries', async () => {
    const { orchestrator } = makeFakeOrchestrator([
      makeSession('a', 'first', 'passed'),
      makeSession('b', 'second', 'failed'),
    ]);
    registerTestingBridge({ orchestrator });

    const list = (await handlers.get(TESTING_CHANNELS.listSessions)?.(undefined)) as Array<{
      sessionId: string;
      status: string;
    }>;
    expect(list.map((s) => s.sessionId)).toEqual(['b', 'a']); // reversed (newest first)
    expect(list[0]).toMatchObject({ sessionId: 'b', name: 'second', platform: 'web', status: 'failed' });
  });

  it('builds a structured + markdown report for a known session', async () => {
    const { orchestrator } = makeFakeOrchestrator([makeSession('a', 'first', 'passed')]);
    registerTestingBridge({ orchestrator });

    const report = (await handlers.get(TESTING_CHANNELS.getReport)?.({ sessionId: 'a' })) as {
      sessionId: string;
      passed: boolean;
      total: number;
      markdown: string;
    };
    expect(report.sessionId).toBe('a');
    expect(report.passed).toBe(true);
    expect(report.total).toBe(1);
    expect(report.markdown).toContain('# Test Report: first');
  });

  it('returns undefined report for an unknown session', async () => {
    const { orchestrator } = makeFakeOrchestrator();
    registerTestingBridge({ orchestrator });
    const report = await handlers.get(TESTING_CHANNELS.getReport)?.({ sessionId: 'missing' });
    expect(report).toBeUndefined();
  });

  it('runs a submitted scenario and returns the finished summary', async () => {
    const { orchestrator, runCalls } = makeFakeOrchestrator();
    registerTestingBridge({ orchestrator });

    const result = (await handlers.get(TESTING_CHANNELS.run)?.({
      name: 'my web test',
      platform: 'web',
      steps: [{ id: 's1', description: 'goto example.com' }],
      visible: true,
    })) as { sessionId: string; status: string; name: string; reportPath?: string };

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0].scenario.name).toBe('my web test');
    expect(runCalls[0].scenario.platform).toBe('web');
    expect(runCalls[0].options?.visibility).toBe('visible');
    expect(result.status).toBe('passed');
    expect(result.reportPath).toContain('report.md');
  });
});

describe('startTestingMcpHost — Agent plane', () => {
  it('starts a loopback host with a 127.0.0.1 SSE url and stops cleanly', async () => {
    const { orchestrator } = makeFakeOrchestrator();
    const host = await startTestingMcpHost(orchestrator);
    expect(host.port).toBeGreaterThan(0);
    expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sse$/);

    // Calling again returns the same singleton host (same port).
    const again = await startTestingMcpHost(orchestrator);
    expect(again.port).toBe(host.port);

    await stopTestingMcpHost();
  });
});
