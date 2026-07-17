/** Renderer-safe compatibility facade for the canonical Company IPC contract. */
import { company } from '@/common/adapter/ipcBridge';
import type { ConversationEventEnvelope } from '@process/company/companyBridge';

export const companyClient = company;

export const onCompanyConversationEvent = (listener: (envelope: ConversationEventEnvelope) => void): (() => void) =>
  company.conversationEvent.on(listener);
