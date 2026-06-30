/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { AgentStreamErrorInfo, IMessageText, IMessageTips, TMessage } from '@/common/chat/chatLib';
import {
  composeMessage,
  mergeAcpToolCallContent,
  mergeTextMessageContent,
  normalizeAgentStreamError,
  preferTextMessageVersion,
  stripTokenWatermarkNotice,
} from '@/common/chat/chatLib';
import { useCallback, useEffect, useRef } from 'react';
import { createContext } from '@renderer/utils/ui/createContext';

const [useMessageList, MessageListProvider, useUpdateMessageList] = createContext([] as TMessage[]);
const [useMessageListLoading, MessageListLoadingProvider, useUpdateMessageListLoading] = createContext(false);
type MessageHistoryPagingState = {
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => Promise<boolean>;
  initialAnchorMessageId?: string;
};
const [useMessageHistoryPaging, MessageHistoryPagingProvider, useUpdateMessageHistoryPaging] =
  createContext<MessageHistoryPagingState>({
    hasOlder: false,
    loadingOlder: false,
    loadOlder: async (): Promise<boolean> => false,
  });

const [useChatKey, ChatKeyProvider] = createContext('');

const beforeUpdateMessageListStack: Array<(list: TMessage[]) => TMessage[]> = [];

// 消息索引缓存类型定义
// Message index cache type definitions
interface MessageIndex {
  msgIdIndex: Map<string, number>; // msg_id -> index
  call_idIndex: Map<string, number>; // tool_call.call_id -> index
  tool_call_idIndex: Map<string, number>; // acp_tool_call.update.tool_call_id -> index
  permission_call_idIndex: Map<string, number>; // permission.content.call_id -> index
}

function getMessageIndexKey(message: TMessage): string | undefined {
  if (!message.msg_id) return undefined;
  return message.type === 'thinking' ? `thinking:${message.msg_id}` : message.msg_id;
}

// 使用 WeakMap 缓存索引，当列表被 GC 时自动清理
// Use WeakMap to cache index, auto-cleanup when list is GC'd
const indexCache = new WeakMap<TMessage[], MessageIndex>();

export function logDroppedToolCallWithoutCallId(message: TMessage | undefined): boolean {
  if (!message) return false;
  if (message.type !== 'tool_call' || message.content?.call_id) return false;

  console.warn('[tool-call] dropped tool_call without call_id', {
    conversation_id: message.conversation_id,
    msg_id: message.msg_id,
    name: message.content?.name,
    status: message.content?.status,
  });
  return true;
}

// 构建消息索引
// Build message index
function buildMessageIndex(list: TMessage[]): MessageIndex {
  const msgIdIndex = new Map<string, number>();
  const call_idIndex = new Map<string, number>();
  const tool_call_idIndex = new Map<string, number>();
  const permission_call_idIndex = new Map<string, number>();

  for (let i = 0; i < list.length; i++) {
    const msg = list[i];
    const msgIndexKey = getMessageIndexKey(msg);
    if (msgIndexKey) {
      msgIdIndex.set(msgIndexKey, i);
    }
    if (msg.type === 'tool_call' && msg.content?.call_id) {
      call_idIndex.set(msg.content.call_id, i);
    }
    if (msg.type === 'acp_tool_call' && msg.content?.update?.tool_call_id) {
      tool_call_idIndex.set(msg.content.update.tool_call_id, i);
    }
    if (msg.type === 'permission' && msg.content?.call_id) {
      permission_call_idIndex.set(msg.content.call_id, i);
    }
  }

  return { msgIdIndex, call_idIndex, tool_call_idIndex, permission_call_idIndex };
}

// 获取或构建索引（带缓存）
// Get or build index with caching
function getOrBuildIndex(list: TMessage[]): MessageIndex {
  let cached = indexCache.get(list);
  if (!cached) {
    cached = buildMessageIndex(list);
    indexCache.set(list, cached);
  }
  return cached;
}

