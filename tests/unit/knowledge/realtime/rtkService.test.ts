/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aionui-rtk-svc' } }));

import { createRtkStore, type RtkStoreFs } from '@/process/knowledge/realtime/rtkStore';
import { createRtkVectorIndex, type Embedder } from '@/process/knowledge/realtime/rtkVectorIndex';
import { createVerificationService } from '@/process/knowledge/realtime/verificationService';
import { createRtkService } from '@/process/knowledge/realtime/rtkService';
import type { IRefreshPipeline } from '@/process/knowledge/realtime/refreshPipeline';
import type { FactSource } from '@/process/knowledge/realtime/rtkTypes';

const createMemoryFs = (): RtkStoreFs => {
  const files = new Map<string, string>();
  return {
    readFile: (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      return Promise.resolve(value);
    },
    writeFile: (filePath, data) => {
      files.set(filePath, data);
      return Promise.resolve();
    },
    rename: (oldPath, newPath) => {
      const v = files.get(oldPath);
      if (v !== undefined) {
        files.set(newPath, v);
        files.delete(oldPath);
      }
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(undefined),
  };
};

/** Constant embedder — retrieval plumbing only (ranking is covered elsewhere). */
const constEmbedder: Embedder = {
  providerId: 't',
  model: 'const',
  embed: (texts) => Promise.resolve(texts.map(() => [1])),
};

const src = (url: string): FactSource => ({ url, fetchedAt: '2026-01-01T00:00:00.000Z' });

const NOW = Date.parse('2026-01-01T00:00:00.000Z');

const build = (pipeline?: IRefreshPipeline) =>
  createRtkService({
    store: createRtkStore({ rootDir: '/d', fs: createMemoryFs() }),
    index: createRtkVectorIndex(constEmbedder),
    verifier: createVerificationService(),
    pipeline,
    now: () => NOW,
    newId: (() => {
      let n = 0;
      return () => `id-${(n += 1)}`;
    })(),
  });

describe('rtkService.record + lookup', () => {
  let service: ReturnType<typeof build>;
  beforeEach(() => {
    service = build();
  });

  it('records a new fact and retrieves it via lookup', async () => {
    await service.record({
      topic: 'nodejs.lts.version',
      question: 'latest node lts?',
      value: '20.x',
      volatilityClass: 'version',
    });
    const pack = await service.lookup('node lts');
    expect(pack.facts).toHaveLength(1);
    expect(pack.facts[0].fact.value).toBe('20.x');
    expect(pack.facts[0].freshness).toBe('fresh');
  });

  it('updates an existing topic with two sources (accept) and keeps history', async () => {
    await service.record({ topic: 't', question: 'q', value: '20.x', volatilityClass: 'version' });
    const updated = await service.record({
      topic: 't',
      question: 'q',
      value: '22.x',
      volatilityClass: 'version',
      sources: [src('https://a.com'), src('https://b.com')],
    });
    expect(updated.value).toBe('22.x');
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0].value).toBe('20.x');
    expect(updated.status).toBe('active');
  });

  it('keeps the old value when a change is unverified (no sources → reject)', async () => {
    await service.record({ topic: 't', question: 'q', value: '20.x', volatilityClass: 'version' });
    const updated = await service.record({ topic: 't', question: 'q', value: '99.x', volatilityClass: 'version' });
    expect(updated.value).toBe('20.x'); // rejected — value unchanged
  });

  it('flags needs_review for a single-source change', async () => {
    await service.record({ topic: 't', question: 'q', value: '20.x', volatilityClass: 'version' });
    const updated = await service.record({
      topic: 't',
      question: 'q',
      value: '22.x',
      volatilityClass: 'version',
      sources: [src('https://a.com')],
    });
    expect(updated.status).toBe('needs_review');
    expect(updated.value).toBe('20.x'); // value not changed on review
  });

  it('adds a notice when a looked-up fact is expired', async () => {
    await service.record({
      topic: 't',
      question: 'q',
      value: 'v',
      volatilityClass: 'status_event',
      ttlMs: 1, // expires almost immediately relative to NOW
      validAsOf: new Date(NOW - 1000).toISOString(),
    });
    const pack = await service.lookup('q');
    expect(pack.facts[0].freshness).toBe('expired');
    expect(pack.notice).toMatch(/expired/i);
  });
});

