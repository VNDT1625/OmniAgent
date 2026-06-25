/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in Testing MCP server (Yêu cầu 2b, criterion 2.1 — Agent plane). Lets an
 * agent run a multi-platform test session, fetch a session's report, and list
 * sessions, all through the same {@link ITestOrchestrator} the UI uses (single
 * source of truth). Tool names use snake_case to satisfy function-calling rules,
 * matching the other built-in servers.
 *
 * Tools: `test_run`, `test_report`, `test_list`.
 *
 * Built as a factory returning a configured {@link McpServer}; Task 15.1 injects
 * the real orchestrator and connects a transport. Main-process module — no DOM.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ITestOrchestrator } from '@process/testing/testOrchestrator';
import type { TestPlatform, TestScenario, TestStep } from '@process/testing/testingTypes';

/** Stable id of the built-in Testing MCP server (consumed by Task 15.1). */
export const BUILTIN_TESTING_ID = 'builtin-testing';

/** Canonical name of the built-in Testing MCP server (consumed by Task 15.1). */
export const BUILTIN_TESTING_NAME = 'aionui-testing';

/** Injected collaborators for {@link createTestingServer}. */
export type TestingServerDeps = {
  /** The orchestrator that runs sessions + holds their reports. */
  orchestrator: ITestOrchestrator;
};

const textResult = (
  text: string,
  isError = false
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Zod schema for a single scenario step. */
const stepSchema = z.object({ id: z.string(), description: z.string() });

/**
 * Create the Testing {@link McpServer} bound to the injected orchestrator.
 *
 * @param deps The test orchestrator. See {@link TestingServerDeps}.
 * @returns A configured MCP server; the caller (Task 15.1) connects a transport.
 */
export const createTestingServer = (deps: TestingServerDeps): McpServer => {
  const server = new McpServer({ name: BUILTIN_TESTING_NAME, version: '1.0.0' });

  server.tool(
    'test_run',
    `Run a test scenario on a platform (web | android | windows). The run executes in an isolated
virtual display (never the user's real desktop), records video + screenshots, and produces a
markdown report. Concurrency is governed by the resource coordinator.

Input:
- name: scenario name (required)
- platform: 'web' | 'android' | 'windows' (required)
- steps: ordered steps [{ id, description }] (required)
- visible: show the run (true) or run hidden (false, default)

Returns the session id and final status.`,
    {
      name: z.string().describe('Human-readable scenario name.'),
      platform: z.enum(['web', 'android', 'windows']).describe('Target platform.'),
      steps: z.array(stepSchema).describe('Ordered steps to perform.'),
      visible: z.boolean().optional().describe('Show the run instead of running hidden.'),
      viewport: z
        .object({ width: z.number(), height: z.number(), label: z.string().optional() })
        .optional()
        .describe('Optional screen size for responsive checks.'),
    },
    async ({ name, platform, steps, visible, viewport }) => {
      try {
        const typedSteps: TestStep[] = steps.map((s) => ({ id: s.id, description: s.description }));
        const typedViewport = viewport
          ? { width: viewport.width, height: viewport.height, label: viewport.label }
          : undefined;
        const scenario: TestScenario = {
          id: `scn-${Date.now()}`,
          name,
          platform: platform as TestPlatform,
          steps: typedSteps,
          viewport: typedViewport,
        };
        const session = await deps.orchestrator.run(scenario, { visibility: visible ? 'visible' : 'hidden' });
        return textResult(
          JSON.stringify(
            {
              sessionId: session.id,
              status: session.status,
              reportPath: session.reportPath,
              videoPath: session.videoPath,
            },
            null,
            2
          )
        );
      } catch (error) {
        return textResult(`Error running test: ${describeError(error)}`, true);
      }
    }
  );

  server.tool(
    'test_report',
    `Fetch the result of a previously-run test session: status, per-step pass/fail, report and video paths.

Input:
- sessionId: the id returned by test_run (required)`,
    {
      sessionId: z.string().describe('The session id returned by test_run.'),
    },
    async ({ sessionId }) => {
      try {
        const session = deps.orchestrator.getSession(sessionId);
        if (!session) return textResult(`No test session with id: ${sessionId}`, true);
        const summary = {
          sessionId: session.id,
          status: session.status,
          steps: session.results.map((r) => ({ description: r.step.description, passed: r.passed, detail: r.detail })),
          reportPath: session.reportPath,
          videoPath: session.videoPath,
        };
        return textResult(JSON.stringify(summary, null, 2));
      } catch (error) {
        return textResult(`Error fetching report: ${describeError(error)}`, true);
      }
    }
  );

  server.tool('test_list', `List all test sessions run so far, newest first, with their status.`, {}, async () => {
    try {
      const sessions = deps.orchestrator
        .listSessions()
        .map((s) => ({ sessionId: s.id, name: s.scenario.name, platform: s.scenario.platform, status: s.status }));
      return textResult(JSON.stringify(sessions.reverse(), null, 2));
    } catch (error) {
      return textResult(`Error listing sessions: ${describeError(error)}`, true);
    }
  });

  return server;
};