// 使用索引优化的消息合并函数
// Index-optimized message compose function
function composeMessageWithIndex(message: TMessage | undefined, list: TMessage[], index: MessageIndex): TMessage[] {
  if (!message) return list || [];

  if (logDroppedToolCallWithoutCallId(message)) {
    return list || [];
  }

  if (!list?.length) {
    // Update index when adding first message
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) {
      index.msgIdIndex.set(msgIndexKey, 0);
    }
    return [message];
  }

  const last = list[list.length - 1];

  // 对于 tool_group 类型，使用原始的 composeMessage（因为涉及内部数组匹配）
  // For tool_group type, use original composeMessage (involves inner array matching)
  // After composeMessage, the returned list may have different length/ordering,
  // so we must invalidate the index to prevent stale lookups in subsequent calls.
  if (message.type === 'tool_group') {
    const result = composeMessage(message, list);
    if (result !== list) {
      // Rebuild index maps from the new list to keep them in sync
      const rebuilt = buildMessageIndex(result);
      index.msgIdIndex = rebuilt.msgIdIndex;
      index.call_idIndex = rebuilt.call_idIndex;
      index.tool_call_idIndex = rebuilt.tool_call_idIndex;
      index.permission_call_idIndex = rebuilt.permission_call_idIndex;
    }
    return result;
  }

  // tool_call: 使用 call_idIndex 快速查找
  // tool_call: use call_idIndex for fast lookup
  if (message.type === 'tool_call' && message.content?.call_id) {
    const existingIdx = index.call_idIndex.get(message.content.call_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      if (existingMsg.type === 'tool_call') {
        const newList = list.slice();
        const merged = { ...existingMsg.content, ...message.content };
        newList[existingIdx] = { ...existingMsg, content: merged };
        return newList;
      }
    }
    // 未找到，添加新消息并更新索引
    const newIdx = list.length;
    index.call_idIndex.set(message.content.call_id, newIdx);
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
    return list.concat(message);
  }

  // acp_tool_call: use tool_call_idIndex for fast lookup
  if (message.type === 'acp_tool_call' && message.content?.update?.tool_call_id) {
    const existingIdx = index.tool_call_idIndex.get(message.content.update.tool_call_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      if (existingMsg.type === 'acp_tool_call') {
        const newList = list.slice();
        const merged = mergeAcpToolCallContent(existingMsg.content, message.content);
        newList[existingIdx] = { ...existingMsg, content: merged };
        return newList;
      }
    }
    // 未找到，添加新消息并更新索引
    const newIdx = list.length;
    index.tool_call_idIndex.set(message.content.update.tool_call_id, newIdx);
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
    return list.concat(message);
  }

  // permission: use call_id for recovery/live stream dedupe.
  if (message.type === 'permission' && message.content?.call_id) {
    const existingIdx = index.permission_call_idIndex.get(message.content.call_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      if (existingMsg.type === 'permission') {
        const newList = list.slice();
        newList[existingIdx] = { ...existingMsg, ...message, content: message.content };
        return newList;
      }
    }
    const newIdx = list.length;
    index.permission_call_idIndex.set(message.content.call_id, newIdx);
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
    return list.concat(message);
  }

  // text message: merge only with the latest contiguous streaming chunk.
  // text 消息: 只与最后一条连续的流式片段合并，保留被工具/思考打断后的消息边界。
  if (message.type === 'text' && message.msg_id) {
    const existingIdx = index.msgIdIndex.get(message.msg_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      if (existingMsg.type === 'text') {
        // User messages (right position) are complete — skip if already exists to prevent duplicates
        if (message.position === 'right') {
          return list;
        }
        // Complete teammate messages are not streaming chunks — skip if already exists
        if ((message.content as { teammateMessage?: boolean })?.teammateMessage) {
          return list;
        }
      }
    }

    if (last.type === 'text' && last.msg_id === message.msg_id) {
      const newList = list.slice();
      newList[newList.length - 1] = {
        ...last,
        content: mergeTextMessageContent(last.content, message.content),
      };
      return newList;
    }

    const newIdx = list.length;
    index.msgIdIndex.set(message.msg_id, newIdx);
    return list.concat(message);
  }

  // thinking message: merge only with the latest contiguous thinking chunk.
  // Uses "thinking:${msg_id}" key to avoid collision with text messages sharing the same msg_id.
  if (message.type === 'thinking' && message.msg_id) {
    const thinkingKey = `thinking:${message.msg_id}`;
    if (message.content.status === 'done') {
      const existingIdx = index.msgIdIndex.get(thinkingKey);
      if (existingIdx !== undefined && existingIdx < list.length) {
        const existingMsg = list[existingIdx];
        if (existingMsg.type === 'thinking') {
          const newList = list.slice();
          newList[existingIdx] = {
            ...existingMsg,
            content: {
              ...existingMsg.content,
              status: 'done' as const,
              duration: message.content.duration,
              subject: message.content.subject || existingMsg.content.subject,
            },
          };
          return newList;
        }
      }
    }

    if (last.type === 'thinking' && last.msg_id === message.msg_id) {
      const newList = list.slice();
      newList[newList.length - 1] = {
        ...last,
        content: {
          ...last.content,
          content: last.content.content + message.content.content,
          subject: message.content.subject || last.content.subject,
        },
      };
      return newList;
    }

    const newIdx = list.length;
    index.msgIdIndex.set(thinkingKey, newIdx);
    return list.concat(message);
  }

  // plan message: update content and move to end of list
  if (message.type === 'plan' && message.msg_id) {
    const existingIdx = index.msgIdIndex.get(message.msg_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      const newList = list.slice();
      newList.splice(existingIdx, 1);
      const updated = { ...existingMsg, ...message, content: message.content } as TMessage;
      newList.push(updated);
      // Rebuild index after splice
      const rebuilt = buildMessageIndex(newList);
      index.msgIdIndex = rebuilt.msgIdIndex;
      index.call_idIndex = rebuilt.call_idIndex;
      index.tool_call_idIndex = rebuilt.tool_call_idIndex;
      index.permission_call_idIndex = rebuilt.permission_call_idIndex;
      return newList;
    }
    const newIdx = list.length;
    index.msgIdIndex.set(message.msg_id, newIdx);
    return list.concat(message);
  }

  // agent_status / tips and other msg_id-based messages:
  // replace the existing item in place instead of appending duplicates.
  if (message.msg_id) {
    const existingIdx = index.msgIdIndex.get(message.msg_id);
    if (existingIdx !== undefined && existingIdx < list.length) {
      const existingMsg = list[existingIdx];
      const newList = list.slice();
      newList[existingIdx] = {
        ...existingMsg,
        ...message,
        content: message.content,
      } as TMessage;
      return newList;
    }
  }

  // Other types: fallback to last message check
  // 其他类型: 回退到检查最后一条消息
  if (last.msg_id !== message.msg_id || last.type !== message.type) {
    // Add new message and update index
    const newIdx = list.length;
    const msgIndexKey = getMessageIndexKey(message);
    if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
    return list.concat(message);
  }

  // Merge other message types with same msg_id
  const newList = list.slice();
  const lastIdx = newList.length - 1;
  newList[lastIdx] = { ...last, ...message };
  return newList;
}

