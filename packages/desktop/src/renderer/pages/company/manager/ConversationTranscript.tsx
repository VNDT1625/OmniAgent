/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conversation transcript (Requirement 3 "Phần 2"): the running log of who said
 * what to whom. Directives (boss → employee) and reports (employee → boss) are
 * visually distinguished so the chain of command reads at a glance.
 *
 * Renderer-only. Arco + UnoCSS semantic tokens; all copy via i18n.
 */

import type { ConversationMessage, Participant } from '@process/company/companyConversation';
import { Comment, Right } from '@icon-park/react';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/** One transcript line. */
const Line: React.FC<{ message: ConversationMessage; nameById: Record<string, string> }> = ({ message, nameById }) => {
  const fromName = nameById[message.fromId] ?? message.fromId;
  const toName = nameById[message.toId] ?? message.toId;
  const isDirective = message.kind === 'directive';
  const selfAddressed = message.fromId === message.toId;

  return (
    <div className='flex flex-col gap-4px'>
      <div className='flex items-center gap-6px text-11px text-t-tertiary'>
        <span className='font-600 text-t-secondary'>{fromName}</span>
        {!selfAddressed && (
          <>
            <Right theme='outline' size='11' />
            <span>{toName}</span>
          </>
        )}
      </div>
      <div
        className={`rd-10px px-12px py-8px text-13px leading-relaxed ${
          isDirective
            ? 'bg-primary-1 text-t-primary border border-solid border-primary-3'
            : 'bg-1 text-t-primary border border-solid border-b-1'
        }`}
      >
        {message.content}
      </div>
    </div>
  );
};

/** The scrollable transcript. */
const ConversationTranscript: React.FC<{
  messages: ConversationMessage[];
  participants: Participant[];
}> = ({ messages, participants }) => {
  const { t } = useTranslation();
  const endRef = useRef<HTMLDivElement | null>(null);

  const nameById = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of participants) map[p.id] = p.name;
    return map;
  }, [participants]);

  // Keep the latest line in view as the dialogue streams in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className='flex flex-col items-center gap-10px py-32px text-center'>
        <span className='size-40px flex-center rd-full bg-fill-2 text-t-tertiary'>
          <Comment theme='outline' size='20' />
        </span>
        <p className='m-0 max-w-320px text-12px text-t-tertiary'>{t('company.conversation.transcriptEmpty')}</p>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-12px'>
      {messages.map((m) => (
        <Line key={m.id} message={m} nameById={nameById} />
      ))}
      <div ref={endRef} />
    </div>
  );
};

export default ConversationTranscript;
