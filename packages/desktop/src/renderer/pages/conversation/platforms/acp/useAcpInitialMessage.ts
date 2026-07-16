/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { AgentStreamErrorInfo } from '@/common/chat/chatLib';
import type { TMessage } from '@/common/chat/chatLib';
import { parseError, uuid } from '@/common/utils';
import { ideClient } from '@/renderer/pages/studio/ide/ideClient';
import { buildPlanningGuard } from '@/renderer/pages/studio/ide/planningGuard';
import { withResponseLanguageDirective } from '@/renderer/services/i18n/responseLanguage';
import { emitter } from '@/renderer/utils/emitter';
import { buildDisplayMessage } from '@/renderer/utils/file/messageFiles';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

type UseAcpInitialMessageParams = {
  conversation_id: string;
  backend: string;
  workspacePath?: string;
  setAiProcessing: (value: boolean) => void;
  checkAndUpdateTitle: (conversation_id: string, input: string) => void;
  addOrUpdateMessage: (message: TMessage, prepend?: boolean) => void;
};

const buildSendFailureError = (error: unknown, message: string): AgentStreamErrorInfo => {
  if (isBackendHttpError(error) && error.code === 'BAD_GATEWAY') {
    return {
      message,
      code: 'UNKNOWN_UPSTREAM_ERROR',
      ownership: 'unknown_upstream',
      detail: message,
      retryable: true,
      feedback_recommended: true,
    };
  }

  return {
    message,
    code: 'AIONUI_INTERNAL_ERROR',
    ownership: 'aionui',
    detail: message,
    retryable: true,
    feedback_recommended: true,
  };
};

/**
 * Side-effect-only hook that checks sessionStorage for an initial message
 * and sends it when the ACP conversation first mounts.
 */
export const useAcpInitialMessage = ({
  conversation_id,
  backend: _backend,
  workspacePath,
  setAiProcessing,
  checkAndUpdateTitle,
  addOrUpdateMessage,
}: UseAcpInitialMessageParams): void => {
  const { t } = useTranslation();

  useEffect(() => {
    const storageKey = `acp_initial_message_${conversation_id}`;
    const storedMessage = sessionStorage.getItem(storageKey);

    if (!storedMessage) return;

    // Clear immediately to prevent duplicate sends (e.g., if component remounts while sendMessage is pending)
    sessionStorage.removeItem(storageKey);

    const sendInitialMessage = async () => {
      try {
        const initialMessage = JSON.parse(storedMessage);
        const input = typeof initialMessage.input === 'string' ? initialMessage.input : '';
        const files = Array.isArray(initialMessage.files) ? initialMessage.files : [];
        const displayMessage = buildDisplayMessage(input, files, workspacePath || '');

        setAiProcessing(true);

        // POST first to obtain the server-assigned msg_id, then render the
        // optimistic user bubble with that canonical id. Doing it in this
        // order prevents `useMessageLstCache` from treating the optimistic
        // row as a separate "streaming-only" entry when the DB load races
        // with sendMessage — which previously produced two duplicated user
        // bubbles on the first conversation render.
        void checkAndUpdateTitle(conversation_id, input);
        let outgoingMessage = displayMessage;
        if (workspacePath) {
          const contextResult = await ideClient.kgContext(workspacePath, input, [], true).catch((): null => null);
          const pack = contextResult?.ok ? contextResult.data : null;
          if (pack && pack.slices.length > 0) {
            outgoingMessage = `${pack.renderedContext}\n\n${displayMessage}`;
            addOrUpdateMessage(
              {
                id: uuid(),
                msg_id: uuid(),
                type: 'tips',
                position: 'center',
                conversation_id,
                created_at: Date.now(),
                content: {
                  type: 'success',
                  content: t('conversation.contextPack.loaded', { count: pack.sliceCount }),
                  kind: 'context_pack',
                  contextPack: {
                    sliceCount: pack.sliceCount,
                    truncated: pack.truncated,
                    files: pack.slices.map((slice) => ({
                      path: slice.path,
                      reason: slice.reason,
                      layer: slice.layer,
                      score: slice.score,
                    })),
                  },
                },
              },
              true
            );
          }
        }
        if (workspacePath) {
          outgoingMessage = await buildPlanningGuard(workspacePath, outgoingMessage);
        }
        // Keep the model replying in the app's active language even though the
        // codebase/files are mostly English (the visible bubble keeps raw text).
        outgoingMessage = withResponseLanguageDirective(outgoingMessage, conversation_id);
        const { msg_id } = await ipcBridge.acpConversation.sendMessage.invoke({
          input: outgoingMessage,
          conversation_id: conversation_id,
          files,
        });

        // Use add=false (compose mode) so composeMessageWithIndex can de-dup
        // by msg_id — this prevents a duplicate bubble if useMessageLstCache
        // already inserted the DB row for this same msg_id.
        addOrUpdateMessage({
          id: msg_id,
          msg_id,
          type: 'text',
          position: 'right',
          conversation_id,
          content: { content: displayMessage },
          created_at: Date.now(),
        });

        // Initial message sent successfully
        emitter.emit('chat.history.refresh');
      } catch (error) {
        const errorMessageText = parseError(error) ?? t('common.unknownError');
        console.error('[useAcpInitialMessage] Error sending initial message:', error);
        console.error('[useAcpInitialMessage] Error details:', {
          name: (error as Error)?.name,
          message: errorMessageText,
          conversation_id,
        });

        const errorMessage: TMessage = {
          id: uuid(),
          msg_id: uuid(),
          conversation_id: conversation_id,
          type: 'tips',
          position: 'center',
          content: {
            content: errorMessageText,
            type: 'error',
            error: buildSendFailureError(error, errorMessageText),
          },
          created_at: Date.now() + 2,
        };
        addOrUpdateMessage(errorMessage, true);
        setAiProcessing(false); // Stop loading state on error
      }
    };

    sendInitialMessage().catch((error) => {
      console.error('Failed to send initial message:', error);
    });
  }, [addOrUpdateMessage, checkAndUpdateTitle, conversation_id, setAiProcessing, t, workspacePath]);
};