export const useAddOrUpdateMessage = () => {
  const update = useUpdateMessageList();
  const pendingRef = useRef<Array<{ message: TMessage; add: boolean }>>([]);
  const rafRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    rafRef.current = null;

    const pending = pendingRef.current;
    if (!pending.length) return;
    pendingRef.current = [];
    update((list) => {
      // 获取或构建索引用于快速查找 (O(1) instead of O(n))
      // Get or build index for fast lookup
      const index = getOrBuildIndex(list);
      let newList = list;

      for (const item of pending) {
        if (!item.message) {
          continue;
        }

        if (logDroppedToolCallWithoutCallId(item.message)) {
          continue;
        }

        if (item.add) {
          // 新增消息，更新索引
          // New message, update index
          const msg = item.message;
          const newIdx = newList.length;
          const msgIndexKey = getMessageIndexKey(msg);
          if (msgIndexKey) index.msgIdIndex.set(msgIndexKey, newIdx);
          if (msg.type === 'tool_call' && msg.content?.call_id) {
            index.call_idIndex.set(msg.content.call_id, newIdx);
          }
          if (msg.type === 'acp_tool_call' && msg.content?.update?.tool_call_id) {
            index.tool_call_idIndex.set(msg.content.update.tool_call_id, newIdx);
          }
          if (msg.type === 'permission' && msg.content?.call_id) {
            index.permission_call_idIndex.set(msg.content.call_id, newIdx);
          }
          newList = newList.concat(msg);
        } else {
          // 使用索引优化的消息合并
          // Use index-optimized message compose
          newList = composeMessageWithIndex(item.message, newList, index);
        }

        while (beforeUpdateMessageListStack.length) {
          newList = beforeUpdateMessageListStack.shift()!(newList);
        }
      }
      return newList;
    });

    rafRef.current = setTimeout(flush);
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        clearTimeout(rafRef.current);
      }
    };
  }, []);

  return useCallback(
    (message: TMessage | undefined, add = false) => {
      if (!message) {
        return;
      }
      pendingRef.current.push({ message, add });
      if (rafRef.current === null) {
        rafRef.current = setTimeout(flush);
      }
    },
    [flush]
  );
};

