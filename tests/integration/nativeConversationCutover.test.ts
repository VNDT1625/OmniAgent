/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICreateConversationParams } from '@/common/adapter/ipcBridge';
import type { ExperimentalCoreEvent } from '@process/experimentalCore/experimentalCoreRuntime';
import {
  NativeConversationRepository,
  NativeConversationService,
  type NativeConversationRuntime,
} from '@process/services/database/nativeConversation';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirectories: string[] = [];
const makeRepository = async (): Promise<{ repository: NativeConversationRepository; filePath: string }> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tomny-native-conversation-'));
  tempDirectories.push(directory);
  const filePath = path.join(directory, 'conversations.json');
  return { repository: new NativeConversationRepository(filePath), filePath };
};

const params = (): ICreateConversationParams => ({
  type: 'acp',
  name: 'Native chat',
  model: {
    id: 'provider-1',
    platform: 'openai',
    name: '9Router',
    base_url: 'https://example.invalid',
    api_key: 'secret',
    use_model: 'gpt-test',
  },
  extra: {
    workspace: 'C:\\workspace',
    backend: 'claude',
    current_model_id: 'claude-test',
    surface: 'ide',
  },
});

const createHarness = async () => {
  const { repository, filePath } = await makeRepository();
  const starts: Parameters<NativeConversationRuntime['start']>[] = [];
  const cancels: string[] = [];
  const runtime: NativeConversationRuntime = {
    start: (...args) => {
      starts.push(args);
      return { requestId: args[0], sessionId: args[6] };
    },
    cancel: async (requestId) => {
      cancels.push(requestId);
      return true;
    },
  };
  const responses: Array<{ type: string; data: unknown }> = [];
  const completions: Array<{ session_id: string; state: string }> = [];
  const changes: Array<{ conversation_id: string; action: string }> = [];
  const service = new NativeConversationService(repository, runtime, {
    response: (event) => responses.push(event),
    turnCompleted: (event) => completions.push(event),
    listChanged: (event) => changes.push(event),
  });
  await service.initialize();
  return { service, repository, filePath, starts, cancels, responses, completions, changes };
};

const coreEvent = (
  requestId: string,
  sessionId: string,
  type: ExperimentalCoreEvent['type'],
  extra: Partial<ExperimentalCoreEvent> = {}
): ExperimentalCoreEvent => ({
  requestId,
  sessionId,
  targetId: 'claude',
  type,
  timestamp: Date.now(),
  sequence: 1,
  ...extra,
});

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('native conversation cutover', () => {
  it('persists CRUD metadata atomically and survives a repository restart', async () => {
    const harness = await createHarness();
    const conversation = await harness.service.create(params());

    await harness.service.update(conversation.id, { name: 'Renamed' }, true);
    const reloaded = new NativeConversationRepository(harness.filePath);
    await reloaded.initialize();

    expect((await reloaded.getConversation(conversation.id))?.name).toBe('Renamed');
    expect((await reloaded.getConversation(conversation.id))?.extra.workspace).toBe('C:\\workspace');
    expect(JSON.parse(await readFile(harness.filePath, 'utf8')).version).toBe(1);
  });

  it('streams a direct runtime turn, persists its history, and emits UI-compatible completion', async () => {
    const harness = await createHarness();
    const conversation = await harness.service.create(params());
    await harness.service.send({ conversation_id: conversation.id, input: 'hello', loading_id: 'user-1' });
    const [start] = harness.starts;
    const requestId = start[0];

    harness.service.handleCoreEvent(coreEvent(requestId, conversation.id, 'started'));
    harness.service.handleCoreEvent(coreEvent(requestId, conversation.id, 'thinking', { text: 'Inspecting' }));
    harness.service.handleCoreEvent(coreEvent(requestId, conversation.id, 'delta', { text: 'Hello ', mode: 'append' }));
    harness.service.handleCoreEvent(coreEvent(requestId, conversation.id, 'delta', { text: 'world', mode: 'append' }));
    harness.service.handleCoreEvent(coreEvent(requestId, conversation.id, 'completed'));

    await vi.waitFor(() => expect(harness.service.activeCount()).toBe(0));
    const history = await harness.service.history(conversation.id, 1, 50, 'asc');

    expect(start.slice(1, 7)).toEqual([
      'claude',
      'hello',
      'C:\\workspace',
      'claude-test',
      'workspace-write',
      conversation.id,
    ]);
    expect(history.items.map((message) => message.content.content)).toEqual(['hello', 'Hello world']);
    expect(harness.responses.map((event) => event.type)).toContain('finish');
    expect(harness.completions).toEqual([expect.objectContaining({ session_id: conversation.id, state: 'finished' })]);
  });

  it('cancels the exact active runtime request and rejects concurrent sends', async () => {
    const harness = await createHarness();
    const conversation = await harness.service.create(params());
    await harness.service.send({ conversation_id: conversation.id, input: 'first' });
    const requestId = harness.starts[0][0];

    await expect(harness.service.send({ conversation_id: conversation.id, input: 'second' })).rejects.toThrow(
      'already generating'
    );
    await harness.service.cancel(conversation.id);

    expect(harness.cancels).toEqual([requestId]);
  });

  it('removes messages with the conversation and returns cursor pagination', async () => {
    const harness = await createHarness();
    const first = await harness.service.create(params());
    const second = await harness.service.create({ ...params(), name: 'Second' });

    const page = await harness.service.list(second.id, 10);
    expect(page.items.map((item) => item.id)).toContain(first.id);

    await harness.service.remove(first.id);
    expect(await harness.service.get(first.id)).toBeUndefined();
    expect(harness.changes.at(-1)).toEqual({ conversation_id: first.id, action: 'deleted' });
  });
});
