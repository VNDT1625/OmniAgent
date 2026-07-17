/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import FlexFullContainer from '@renderer/components/layout/FlexFullContainer';
import MessageList from '@renderer/pages/conversation/Messages/MessageList';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  MessageHistoryPagingProvider,
  useMessageLstCache,
} from '@renderer/pages/conversation/Messages/hooks';
import HOC from '@renderer/utils/ui/HOC';
import React, { useEffect } from 'react';
import LocalImageView from '@renderer/components/media/LocalImageView';
import RemoteSendBox from './RemoteSendBox';

const RemoteChat: React.FC<{
  conversation_id: string;
  workspace: string;
  cron_job_id?: string;
  hideSendBox?: boolean;
  emptySlot?: React.ReactNode;
  beforeSendBox?: React.ReactNode;
  loadedSkills?: string[];
}> = ({ conversation_id, workspace, cron_job_id, hideSendBox, emptySlot, beforeSendBox, loadedSkills }) => {
  useMessageLstCache(conversation_id);
  const updateLocalImage = LocalImageView.useUpdateLocalImage();
  useEffect(() => {
    updateLocalImage({ root: workspace });
  }, [workspace]);
  return (
    <ConversationProvider
      value={{ conversation_id: conversation_id, workspace, type: 'remote', cron_job_id, hideSendBox, loadedSkills }}
    >
      <div className='flex-1 flex flex-col px-20px min-h-0'>
        <FlexFullContainer>
          <MessageList className='flex-1' emptySlot={emptySlot}></MessageList>
        </FlexFullContainer>
        {beforeSendBox && <div className='w-full min-w-0 shrink-0 px-16px box-border'>{beforeSendBox}</div>}
        {!hideSendBox && <RemoteSendBox conversation_id={conversation_id} />}
      </div>
    </ConversationProvider>
  );
};

export default HOC.Wrapper(MessageListProvider, MessageListLoadingProvider, MessageHistoryPagingProvider)(RemoteChat);