export const useRemoveMessageByMsgId = () => {
  const update = useUpdateMessageList();

  return useCallback(
    (msgId: string) => {
      update((list) => list.filter((message) => message.msg_id !== msgId));
    },
    [update]
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJsonRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const normalizeTipType = (value: unknown, fallback: IMessageTips['content']['type']) =>
  value === 'success' || value === 'warning' || value === 'error' ? value : fallback;

const classifyPersistedSendFailure = (
  parsed: Record<string, unknown>,
  message: string
): AgentStreamErrorInfo | undefined => {
  if (typeof parsed.source !== 'string' && typeof parsed.code !== 'string') {
    return undefined;
  }

  const persistedCode = typeof parsed.code === 'string' ? parsed.code : undefined;
  if (persistedCode === 'BAD_GATEWAY') {
    return {
      message,
      code: 'UNKNOWN_UPSTREAM_ERROR',
      ownership: 'unknown_upstream',
      detail: message,
      retryable: true,
      feedback_recommended: true,
    };
  }

  if (persistedCode === 'INTERNAL_ERROR') {
    return {
      message,
      code: 'AIONUI_INTERNAL_ERROR',
      ownership: 'aionui',
      detail: message,
      retryable: true,
      feedback_recommended: true,
    };
  }

  if (persistedCode?.startsWith('AIONUI_')) {
    return { message, code: persistedCode, ownership: 'aionui', detail: message, retryable: true };
  }
  if (persistedCode?.startsWith('USER_AGENT_')) {
    return { message, code: persistedCode, ownership: 'user_agent', detail: message, retryable: true };
  }
  if (persistedCode?.startsWith('USER_LLM_PROVIDER_')) {
    return {
      message,
      code: persistedCode,
      ownership: 'user_llm_provider',
      detail: message,
      retryable: false,
      feedback_recommended: false,
    };
  }
  if (persistedCode === 'UNKNOWN_UPSTREAM_ERROR') {
    return {
      message,
      code: persistedCode,
      ownership: 'unknown_upstream',
      detail: message,
      retryable: true,
      feedback_recommended: true,
    };
  }

  if (parsed.source === 'send_failed') {
    return {
      message,
      code: 'AIONUI_INTERNAL_ERROR',
      ownership: 'aionui',
      detail: message,
      retryable: true,
      feedback_recommended: true,
    };
  }

  return undefined;
};

const normalizeDbTipsMessage = (msg: TMessage): TMessage => {
  if (msg.type !== 'tips') return msg;
  const parsed = parseJsonRecord(msg.content);
  if (!parsed || typeof parsed.content !== 'string') return msg;

  const existingContent = isRecord(msg.content) ? msg.content : undefined;
  const fallbackType =
    existingContent?.type === 'success' || existingContent?.type === 'warning' || existingContent?.type === 'error'
      ? existingContent.type
      : 'error';
  const tipType = normalizeTipType(parsed.type, fallbackType);
  const structuredError =
    tipType === 'error'
      ? (normalizeAgentStreamError(parsed.error) ??
        classifyPersistedSendFailure(parsed, parsed.content) ??
        normalizeAgentStreamError({ ...parsed, message: parsed.content }))
      : undefined;

  return {
    ...msg,
    content: {
      content: parsed.content,
      type: tipType,
      ...(structuredError ? { error: structuredError } : {}),
    },
  } as IMessageTips;
};

/**
 * Normalize a message loaded from backend DB: if `content` is a JSON string,
 * parse it and map stored fields to renderer message content.
 */
export function normalizeDbMessage(msg: TMessage): TMessage {
  if (msg.type === 'tips') return normalizeDbTipsMessage(msg);
  if (msg.type !== 'text') return msg;
  const raw = msg.content as unknown;
  if (typeof raw !== 'string') {
    const content = stripTokenWatermarkNotice(msg.content.content);
    return content.length > 0 ? { ...msg, content: { ...msg.content, content } } : { ...msg, hidden: true };
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.content !== 'string') return msg;
    const content = stripTokenWatermarkNotice(parsed.content);
    if (content.length === 0) return { ...msg, hidden: true };
    return {
      ...msg,
      content: {
        content,
        ...(parsed.teammate_message ? { teammateMessage: true } : {}),
        ...(parsed.sender_name ? { senderName: parsed.sender_name as string } : {}),
        ...(parsed.sender_backend ? { senderAgentType: parsed.sender_backend as string } : {}),
        ...(parsed.sender_conversation_id ? { senderConversationId: parsed.sender_conversation_id as string } : {}),
      },
    };
  } catch {
    const content = stripTokenWatermarkNotice(raw);
    return content.length > 0 ? { ...msg, content: { content } } : { ...msg, hidden: true };
  }
}

const INITIAL_MESSAGE_WINDOW_SIZE = 1;
const OLDER_MESSAGE_BATCH_SIZE = 10;
const MAX_INITIAL_USER_ANCHOR_WINDOW_SIZE = 101;

const sortMessagesAsc = (messages: TMessage[]): TMessage[] =>
  messages.toSorted((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));

const sliceFromLatestUserMessage = (messages: TMessage[]): TMessage[] => {
  const latestUserIndex = messages.findLastIndex((message) => message.position === 'right');
  return latestUserIndex >= 0 ? messages.slice(latestUserIndex) : messages.slice(-INITIAL_MESSAGE_WINDOW_SIZE);
};

const latestUserMessageId = (messages: TMessage[]): string | undefined => {
  const latestUser = messages.findLast((message) => message.position === 'right');
  return latestUser?.id;
};

const getMessageDedupeKey = (message: TMessage, fallbackIndex: number): string =>
  message.id || message.msg_id || `${message.type}:${message.created_at ?? fallbackIndex}`;

const dedupeMessages = (messages: TMessage[]): TMessage[] => {
  const seen = new Set<string>();
  const result: TMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const key = getMessageDedupeKey(message, index);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(message);
  }
  return result;
};