describe('rtkService.refresh', () => {
  it('throws a clear error when no pipeline is configured', async () => {
    const service = build();
    await service.record({ topic: 't', question: 'q', value: 'v', volatilityClass: 'version' });
    await expect(service.refresh('t')).rejects.toThrow(/refresh pipeline/i);
  });

  it('applies an accept decision from the pipeline', async () => {
    const pipeline: IRefreshPipeline = {
      refresh: vi.fn().mockResolvedValue({
        proposedValue: '22.x',
        sources: [src('https://a.com'), src('https://b.com')],
        decision: { action: 'accept', confidence: 0.9, changed: true, reasons: [] },
      }),
    };
    const service = build(pipeline);
    await service.record({ topic: 't', question: 'q', value: '20.x', volatilityClass: 'version' });
    const refreshed = await service.refresh('t');
    expect(refreshed.value).toBe('22.x');
    expect(refreshed.history).toHaveLength(1);
  });

  it('refreshExpired sweeps only due facts and counts outcomes', async () => {
    const pipeline: IRefreshPipeline = {
      refresh: vi.fn().mockResolvedValue({
        proposedValue: 'v',
        sources: [src('https://a.com')],
        decision: { action: 'accept', confidence: 0.8, changed: false, reasons: [] },
      }),
    };
    const service = build(pipeline);
    // fresh fact (long TTL) — should be skipped
    await service.record({
      topic: 'fresh',
      question: 'q1',
      value: 'v',
      volatilityClass: 'role_holder',
      validAsOf: new Date(NOW).toISOString(),
    });
    // expired fact — should be refreshed
    await service.record({
      topic: 'old',
      question: 'q2',
      value: 'v',
      volatilityClass: 'status_event',
      ttlMs: 1,
      validAsOf: new Date(NOW - 1000).toISOString(),
    });

    const result = await service.refreshExpired({ now: NOW });
    expect(result.attempted).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(pipeline.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('rtkService.relate (graph layer)', () => {
  it('hides a superseded fact from lookup and archives it', async () => {
    const service = build();
    const oldFact = await service.record({ topic: 'old', question: 'q', value: 'v1', volatilityClass: 'version' });
    const newFact = await service.record({ topic: 'new', question: 'q', value: 'v2', volatilityClass: 'version' });
    await service.relate({ fromId: newFact.id, toId: oldFact.id, kind: 'supersedes' });
    const pack = await service.lookup('q', { topK: 10 });
    const ids = pack.facts.map((f) => f.fact.id);
    expect(ids).toContain(newFact.id);
    expect(ids).not.toContain(oldFact.id);
  });

  it('annotates a caution on contradicting facts', async () => {
    const service = build();
    const a = await service.record({ topic: 'a', question: 'q', value: 'v1', volatilityClass: 'version' });
    const b = await service.record({ topic: 'b', question: 'q', value: 'v2', volatilityClass: 'version' });
    await service.relate({ fromId: a.id, toId: b.id, kind: 'contradicts' });
    const pack = await service.lookup('q', { topK: 10 });
    const found = pack.facts.find((f) => f.fact.id === a.id);
    expect(found?.whyRelevant.join(' ')).toMatch(/contradicting/i);
  });

  it('is idempotent for the same (from,to,kind)', async () => {
    const service = build();
    const a = await service.record({ topic: 'a', question: 'q', value: 'v1', volatilityClass: 'version' });
    const b = await service.record({ topic: 'b', question: 'q', value: 'v2', volatilityClass: 'version' });
    await service.relate({ fromId: a.id, toId: b.id, kind: 'contradicts' });
    await service.relate({ fromId: a.id, toId: b.id, kind: 'contradicts' });
    // No throw + the second call is a no-op.
    const pack = await service.lookup('q', { topK: 10 });
    expect(pack.facts.length).toBeGreaterThan(0);
  });
});
