/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { type PropsWithChildren } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import type { IMessageAcpToolCall, IMessageText, IMessageThinking } from '@/common/chat/chatLib';
import {
  MessageListLoadingProvider,
  MessageHistoryPagingProvider,
  MessageListProvider,
  useAddOrUpdateMessage,
  useMessageHistoryPaging,
  useMessageLstCache,
  useMessageList,
} from '@/renderer/pages/conversation/Messages/hooks';

vi.mock('@/common', () => ({
  ipcBridge: {
    database: {
      getConversationMessages: {
        invoke: vi.fn(),
      },
    },
  },
}));

const CONVERSATION_ID = 'conversation-1';

function createTextMessage(msgId: string, content: string, position: IMessageText['position'] = 'left'): IMessageText {
  return {
    id: `text-${msgId}-${content}`,
    type: 'text',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position,
    content: {
      content,
    },
  };
}

function withCreatedAt<T extends IMessageText>(message: T, createdAt: number): T {
  return { ...message, created_at: createdAt };
}

function createThinkingMessage(msgId: string, content: string): IMessageThinking {
  return {
    id: `thinking-${msgId}-${content}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content,
      status: 'thinking',
    },
  };
}

function createThinkingDoneMessage(msgId: string, duration: number): IMessageThinking {
  return {
    id: `thinking-done-${msgId}`,
    type: 'thinking',
    msg_id: msgId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      content: '',
      duration,
      status: 'done',
    },
  };
}

function createToolCallMessage(toolCallId: string): IMessageAcpToolCall {
  return {
    id: toolCallId,
    type: 'acp_tool_call',
    msg_id: toolCallId,
    conversation_id: CONVERSATION_ID,
    position: 'left',
    content: {
      session_id: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        tool_call_id: toolCallId,
        status: 'completed',
        title: 'Read file',
        kind: 'read',
      },
    },
  };
}

function TestWrapper({ children }: PropsWithChildren): JSX.Element {
  return <MessageListProvider value={[]}>{children}</MessageListProvider>;
}

function CacheWrapper({ children }: PropsWithChildren): JSX.Element {
  return (
    <MessageListLoadingProvider value={false}>
      <MessageHistoryPagingProvider value={{ hasOlder: false, loadingOlder: false, loadOlder: async () => false }}>
        <MessageListProvider value={[]}>{children}</MessageListProvider>
      </MessageHistoryPagingProvider>
    </MessageListLoadingProvider>
  );
}

function useMessageHarness() {
  return {
    addOrUpdateMessage: useAddOrUpdateMessage(),
    messages: useMessageList(),
  };
}

function useMessageCacheHarness() {
  useMessageLstCache(CONVERSATION_ID);
  return {
    messages: useMessageList(),
    paging: useMessageHistoryPaging(),
  };
}

async function flushMessageQueue(): Promise<void> {
  await act(async () => {
    vi.runAllTimers();
  });
}

describe('message merging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps text segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'hello'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', ' world'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('text');
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createTextMessage('msg-1', 'again'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['text', 'acp_tool_call', 'text']);
    expect((result.current.messages[0] as IMessageText).content.content).toBe('hello world');
    expect((result.current.messages[2] as IMessageText).content.content).toBe('again');
  });

  it('keeps thinking segments split when tool calls interrupt the same msg_id stream', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'beta'));
    });
    await flushMessageQueue();

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].type).toBe('thinking');
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');

    act(() => {
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'gamma'));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call', 'thinking']);
    expect((result.current.messages[0] as IMessageThinking).content.content).toBe('alphabeta');
    expect((result.current.messages[2] as IMessageThinking).content.content).toBe('gamma');
  });

  it('merges thinking done updates into the existing thinking message instead of appending a completion message', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(createThinkingMessage('msg-1', 'alpha'));
      result.current.addOrUpdateMessage(createToolCallMessage('tool-1'));
      result.current.addOrUpdateMessage(createThinkingDoneMessage('msg-1', 4200));
    });
    await flushMessageQueue();

    expect(result.current.messages.map((message) => message.type)).toEqual(['thinking', 'acp_tool_call']);
    expect((result.current.messages[0] as IMessageThinking).content.status).toBe('done');
    expect((result.current.messages[0] as IMessageThinking).content.duration).toBe(4200);
  });

  it('ignores non-renderable transformed stream messages', async () => {
    const { result } = renderHook(() => useMessageHarness(), {
      wrapper: TestWrapper,
    });

    act(() => {
      result.current.addOrUpdateMessage(undefined);
    });
    await flushMessageQueue();

    expect(result.current.messages).toEqual([]);
  });

  it('requests only the latest compact message when hydrating historical messages', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke.mockResolvedValue({ items: [], total: 0, has_more: false });

    renderHook(() => useMessageLstCache(CONVERSATION_ID), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenCalledWith({
      conversation_id: CONVERSATION_ID,
      page: 1,
      page_size: 1,
      order: 'desc',
      content_mode: 'compact',
    });
  });

  it('anchors initial hydration at the latest user message instead of the latest AI message', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke.mockResolvedValueOnce({
      items: [createTextMessage('assistant-latest', 'assistant latest', 'left')],
      total: 3,
      has_more: true,
    });
    invoke.mockResolvedValueOnce({
      items: [
        withCreatedAt(createTextMessage('assistant-latest', 'assistant latest', 'left'), 300),
        withCreatedAt(createTextMessage('user-latest', 'user latest', 'right'), 200),
        withCreatedAt(createTextMessage('older', 'older', 'left'), 100),
      ],
      total: 3,
      has_more: false,
    });

    const { result } = renderHook(() => useMessageCacheHarness(), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(invoke).toHaveBeenNthCalledWith(1, {
      conversation_id: CONVERSATION_ID,
      page: 1,
      page_size: 1,
      order: 'desc',
      content_mode: 'compact',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, {
      conversation_id: CONVERSATION_ID,
      page: 1,
      page_size: 11,
      order: 'desc',
      content_mode: 'compact',
    });
    expect(result.current.messages.map((message) => message.msg_id)).toEqual(['user-latest', 'assistant-latest']);
    expect(result.current.paging.initialAnchorMessageId).toBe('text-user-latest-user latest');
  });

  it('loads ten older messages when history paging asks for more', async () => {
    const invoke = vi.mocked(ipcBridge.database.getConversationMessages.invoke);
    invoke.mockClear();
    invoke.mockResolvedValueOnce({
      items: [createTextMessage('latest', 'latest', 'right')],
      total: 12,
      has_more: true,
    });
    invoke.mockResolvedValueOnce({
      items: Array.from({ length: 11 }, (_, index) => createTextMessage(`msg-${index}`, `content-${index}`)),
      total: 12,
      has_more: true,
    });

    const { result } = renderHook(() => useMessageCacheHarness(), {
      wrapper: CacheWrapper,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.paging.hasOlder).toBe(true);

    await act(async () => {
      await result.current.paging.loadOlder();
    });

    expect(invoke).toHaveBeenLastCalledWith({
      conversation_id: CONVERSATION_ID,
      page: 1,
      page_size: 11,
      order: 'desc',
      content_mode: 'compact',
    });
  });
});
