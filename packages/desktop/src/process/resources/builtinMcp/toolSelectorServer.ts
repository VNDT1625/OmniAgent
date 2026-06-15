/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in Tool-Selector MCP server (Yêu cầu 7, criteria 7.2 & 7.7 — Agent
 * plane). Exposes two tools so ANY agent (including the company's "tay chân"
 * worker agents, Yêu cầu 3) can discover the right capability for a request
 * without loading the whole catalog into its context:
 *
 * - `tools_search(query)` — return the filtered top-k relevant skills/tools with
 *   the reason each matched (criterion 7.2: lọc trước khi nạp).
 * - `tools_recall(query)` — look up the previously-successful selection for a
 *   similar request (criterion 7.7).
 *
 * Tool names use snake_case (not the design's dotted `tools.search`) to satisfy
 * function-calling name rules, matching the other built-in servers.
 *
 * Built as a factory returning a configured {@link McpServer}; Task 15.1 injects
 * the real {@link IToolSelector}/{@link ISelectionLog} and connects a transport.
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IToolSelector } from '@process/toolselect/toolSelector';
import type { ISelectionLog } from '@process/toolselect/selectionLog';

/** Stable id of the built-in Tool-Selector MCP server (consumed by Task 15.1). */
export const BUILTIN_TOOL_SELECTOR_ID = 'builtin-tool-selector';

/** Canonical name of the built-in Tool-Selector MCP server (consumed by Task 15.1). */
export const BUILTIN_TOOL_SELECTOR_NAME = 'aionui-tool-selector';

/** Injected collaborators for {@link createToolSelectorServer}. */
export type ToolSelectorServerDeps = {
  /** The selector that filters the catalog (Tier 1 + optional Tier 2). */
  toolSelector: IToolSelector;
  /** The selection log used by `tools_recall`. */
  selectionLog: ISelectionLog;
};

/** Standard MCP text payload helper. */
const textResult = (
  text: string,
  isError = false
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Create the Tool-Selector {@link McpServer} bound to the injected selector + log.
 *
 * @param deps The tool selector and selection log. See {@link ToolSelectorServerDeps}.
 * @returns A configured MCP server; the caller (Task 15.1) connects a transport.
 */
export const createToolSelectorServer = (deps: ToolSelectorServerDeps): McpServer => {
  const server = new McpServer({ name: BUILTIN_TOOL_SELECTOR_NAME, version: '1.0.0' });

  server.tool(
    'tools_search',
    `Find the skills/tools most relevant to a request, WITHOUT loading the whole catalog
(filter-before-load). Returns a small ranked shortlist with the reason each item matched.

Input:
- query: the request / task description to find tools for (required)

Returns a JSON array of { id, name, source, score, reason }.`,
    {
      query: z.string().describe('The request or task description to find relevant tools/skills for.'),
    },
    async ({ query }) => {
      try {
        const shortlist = await deps.toolSelector.shortlist(query);
        const payload = shortlist.map((s) => ({
          id: s.entry.id,
          name: s.entry.name,
          source: s.entry.source,
          score: Number(s.score.toFixed(4)),
          reason: s.reason,
        }));
        return textResult(JSON.stringify(payload, null, 2));
      } catch (error) {
        return textResult(`Error searching tools: ${describeError(error)}`, true);
      }
    }
  );

  server.tool(
    'tools_recall',
    `Recall the tools/skills that previously SUCCEEDED for a similar request, so a known-good
choice can be reused instead of re-discovered.

Input:
- query: the request / task description to recall a prior selection for (required)

Returns the prior selection (chosen tool ids + when), or a note that none was found.`,
    {
      query: z.string().describe('The request or task description to recall a prior successful selection for.'),
    },
    async ({ query }) => {
      try {
        const recalled = await deps.selectionLog.recall(query);
        if (!recalled) return textResult('No prior successful selection found for a similar request.');
        return textResult(
          JSON.stringify(
            {
              chosen: recalled.chosen,
              succeeded: recalled.succeeded,
              at: recalled.at,
              requestSnippet: recalled.requestSnippet,
            },
            null,
            2
          )
        );
      } catch (error) {
        return textResult(`Error recalling tools: ${describeError(error)}`, true);
      }
    }
  );

  return server;
};
