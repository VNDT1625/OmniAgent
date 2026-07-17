/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ExperimentalCoreEvent } from '@process/experimentalCore/experimentalCoreRuntime';
import { NativeConversationRepository } from './repository';
import { NativeConversationService, type NativeConversationRuntime } from './service';

let registered = false;

/** Registers the production IPC contract used by the existing Conversation UI. */
export const registerNativeConversationBridge = (input: {
  filePath: string;

  legacyDatabasePath?: string;
  runtime: NativeConversationRuntime;
  subscribeCore: (listener: (event: ExperimentalCoreEvent) => void) => () => void;
}): NativeConversationService => {
  if (registered) throw new Error('Native conversation bridge is already registered.');
  registered = true;
  const service = new NativeConversationService(
    new NativeConversationRepository(input.filePath, input.legacyDatabasePath),
    input.runtime,
    {
      response: (event) => ipcBridge.conversation.responseStream.emit(event),
      turnCompleted: (event) => ipcBridge.conversation.turnCompleted.emit(event),
      listChanged: (event) => ipcBridge.conversation.listChanged.emit(event),
    }
  );
  void service.initialize().catch((error) => console.error('[NativeConversation] Initialization failed:', error));
  input.subscribeCore((event) => service.handleCoreEvent(event));

  ipcBridge.conversation.create.provider((params) => service.create(params));
  ipcBridge.conversation.createWithConversation.provider(({ conversation }) => service.cloneConversation(conversation));
  ipcBridge.conversation.get.provider(({ id }) => service.get(id));
  ipcBridge.conversation.remove.provider(({ id }) => service.remove(id));
  ipcBridge.conversation.update.provider(({ id, updates, merge_extra }) => service.update(id, updates, merge_extra));
  ipcBridge.conversation.reset.provider(({ id }) => (id ? service.reset(id) : Promise.resolve()));
  ipcBridge.conversation.warmup.provider(() => service.initialize());
  ipcBridge.conversation.stop.provider(({ conversation_id }) => service.cancel(conversation_id));
  ipcBridge.conversation.activeCount.provider(() => Promise.resolve({ count: service.activeCount() }));
  ipcBridge.conversation.sendMessage.provider((params) => service.send(params));

  ipcBridge.database.getUserConversations.provider(({ cursor, limit }) => service.list(cursor, limit));
  ipcBridge.database.getConversationMessages.provider(({ conversation_id, page, page_size, order }) =>
    service.history(conversation_id, page, page_size, order)
  );
  ipcBridge.database.getConversationMessage.provider(({ conversation_id, message_id }) =>
    service.message(conversation_id, message_id)
  );
  return service;
};
