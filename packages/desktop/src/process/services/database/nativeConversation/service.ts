/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  IConversationListChangedEvent,
  IConversationTurnCompletedEvent,
  ICreateConversationParams,
  IResponseMessage,
  ISendMessageResult,
} from '@/common/adapter/ipcBridge';
import type { TMessage } from '@/common/chat/chatLib';
import type { TChatConversation, TProviderWithModel } from '@/common/config/storage';
import type {
  ExperimentalCoreContextIdentity,
  ExperimentalCoreEvent,
} from '@process/experimentalCore/experimentalCoreRuntime';
import type { ExperimentalPermissionMode } from '@process/experimentalCore/experimentalCoreProtocol';
import type { NativeConversationRepository } from './repository';

export type NativeConversationRuntime = {
  start: (
    requestId: string,
    targetId: string,
    prompt: string,
    workspace: string,
    modelKey: string | undefined,
    permissionMode: ExperimentalPermissionMode,
    sessionId: string,
    companyId?: string,
    contextIdentity?: ExperimentalCoreContextIdentity
  ) => { requestId: string; sessionId: string };
  cancel: (requestId: string) => Promise<boolean>;
};

export type NativeConversationEvents = {
  response: (message: IResponseMessage) => void;
  turnCompleted: (event: IConversationTurnCompletedEvent) => void;
  listChanged: (event: IConversationListChangedEvent) => void;
};

export type NativeSendMessageParams = {
  input: string;
  model_input?: string;
  conversation_id: string;
  files?: string[];
  loading_id?: string;
  inject_skills?: string[];
};

type ActiveTurn = {
  conversationId: string;
  requestId: string;
  assistantMessageId: string;
  assistantText: string;
};

const clone = <T>(value: T): T => structuredClone(value);

const providerModel = (conversation: TChatConversation): TProviderWithModel | undefined =>
  'model' in conversation ? (conversation.model as TProviderWithModel | undefined) : undefined;

const workspaceFor = (conversation: TChatConversation): string =>
  typeof conversation.extra?.workspace === 'string' ? conversation.extra.workspace : '';

