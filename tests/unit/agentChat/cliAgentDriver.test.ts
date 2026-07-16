/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCliAgentDriver,
  flattenMessagesToPrompt,
  type CliAgentDriverDeps,
} from '@process/services/agentChat/cliAgentDriver';
import {
  CLI_MODEL_PREFIX,
  isCliModelId,
  makeCliModelId,
  parseCliModelId,
} from '@process/services/agentChat/cliModelId';

const immediateSleep = (): Promise<void> => Promise.resolve();

afterEach(() => {
  vi.useRealTimers();
});

describe('cliModelId', () => {
  it('encodes and decodes a CLI agent id', () => {
    const id = makeCliModelId('claude');
    expect(id).toBe(`${CLI_MODEL_PREFIX}claude`);
    expect(isCliModelId(id)).toBe(true);
    expect(parseCliModelId(id)).toEqual({ agentId: 'claude' });
  });

  it('encodes and decodes a CLI agent model id', () => {
    const id = makeCliModelId('claude', 'sonnet 4');
    expect(id).toBe(`${CLI_MODEL_PREFIX}claude?model=sonnet%204`);
    expect(parseCliModelId(id)).toEqual({ agentId: 'claude', modelId: 'sonnet 4' });
  });

  it('treats a normal model name as a provider model (not CLI)', () => {
    expect(isCliModelId('claude-opus-4-8')).toBe(false);
    expect(parseCliModelId('claude-opus-4-8')).toBeNull();
    expect(parseCliModelId(undefined)).toBeNull();
  });

  it('rejects an empty agent id after the prefix', () => {
    expect(isCliModelId(CLI_MODEL_PREFIX)).toBe(false);
    expect(parseCliModelId(`${CLI_MODEL_PREFIX}   `)).toBeNull();
  });
});

describe('flattenMessagesToPrompt', () => {
  it('renders roles as labelled blocks and joins multimodal text', () => {
    const prompt = flattenMessagesToPrompt([
      { role: 'system', content: 'Be brief.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image_url', image_url: { url: 'x' } },
        ],
      },
    ]);
    expect(prompt).toContain('### System');
    expect(prompt).toContain('Be brief.');
    expect(prompt).toContain('### User');
    expect(prompt).toContain('Hello');
    expect(prompt).toContain('[image omitted]');
  });

  it('skips empty messages', () => {
    expect(flattenMessagesToPrompt([{ role: 'user', content: '' }])).toBe('');
  });
});