const isVolatileMessage = (message: TMessage): boolean =>
  message.type === 'thinking' ||
  message.type === 'agent_status' ||
  message.type === 'permission' ||
  message.type === 'acp_permission';

const mergeLoadedMessages = (
  messages: TMessage[],
  currentList: TMessage[],
  key: string,
  preserveUnloaded = true
): TMessage[] => {
  if (!currentList.length) return messages;
  const sameConversation = currentList.filter((m) => m.conversation_id === key);
  if (!sameConversation.length) return messages;
  const dbIds = new Set(messages.map((m) => m.id));
  const dbMsgIds = new Set(messages.map((m) => m.msg_id).filter(Boolean));

  const streamingByMsgId = new Map<string, IMessageText>();
  for (const m of sameConversation) {
    if (m.msg_id && m.type === 'text' && dbMsgIds.has(m.msg_id)) {
      streamingByMsgId.set(m.msg_id, m);
    }
  }

  const mergedMessages = messages.map((dbMsg) => {
    if (!dbMsg.msg_id || dbMsg.type !== 'text') return dbMsg;
    const streamMsg = streamingByMsgId.get(dbMsg.msg_id);
    if (!streamMsg) return dbMsg;
    return preferTextMessageVersion(dbMsg, streamMsg);
  });

  const newestLoadedAt = Math.max(...messages.map((m) => m.created_at ?? 0), 0);
  const streamingOnly = sameConversation.filter((m) => {
    if (dbIds.has(m.id) || (m.msg_id && dbMsgIds.has(m.msg_id))) return false;
    if (preserveUnloaded) return true;
    if (isVolatileMessage(m)) return true;
    return (m.created_at ?? 0) >= newestLoadedAt;
  });
  return dedupeMessages(sortMessagesAsc([...mergedMessages, ...streamingOnly]));
};