const modelKeyFor = (conversation: TChatConversation): string | undefined => {
  const extra = conversation.extra as Record<string, unknown>;
  for (const value of [
    extra.tomny_core_model_key,
    extra.current_model_id,
    extra.codexModel,
    extra.codex_model,
    providerModel(conversation)?.use_model,
  ]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
};

const targetFor = (conversation: TChatConversation): string => {
  const nativeTarget = (conversation.extra as Record<string, unknown>).tomny_core_target_id;
  if (typeof nativeTarget === 'string' && nativeTarget.trim()) return nativeTarget;
  if (conversation.type === 'aionrs') return 'tomny';
  if (conversation.type === 'codex') return 'codex';
  if (conversation.type === 'remote') {
    const id = (conversation.extra as Record<string, unknown>).remote_agent_id;
    return typeof id === 'string' && id.trim() ? id : 'remote';
  }
  if (conversation.type === 'openclaw-gateway') return 'openclaw';
  const backend = (conversation.extra as Record<string, unknown>).backend;
  return typeof backend === 'string' && backend.trim() ? backend : 'tomny';
};

const permissionFor = (conversation: TChatConversation): ExperimentalPermissionMode => {
  const sandbox = (conversation.extra as Record<string, unknown>).sandboxMode;
  if (sandbox === 'read-only' || sandbox === 'workspace-write') return sandbox;
  if (sandbox === 'danger-full-access') return 'full-access';
  return 'workspace-write';
};

const textMessage = (
  id: string,
  conversationId: string,
  content: string,
  position: 'left' | 'right',
  createdAt: number,
  status: TMessage['status'] = 'finish'
): TMessage => ({
  id,
  msg_id: id,
  type: 'text',
  conversation_id: conversationId,
  position,
  created_at: createdAt,
  status,
  content: { content },
});

/** Owns the normal chat lifecycle without any AionCore HTTP/WebSocket dependency. */
export class NativeConversationService {
  private readonly activeByConversation = new Map<string, ActiveTurn>();
  private readonly activeByRequest = new Map<string, ActiveTurn>();

  private readonly eventQueues = new Map<string, Promise<void>>();

  public constructor(
    private readonly repository: NativeConversationRepository,
    private readonly runtime: NativeConversationRuntime,
    private readonly events: NativeConversationEvents
  ) {}

  public initialize(): Promise<void> {
    return this.repository.initialize();
  }

  public async create(params: ICreateConversationParams): Promise<TChatConversation> {
    const now = Date.now();
    const conversation = {
      id: params.id?.trim() || crypto.randomUUID(),
      created_at: now,
      modified_at: now,
      name: params.name?.trim() || 'New conversation',
      type: params.type,
      extra: {
        ...clone(params.extra),
        tomny_core_session_id: params.id?.trim() || undefined,
      },
      model: clone(params.model),
      status: 'pending',
      source: 'aionui',
    } as TChatConversation;
    (conversation.extra as Record<string, unknown>).tomny_core_session_id = conversation.id;
    (conversation.extra as Record<string, unknown>).tomny_core_target_id = targetFor(conversation);
    (conversation.extra as Record<string, unknown>).tomny_core_model_key = modelKeyFor(conversation);
    await this.repository.saveConversation(conversation);
    this.events.listChanged({ conversation_id: conversation.id, action: 'created', source: conversation.source });
    return clone(conversation);
  }

  public async cloneConversation(conversation: TChatConversation): Promise<TChatConversation> {
    const copy = clone(conversation);
    (copy.extra as Record<string, unknown>).tomny_core_session_id = copy.id;
    await this.repository.saveConversation(copy);
    this.events.listChanged({ conversation_id: copy.id, action: 'created', source: copy.source });
    return copy;
  }

  public get(id: string): Promise<TChatConversation | undefined> {
    return this.repository.getConversation(id);
  }

  public async list(
    cursor?: string,
    limit = 50
  ): Promise<{ items: TChatConversation[]; total: number; has_more: boolean }> {
    const all = await this.repository.listConversations();
    const start = cursor ? Math.max(0, all.findIndex((item) => item.id === cursor) + 1) : 0;
    const size = Math.max(1, Math.min(200, Math.trunc(limit)));
    return { items: all.slice(start, start + size), total: all.length, has_more: start + size < all.length };
  }

  public async update(id: string, updates: Partial<TChatConversation>, mergeExtra = false): Promise<boolean> {
    const current = await this.repository.getConversation(id);
    if (!current) return false;
    const next = {
      ...current,
      ...clone(updates),
      id,
      modified_at: Date.now(),
      ...(mergeExtra && updates.extra ? { extra: { ...current.extra, ...clone(updates.extra) } } : {}),
    } as TChatConversation;
    await this.repository.saveConversation(next);
    this.events.listChanged({ conversation_id: id, action: 'updated', source: next.source });
    return true;
  }

  public async remove(id: string): Promise<boolean> {
    await this.cancel(id);
    const removed = await this.repository.removeConversation(id);
    if (removed) this.events.listChanged({ conversation_id: id, action: 'deleted' });
    return removed;
  }

  public async reset(id: string): Promise<void> {
    await this.cancel(id);
    await this.repository.clearMessages(id);
    const conversation = await this.repository.getConversation(id);
    if (!conversation) return;
    await this.update(id, {
      status: 'pending',
      extra: { ...conversation.extra, tomny_core_session_id: crypto.randomUUID() },
    } as Partial<TChatConversation>);
  }

  public async history(
    conversationId: string,
    page = 1,
    pageSize = 50,
    order = 'asc'
  ): Promise<{ items: TMessage[]; total: number; has_more: boolean }> {
    const all = await this.repository.listMessages(conversationId);
    const ordered = order.toLowerCase() === 'desc' ? all.toReversed() : all;
    const size = Math.max(1, Math.min(500, Math.trunc(pageSize)));
    const start = Math.max(0, Math.trunc(page) - 1) * size;
    return { items: ordered.slice(start, start + size), total: all.length, has_more: start + size < all.length };
  }

  public async message(conversationId: string, messageId: string): Promise<TMessage> {
    const result = await this.repository.getMessage(conversationId, messageId);
    if (!result) throw new Error(`Message not found: ${messageId}`);
    return result;
  }

  public activeCount(): number {
    return this.activeByRequest.size;
  }

  public async send(params: NativeSendMessageParams): Promise<ISendMessageResult> {
    if (this.activeByConversation.has(params.conversation_id)) {
      throw new Error('This conversation is already generating a response.');
    }
    const input = params.input.trim();
    if (!input) throw new Error('Message cannot be empty.');
    const conversation = await this.repository.getConversation(params.conversation_id);
    if (!conversation) throw new Error(`Conversation not found: ${params.conversation_id}`);
    const workspace = workspaceFor(conversation);
    if (!workspace.trim()) throw new Error('Select a workspace before starting the agent.');

    const now = Date.now();
    const userMessageId = params.loading_id?.trim() || crypto.randomUUID();
    const userMessage = textMessage(userMessageId, conversation.id, input, 'right', now);
    await this.repository.saveMessage(userMessage);
    this.events.response({
      type: 'user_content',
      data: { content: input },
      msg_id: userMessageId,
      conversation_id: conversation.id,
      created_at: now,
    });

    const requestId = crypto.randomUUID();
    const active: ActiveTurn = {
      conversationId: conversation.id,
      requestId,
      assistantMessageId: `${requestId}:assistant`,
      assistantText: '',
    };
    this.activeByConversation.set(conversation.id, active);
    this.activeByRequest.set(requestId, active);
    await this.update(conversation.id, { status: 'running' } as Partial<TChatConversation>);

    const prompt = [
      params.model_input?.trim() || input,
      ...(params.files ?? []).map((file) => `\n[Attached file: ${file}]`),
    ].join('');
    try {
      this.runtime.start(
        requestId,
        targetFor(conversation),
        prompt,
        workspace,
        modelKeyFor(conversation),
        permissionFor(conversation),
        ((conversation.extra as Record<string, unknown>).tomny_core_session_id as string | undefined) ??
          conversation.id,
        undefined,
        { surface: (conversation.extra as Record<string, unknown>).surface as string | undefined }
      );
    } catch (error) {
      this.activeByConversation.delete(conversation.id);
      this.activeByRequest.delete(requestId);
      await this.update(conversation.id, { status: 'finished' } as Partial<TChatConversation>);
      throw error;
    }
    return { msg_id: userMessageId };
  }

  public async cancel(conversationId: string): Promise<void> {
    const active = this.activeByConversation.get(conversationId);
    if (active) await this.runtime.cancel(active.requestId);
  }

  public handleCoreEvent(event: ExperimentalCoreEvent): void {
    const active = this.activeByRequest.get(event.requestId);
    if (!active) return;
    const previous = this.eventQueues.get(event.requestId) ?? Promise.resolve();
    const next = previous
      .then(() => this.processCoreEvent(active, event))
      .catch((error) => console.error('[NativeConversation] Failed to persist core event:', error));
    this.eventQueues.set(event.requestId, next);
    void next.finally(() => {
      if (this.eventQueues.get(event.requestId) === next) this.eventQueues.delete(event.requestId);
    });
  }

  private async processCoreEvent(active: ActiveTurn, event: ExperimentalCoreEvent): Promise<void> {
    const base = {
      msg_id: active.assistantMessageId,
      conversation_id: active.conversationId,
      created_at: event.timestamp,
    };
    if (event.type === 'started') {
      this.events.response({ ...base, type: 'start', data: null });
      return;
    }
    if (event.type === 'delta') {
      if (event.mode === 'replace') active.assistantText = event.text ?? '';
      else active.assistantText += event.text ?? '';
      this.events.response({
        ...base,
        type: 'content',
        data: { content: event.text ?? '', ...(event.mode === 'replace' ? { replace: true } : {}) },
        replace: event.mode === 'replace',
      });
      await this.repository.saveMessage(
        textMessage(
          active.assistantMessageId,
          active.conversationId,
          active.assistantText,
          'left',
          event.timestamp,
          'work'
        )
      );
      return;
    }
    if (event.type === 'thinking' || event.type === 'step' || event.type === 'status') {
      this.events.response({
        ...base,
        type: 'thinking',
        data: { content: event.text ?? '', subject: event.type === 'step' ? 'Step' : undefined, status: 'thinking' },
      });
      return;
    }
    if (event.type === 'tool-call' || event.type === 'tool-result') {
      this.events.response({
        ...base,
        type: 'agent_status',
        data: {
          status: 'session_active',
          subject: event.tool ?? 'tool',
          description: event.text ?? '',
          outcome: event.outcome,
        },
      });
      return;
    }
    if (event.type === 'permission') {
      this.events.response({
        ...base,
        type: 'permission',
        data: {
          id: event.permissionId,
          call_id: event.callId,
          description: event.detail ?? event.text ?? '',
          options: [],
        },
      });
      return;
    }
    if (event.type === 'completed') {
      await this.finish(active, event, 'finished');
      return;
    }
    if (event.type === 'cancelled') {
      await this.finish(active, event, 'stopped');
      return;
    }
    if (event.type === 'error') {
      this.events.response({ ...base, type: 'error', data: { message: event.text ?? 'Agent failed.' } });
      await this.finish(active, event, 'error');
    }
  }

  private async finish(
    active: ActiveTurn,
    event: ExperimentalCoreEvent,
    state: IConversationTurnCompletedEvent['state']
  ): Promise<void> {
    if (active.assistantText) {
      await this.repository.saveMessage(
        textMessage(
          active.assistantMessageId,
          active.conversationId,
          active.assistantText,
          'left',
          event.timestamp,
          state === 'error' ? 'error' : 'finish'
        )
      );
    }
    this.activeByConversation.delete(active.conversationId);
    this.activeByRequest.delete(active.requestId);
    await this.update(active.conversationId, { status: 'finished' } as Partial<TChatConversation>);
    this.events.response({
      type: 'finish',
      data: { state },
      msg_id: active.assistantMessageId,
      conversation_id: active.conversationId,
      created_at: event.timestamp,
    });
    const conversation = await this.repository.getConversation(active.conversationId);
    this.events.turnCompleted({
      session_id: active.conversationId,
      status: 'finished',
      state,
      detail: event.text ?? '',
      can_send_message: true,
      runtime: { has_task: false, is_processing: false, pending_confirmations: 0, db_status: 'finished' },
      workspace: conversation ? workspaceFor(conversation) : '',
      model: {
        platform: providerModel(conversation as TChatConversation)?.platform ?? '',
        name: providerModel(conversation as TChatConversation)?.name ?? '',
        use_model: providerModel(conversation as TChatConversation)?.use_model ?? '',
      },
      last_message: {
        id: active.assistantMessageId,
        type: 'text',
        content: { content: active.assistantText },
        status: state === 'error' ? 'error' : 'finish',
        created_at: event.timestamp,
      },
    });
  }
}