describe('createCliAgentDriver', () => {
  const baseDeps = (over: Partial<CliAgentDriverDeps>): CliAgentDriverDeps => ({
    createConversation: vi.fn(async () => ({ conversationId: 'c1', owned: true })),
    sendMessage: vi.fn(async () => undefined),
    readLastAnswer: vi.fn(async () => null),
    removeConversation: vi.fn(async () => undefined),
    sleep: immediateSleep,
    pollIntervalMs: 1,
    timeoutMs: 5000,
    ...over,
  });

  it('resolves the answer from a turn-completed signal carrying content', async () => {
    let emit: ((sig: { conversationId: string; finished: boolean; content?: string }) => void) | null = null;
    const deps = baseDeps({
      onTurnCompleted: (listener) => {
        emit = listener;
        return () => {};
      },
      sendMessage: vi.fn(async () => {
        // Fire the completion signal right after the prompt is sent.
        emit?.({ conversationId: 'c1', finished: true, content: 'the answer' });
      }),
    });
    const driver = createCliAgentDriver(deps);
    const answer = await driver.run({ agentId: 'claude', messages: [{ role: 'user', content: 'hi' }] });
    expect(answer).toBe('the answer');
    expect(deps.removeConversation).toHaveBeenCalledWith('c1');
  });

  it('passes a selected CLI model id into conversation creation', async () => {
    let emit: ((sig: { conversationId: string; finished: boolean; content?: string }) => void) | null = null;
    const deps = baseDeps({
      createConversation: vi.fn(async () => ({ conversationId: 'c1', owned: true })),
      onTurnCompleted: (listener) => {
        emit = listener;
        return () => {};
      },
      sendMessage: vi.fn(async () => {
        emit?.({ conversationId: 'c1', finished: true, content: 'ok' });
      }),
    });
    const driver = createCliAgentDriver(deps);
    await expect(
      driver.run({ agentId: 'claude', modelId: 'sonnet', messages: [{ role: 'user', content: 'hi' }] })
    ).resolves.toBe('ok');
    expect(deps.createConversation).toHaveBeenCalledWith('claude', 'sonnet');
  });

  it('falls back to REST polling when no WS signal arrives', async () => {
    let reads = 0;
    const deps = baseDeps({
      onTurnCompleted: undefined,
      readLastAnswer: vi.fn(async () => {
        reads += 1;
        return reads >= 2 ? 'polled answer' : null;
      }),
    });
    const driver = createCliAgentDriver(deps);
    const answer = await driver.run({ agentId: 'codex', messages: [{ role: 'user', content: 'hi' }] });
    expect(answer).toBe('polled answer');
  });

  it('reads the last answer when the signal has no content', async () => {
    let emit: ((sig: { conversationId: string; finished: boolean; content?: string }) => void) | null = null;
    const deps = baseDeps({
      onTurnCompleted: (listener) => {
        emit = listener;
        return () => {};
      },
      readLastAnswer: vi.fn(async () => 'read from store'),
      sendMessage: vi.fn(async () => {
        emit?.({ conversationId: 'c1', finished: true });
      }),
    });
    const driver = createCliAgentDriver(deps);
    const answer = await driver.run({ agentId: 'claude', messages: [{ role: 'user', content: 'hi' }] });
    expect(answer).toBe('read from store');
  });

  it('throws a clear error when the agent is not runnable', async () => {
    const deps = baseDeps({ createConversation: vi.fn(async () => null) });
    const driver = createCliAgentDriver(deps);
    await expect(driver.run({ agentId: 'ghost', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /not available/i
    );
  });

  it('rejects and cleans up on timeout', async () => {
    const deps = baseDeps({
      onTurnCompleted: () => () => {},
      readLastAnswer: vi.fn(async () => null),
      timeoutMs: 5,
      sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
      pollIntervalMs: 1000,
    });
    const driver = createCliAgentDriver(deps);
    await expect(driver.run({ agentId: 'claude', messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /did not respond/i
    );
    expect(deps.removeConversation).toHaveBeenCalledWith('c1');
  });

  it('cancels the backend turn when the agent stops producing activity', async () => {
    vi.useFakeTimers();
    const deps = baseDeps({
      onTurnCompleted: () => () => {},
      readLastAnswer: vi.fn(async () => null),
      cancelConversation: vi.fn(async () => undefined),
      timeoutMs: 5000,
      idleTimeoutMs: 50,
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      pollIntervalMs: 1000,
    });
    const driver = createCliAgentDriver(deps);

    const run = driver.run({ agentId: 'claude', messages: [{ role: 'user', content: 'hi' }] });
    const rejected = expect(run).rejects.toThrow(/stalled/i);
    await vi.advanceTimersByTimeAsync(60);

    await rejected;
    expect(deps.cancelConversation).toHaveBeenCalledWith('c1');
    expect(deps.removeConversation).toHaveBeenCalledWith('c1');
  });

  it('honours an abort signal', async () => {
    const controller = new AbortController();
    const deps = baseDeps({
      onTurnCompleted: () => () => {},
      sendMessage: vi.fn(async () => {
        controller.abort();
      }),
      readLastAnswer: vi.fn(async () => null),
      pollIntervalMs: 1000,
    });
    const driver = createCliAgentDriver(deps);
    await expect(
      driver.run({ agentId: 'claude', messages: [{ role: 'user', content: 'hi' }], signal: controller.signal })
    ).rejects.toThrow(/cancelled/i);
  });
});
