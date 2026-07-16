/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for Realtime Knowledge (RTK) — lets an agent look up and
 * keep time-sensitive facts current.
 *
 * Unlike the stdio company server, RTK needs the LIVE Main-process service
 * singleton (store + vector index), so it is hosted in-process over SSE (see
 * `process/knowledge/realtimeKnowledgeMcpHost.ts`), mirroring the Office-editor
 * MCP. A fresh server instance is created per SSE connection, all bound to the
 * same injected service.
 *
 * Tools:
 *  - `rtk_lookup`  — semantic retrieval of facts, each annotated with freshness
 *    and sources, so the agent can ground answers and spot stale data.
 *  - `rtk_record`  — create/update a fact from evidence the AGENT gathered (with
 *    its own web/browser tools). Updates pass through the verification guardrail.
 *  - `rtk_refresh` — ask the service to re-verify a fact via the configured
 *    research pipeline (degrades clearly when no researcher is wired).
 *
 * The agent is the crawler: it provides `sources`; RTK enforces the guardrail
 * (enough independent sources before a value changes) and tracks history.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IRtkService } from '@process/knowledge/realtime/rtkService';
import type { FactSource, VolatilityClass } from '@process/knowledge/realtime/rtkTypes';

/** Stable identifier of the built-in Realtime Knowledge MCP server. */
export const BUILTIN_REALTIME_KNOWLEDGE_ID = 'builtin-realtime-knowledge';

/** Canonical name of the built-in Realtime Knowledge MCP server. */
export const BUILTIN_REALTIME_KNOWLEDGE_NAME = 'aionui-realtime-knowledge';

/** Dependencies for {@link createRealtimeKnowledgeServer}. */
export type RealtimeKnowledgeServerDeps = {
  /** The live RTK service (lookup/record/refresh). */
  service: Pick<IRtkService, 'lookup' | 'record' | 'refresh'>;
};

/** Standard MCP text payload, optionally flagged as an error. */
const textResult = (
  text: string,
  isError = false
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

/** Stringify any caught error for an MCP text payload. */
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const VOLATILITY_CLASSES: [VolatilityClass, ...VolatilityClass[]] = [
  'version',
  'price',
  'role_holder',
  'spec_api',
  'status_event',
  'stat_metric',
  'other',
];

const sourceSchema = z.object({
  url: z.string().describe('Canonical URL of the source.'),
  title: z.string().optional().describe('Optional human-readable title.'),
  snippet: z.string().optional().describe('Optional short quoted snippet supporting the value.'),
});

/**
 * Build a Realtime Knowledge MCP server bound to a live service.
 *
 * @param deps The RTK service to drive.
 */
export const createRealtimeKnowledgeServer = (deps: RealtimeKnowledgeServerDeps): McpServer => {
  const server = new McpServer({ name: BUILTIN_REALTIME_KNOWLEDGE_NAME, version: '1.0.0' });

  // --- rtk_lookup ----------------------------------------------------------
  server.tool(
    'rtk_lookup',
    `Look up time-sensitive facts (versions, prices, current role holders, evolving specs, stats)
from the Realtime Knowledge base BEFORE answering, so you don't rely on stale training data.

Each result includes the value, when it was valid (validAsOf), its freshness (fresh/stale/expired)
and its sources. If a result is "expired" or "stale", verify it with your web/browser tools and then
call rtk_record to update it.

Input:
- query: the natural-language question (required)
- topK: max facts to return (optional; default 5)

Returns a JSON grounding pack: { facts: [{ fact, score, freshness, whyRelevant }], notice? }.`,
    {
      query: z.string().describe('Natural-language question to retrieve facts for.'),
      topK: z.number().int().positive().max(20).optional().describe('Max facts to return (default 5).'),
    },
    async ({ query, topK }) => {
      try {
        const pack = await deps.service.lookup(query, topK ? { topK } : undefined);
        return textResult(JSON.stringify(pack, null, 2));
      } catch (error) {
        return textResult(`Error looking up realtime knowledge: ${describeError(error)}`, true);
      }
    }
  );

  // --- rtk_record ----------------------------------------------------------
  server.tool(
    'rtk_record',
    `Record or update a time-sensitive fact from evidence YOU gathered (with your web/browser tools).

Use this after verifying something that can change over time. When updating an existing fact (same
topic), the change must be backed by enough INDEPENDENT sources — RTK enforces this guardrail and
keeps the previous value in history. A model guess without sources will be rejected.

Input:
- topic: stable normalised key, e.g. "nodejs.lts.version" (required)
- question: the canonical natural-language question this answers (required)
- value: the current value (required)
- volatilityClass: one of version|price|role_holder|spec_api|status_event|stat_metric|other (required)
- sources: array of { url, title?, snippet? } backing the value (strongly recommended)
- aliases: alternative phrasings of the question (optional)
- tags: keywords (optional)
- validAsOf: ISO timestamp the value is valid as of (optional; defaults to now)
- confidence: 0..1 (optional)

Returns the stored fact as JSON (including its applied status: active / needs_review).`,
    {
      topic: z.string().describe('Stable normalised key, e.g. "nodejs.lts.version".'),
      question: z.string().describe('Canonical natural-language question this fact answers.'),
      value: z.string().describe('The current value.'),
      volatilityClass: z.enum(VOLATILITY_CLASSES).describe('How quickly this kind of fact changes.'),
      sources: z.array(sourceSchema).optional().describe('Sources backing the value.'),
      aliases: z.array(z.string()).optional().describe('Alternative phrasings of the question.'),
      tags: z.array(z.string()).optional().describe('Keyword tags.'),
      validAsOf: z.string().optional().describe('ISO timestamp the value is valid as of.'),
      confidence: z.number().min(0).max(1).optional().describe('Confidence 0..1.'),
    },
    async ({ topic, question, value, volatilityClass, sources, aliases, tags, validAsOf, confidence }) => {
      try {
        const factSources: FactSource[] = (sources ?? []).map((s) => ({
          url: s.url,
          ...(s.title ? { title: s.title } : {}),
          fetchedAt: new Date().toISOString(),
          ...(s.snippet ? { snippet: s.snippet } : {}),
        }));
        const fact = await deps.service.record({
          topic,
          question,
          value,
          volatilityClass,
          sources: factSources,
          aliases,
          tags,
          validAsOf,
          confidence,
        });
        return textResult(JSON.stringify(fact, null, 2));
      } catch (error) {
        return textResult(`Error recording realtime knowledge: ${describeError(error)}`, true);
      }
    }
  );

  // --- rtk_refresh ---------------------------------------------------------
  server.tool(
    'rtk_refresh',
    `Ask RTK to re-verify a fact using the configured research pipeline.

Input:
- topicOrId: the fact's topic key or id (required)

Returns the (possibly updated) fact as JSON. If no research pipeline is configured, returns a clear
error — in that case, verify with your own tools and use rtk_record instead.`,
    {
      topicOrId: z.string().describe('The fact topic key or id to refresh.'),
    },
    async ({ topicOrId }) => {
      try {
        const fact = await deps.service.refresh(topicOrId);
        return textResult(JSON.stringify(fact, null, 2));
      } catch (error) {
        return textResult(`Error refreshing realtime knowledge: ${describeError(error)}`, true);
      }
    }
  );

  return server;
};