export const useMessageLstCache = (key: string) => {
  const update = useUpdateMessageList();
  const setLoading = useUpdateMessageListLoading();
  const updatePaging = useUpdateMessageHistoryPaging();
  const loadedWindowSizeRef = useRef(INITIAL_MESSAGE_WINDOW_SIZE);
  const hasOlderRef = useRef(false);
  const loadingOlderRef = useRef(false);

  const setPagingState = useCallback(
    (state: Partial<Pick<MessageHistoryPagingState, 'hasOlder' | 'loadingOlder' | 'initialAnchorMessageId'>>) => {
      if (typeof state.hasOlder === 'boolean') hasOlderRef.current = state.hasOlder;
      if (typeof state.loadingOlder === 'boolean') loadingOlderRef.current = state.loadingOlder;
      updatePaging((current) => ({
        ...current,
        hasOlder: hasOlderRef.current,
        loadingOlder: loadingOlderRef.current,
        ...(Object.hasOwn(state, 'initialAnchorMessageId')
          ? { initialAnchorMessageId: state.initialAnchorMessageId }
          : {}),
      }));
    },
    [updatePaging]
  );

  const fetchLatestWindow = useCallback(
    async (pageSize: number): Promise<{ messages: TMessage[]; hasMore: boolean; windowSize: number }> => {
      const result = await ipcBridge.database.getConversationMessages.invoke({
        conversation_id: key,
        page: 1,
        page_size: pageSize,
        order: 'desc',
        content_mode: 'compact',
      });
      return {
        messages: sortMessagesAsc((result?.items ?? []).map(normalizeDbMessage)),
        hasMore: Boolean(result?.has_more),
        windowSize: pageSize,
      };
    },
    [key]
  );

  const fetchInitialUserAnchoredWindow = useCallback(async (): Promise<{
    messages: TMessage[];
    hasMore: boolean;
    windowSize: number;
  }> => {
    let pageSize = INITIAL_MESSAGE_WINDOW_SIZE;
    let latest = await fetchLatestWindow(pageSize);
    while (
      latest.hasMore &&
      latest.messages.findLastIndex((message) => message.position === 'right') < 0 &&
      pageSize < MAX_INITIAL_USER_ANCHOR_WINDOW_SIZE
    ) {
      pageSize = Math.min(pageSize + OLDER_MESSAGE_BATCH_SIZE, MAX_INITIAL_USER_ANCHOR_WINDOW_SIZE);
      // eslint-disable-next-line no-await-in-loop -- initial hydration expands only until it finds the latest user message.
      latest = await fetchLatestWindow(pageSize);
    }

    return {
      ...latest,
      messages: sliceFromLatestUserMessage(latest.messages),
    };
  }, [fetchLatestWindow]);

  const loadMessages = useCallback(async (): Promise<TMessage[]> => {
    loadedWindowSizeRef.current = INITIAL_MESSAGE_WINDOW_SIZE;
    const { messages, hasMore, windowSize } = await fetchInitialUserAnchoredWindow();
    loadedWindowSizeRef.current = windowSize;
    if (messages && Array.isArray(messages)) {
      update((currentList) => {
        return mergeLoadedMessages(messages, currentList, key, false);
      });
      setPagingState({ hasOlder: hasMore, loadingOlder: false, initialAnchorMessageId: latestUserMessageId(messages) });
      return messages;
    }
    setPagingState({ hasOlder: false, loadingOlder: false, initialAnchorMessageId: undefined });
    return [];
  }, [fetchInitialUserAnchoredWindow, key, setPagingState, update]);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (!key || loadingOlderRef.current || !hasOlderRef.current) return false;
    setPagingState({ loadingOlder: true });
    const nextWindowSize = loadedWindowSizeRef.current + OLDER_MESSAGE_BATCH_SIZE;
    try {
      const { messages, hasMore } = await fetchLatestWindow(nextWindowSize);
      loadedWindowSizeRef.current = nextWindowSize;
      update((currentList) => mergeLoadedMessages(messages, currentList, key));
      setPagingState({ hasOlder: hasMore, loadingOlder: false });
      return true;
    } catch (error) {
      console.error('[useMessageLstCache] Failed to load older messages from database:', error);
      setPagingState({ loadingOlder: false });
      return false;
    }
  }, [fetchLatestWindow, key, setPagingState, update]);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    setLoading(true);
    updatePaging({ hasOlder: false, loadingOlder: false, loadOlder, initialAnchorMessageId: undefined });
    void loadMessages()
      .catch((error) => {
        console.error('[useMessageLstCache] Failed to load messages from database:', error);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, loadMessages, loadOlder, setLoading, updatePaging]);
};

export const beforeUpdateMessageList = (fn: (list: TMessage[]) => TMessage[]) => {
  beforeUpdateMessageListStack.push(fn);
  return () => {
    beforeUpdateMessageListStack.splice(beforeUpdateMessageListStack.indexOf(fn), 1);
  };
};
export {
  ChatKeyProvider,
  MessageHistoryPagingProvider,
  MessageListLoadingProvider,
  MessageListProvider,
  useChatKey,
  useMessageHistoryPaging,
  useMessageList,
  useMessageListLoading,
  useUpdateMessageList,
};
