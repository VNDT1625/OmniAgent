/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Realtime Knowledge MCP server — drives the tools through an
 * in-memory MCP client over the SDK's linked transport, against a fake service.
 */

import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createRealtimeKnowledgeServer,
  type RealtimeKnowledgeServerDeps,
} from '@/process/resources/builtinMcp/realtimeKnowledgeServer';
import type { KnowledgeFact } from '@/process/knowledge/realtime/rtkTypes';

const fakeFact = (over: Partial<KnowledgeFact> = {}): KnowledgeFact => ({
  id: 'f1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  topic: 'nodejs.lts.version',
  question: 'latest node lts?',
  aliases: [],
  value: '22.x',
  volatilityClass: 'version',
  ttlMs: 1000,
  validAsOf: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-02T00:00:00.000Z',
  sources: [],
  confidence: 0.6,
  freshness: 'fresh',
  history: [],
  tags: [],
  embeddingText: '',
  status: 'active',
  ...over,
});

const makeDeps = (overrides: Partial<RealtimeKnowledgeServerDeps['service']> = {}): RealtimeKnowledgeServerDeps => ({
  service: {
    lookup: vi.fn().mockResolvedValue({ facts: [{ fact: fakeFact(), score: 0.9, freshness: 'fresh', whyRelevant: [] }] }),
    record: vi.fn().mockResolvedValue(fakeFact()),
    refresh: vi.fn().mockResolvedValue(fakeFact()),
    ...overrides,
  },
});

const connect = async (deps: RealtimeKnowledgeServerDeps) => {
  const server = createRealtimeKnowledgeServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
};

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
};

describe('realtimeKnowledgeServer', () => {
  it('exposes the rtk_* tool set', async () => {
    const client = await connect(makeDeps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual(['rtk_lookup', 'rtk_record', 'rtk_refresh']);
  });

  it('rtk_lookup forwards the query and returns the grounding pack', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const result = await client.callTool({ name: 'rtk_lookup', arguments: { query: 'node lts', topK: 3 } });
    expect(deps.service.lookup).toHaveBeenCalledWith('node lts', { topK: 3 });
    expect(textOf(result)).toContain('nodejs.lts.version');
  });

  it('rtk_record passes a fact draft with stamped sources', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    await client.callTool({
      name: 'rtk_record',
      arguments: {
        topic: 'nodejs.lts.version',
        question: 'latest node lts?',
        value: '22.x',
        volatilityClass: 'version',
        sources: [{ url: 'https://nodejs.org' }],
      },
    });
    expect(deps.service.record).toHaveBeenCalledTimes(1);
    const draft = (deps.service.record as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(draft.topic).toBe('nodejs.lts.version');
    expect(draft.sources[0].url).toBe('https://nodejs.org');
    expect(typeof draft.sources[0].fetchedAt).toBe('string');
  });

  it('rtk_refresh surfaces the service error as an error result', async () => {
    const deps = makeDeps({ refresh: vi.fn().mockRejectedValue(new Error('no research pipeline configured')) });
    const client = await connect(deps);
    const result = await client.callTool({ name: 'rtk_refresh', arguments: { topicOrId: 'nodejs.lts.version' } });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toMatch(/no research pipeline/i);
  });
});
