import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  JsonlDurableEventStore,
  MemoryDurableEventStore,
} from '../../../packages/desktop/src/process/services/agentChat/durability';

const temporaryDirectories: string[] = [];

const temporaryJournal = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tomny-event-store-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'events.jsonl');
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('MemoryDurableEventStore', () => {
  it('serializes concurrent appends and supports ordered replay filters', async () => {
    const store = new MemoryDurableEventStore();
    await store.initialize();

    await Promise.all([
      store.append({
        sessionId: 'session-a',
        requestId: 'request-a',
        kind: 'run.started',
        visibility: 'public',
        payload: { transport: 'tomny' },
      }),
      store.append({
        sessionId: 'session-a',
        requestId: 'request-a',
        kind: 'run.delta',
        visibility: 'public',
        payload: { text: 'Hello' },
      }),
      store.append({
        sessionId: 'session-b',
        kind: 'session.created',
        visibility: 'private',
        payload: null,
      }),
    ]);

    expect(await store.latestSequence()).toBe(3);
    const replay = await store.query({ sessionId: 'session-a', afterSequence: 1 });
    expect(replay).toMatchObject([{ sequence: 2, kind: 'run.delta' }]);
    expect(replay[0]?.previousHash).toHaveLength(64);
    expect(replay[0]?.hash).toHaveLength(64);
  });

  it('redacts sensitive keys and never persists secret payloads', async () => {
    const store = new MemoryDurableEventStore();
    const privateEvent = await store.append({
      sessionId: 'session-a',
      kind: 'permission.requested',
      visibility: 'private',
      payload: { apiKey: 'sk-very-secret-value', detail: 'Bearer abcdefghijklmnop' },
    });
    const secretEvent = await store.append({
      sessionId: 'session-a',
      kind: 'custom',
      visibility: 'secret',
      payload: { value: 'must-not-survive' },
    });

    expect(privateEvent.payload).toEqual({ apiKey: '[REDACTED]', detail: '[REDACTED]' });
    expect(secretEvent.payload).toEqual({ redacted: true });
  });
});

describe('JsonlDurableEventStore', () => {
  it('reloads a hash-verified append-only journal', async () => {
    const filePath = await temporaryJournal();
    const writer = new JsonlDurableEventStore(filePath);
    await writer.initialize();
    await writer.append({
      sessionId: 'session-a',
      kind: 'run.completed',
      visibility: 'public',
      payload: { text: 'done' },
    });

    const reader = new JsonlDurableEventStore(filePath);
    await reader.initialize();

    expect(await reader.latestSequence()).toBe(1);
    expect(await reader.query({ sessionId: 'session-a' })).toMatchObject([
      { sequence: 1, kind: 'run.completed', payload: { text: 'done' } },
    ]);
    expect(reader.getIntegrityIssues()).toEqual([]);
  });

  it('recovers the valid prefix and reports a corrupt crash tail', async () => {
    const filePath = await temporaryJournal();
    const writer = new JsonlDurableEventStore(filePath);
    await writer.initialize();
    await writer.append({
      sessionId: 'session-a',
      kind: 'run.started',
      visibility: 'public',
      payload: null,
    });
    const valid = await readFile(filePath, 'utf8');
    await writeFile(filePath, `${valid}{not-json`, 'utf8');

    const recovered = new JsonlDurableEventStore(filePath);
    await recovered.initialize();

    expect(await recovered.latestSequence()).toBe(1);
    expect(recovered.getIntegrityIssues()).toEqual([{ line: 2, reason: 'invalid-json' }]);
  });
});
