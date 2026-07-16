/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input, Modal, Switch, Tooltip } from '@arco-design/web-react';
import { Click, CloseSmall, DeleteFour, PauseOne, Right, Robot, Setting, SwitchThemes } from '@icon-park/react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browserClient } from '../browserBridgeClient';
import type { ChatMessage } from '../useAgentChat';

const { TextArea } = Input;

/**
 * The web-agent chat dock (Requirement 1, criterion 1.2).
 *
 * Renders the conversation transcript for the active tab — user prompts, the
 * agent's running tool-step narration, and its final answers — plus a composer
 * to send a new instruction. Heading carries a "move side" and "close" control
 * so the user can re-dock (left/right) or hide the panel. Presentational: all
 * state + actions are passed in from {@link useAgentChat} / the page.
 */
const AgentChatPanel: React.FC<{
  messages: ChatMessage[];
  status: 'idle' | 'running';
  /** Whether a model is selected; without one the composer is disabled. */
  ready: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onClear: () => void;
  onClose: () => void;
  onSwapSide: () => void;
  /** Whether the user grants the agent control of the visible tab (interactive mode). */
  allowControl: boolean;
  onAllowControlChange: (value: boolean) => void;
  /** Suspend/resume the native browser view while a popup is open (z-index fix). */
  onOverlayOpen?: () => void;
  onOverlayClose?: () => void;
}> = ({
  messages,
  status,
  ready,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onClear,
  onClose,
  onSwapSide,
  allowControl,
  onAllowControlChange,
  onOverlayOpen,
  onOverlayClose,
}) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [persona, setPersona] = useState('');
  const [personaSaving, setPersonaSaving] = useState(false);

  // Auto-scroll to the newest message as the transcript grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Load the persona when the editor opens.
  useEffect(() => {
    if (!personaOpen) {
      onOverlayClose?.();
      return;
    }
    onOverlayOpen?.();
    let alive = true;
    browserClient
      .getPersona()
      .then((value) => {
        if (alive) setPersona(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [personaOpen, onOverlayOpen, onOverlayClose]);

  const savePersona = async () => {
    setPersonaSaving(true);
    try {
      await browserClient.setPersona(persona);
      setPersonaOpen(false);
    } catch {
      // ignore — the modal stays open so the user can retry
    } finally {
      setPersonaSaving(false);
    }
  };

  const running = status === 'running';

  return (
    <section className='flex flex-col h-full min-h-0 w-full bg-bg-2 b b-solid b-line-2 rd-12px overflow-hidden'>
      <header className='flex items-center justify-between gap-8px px-14px py-10px b-b b-b-solid b-line-2 shrink-0'>
        <span className='flex items-center gap-8px text-t-primary'>
          <Robot theme='outline' size='17' className='text-primary' />
          <span className='text-14px font-600'>{t('browser.chat.title')}</span>
        </span>
        <span className='flex items-center gap-2px'>
          <Tooltip content={t('browser.chat.persona')} position='bottom'>
            <Button
              type='text'
              size='mini'
              aria-label={t('browser.chat.persona')}
              icon={<Setting theme='outline' size='15' />}
              onClick={() => setPersonaOpen(true)}
            />
          </Tooltip>
          <Tooltip content={t('browser.chat.swapSide')} position='bottom'>
            <Button
              type='text'
              size='mini'
              aria-label={t('browser.chat.swapSide')}
              icon={<SwitchThemes theme='outline' size='15' />}
              onClick={onSwapSide}
            />
          </Tooltip>
          <Tooltip content={t('browser.chat.clear')} position='bottom'>
            <Button
              type='text'
              size='mini'
              aria-label={t('browser.chat.clear')}
              icon={<DeleteFour theme='outline' size='15' />}
              onClick={onClear}
            />
          </Tooltip>
          <Tooltip content={t('browser.chat.close')} position='bottom'>
            <Button
              type='text'
              size='mini'
              aria-label={t('browser.chat.close')}
              icon={<CloseSmall theme='outline' size='16' />}
              onClick={onClose}
            />
          </Tooltip>
        </span>
      </header>

      <div ref={scrollRef} className='flex-1 min-h-0 overflow-y-auto px-14px py-12px flex flex-col gap-10px'>
        {messages.length === 0 ? (
          <div className='flex flex-col items-center justify-center h-full gap-10px text-center px-12px'>
            <span className='size-44px flex-center rd-full bg-fill-2 text-primary'>
              <Robot theme='outline' size='22' />
            </span>
            <p className='m-0 text-14px font-600 text-t-primary'>{t('browser.chat.emptyTitle')}</p>
            <p className='m-0 max-w-260px text-13px text-t-secondary leading-relaxed'>{t('browser.chat.emptyHint')}</p>
          </div>
        ) : (
          messages.map((message) => <ChatBubble key={message.id} message={message} />)
        )}
        {running && (
          <div className='flex items-center gap-8px text-12px text-t-tertiary'>
            <span className='size-6px rd-full bg-primary animate-pulse' />
            {t('browser.chat.working')}
          </div>
        )}
      </div>

      <footer className='shrink-0 p-12px b-t b-t-solid b-line-2 flex flex-col gap-8px'>
        <TextArea
          value={draft}
          disabled={!ready}
          autoSize={{ minRows: 2, maxRows: 5 }}
          placeholder={ready ? t('browser.chat.placeholder') : t('browser.chat.pickModelFirst')}
          onChange={onDraftChange}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!running) onSend();
            }
          }}
        />
        <div className='flex items-center justify-between gap-8px'>
          <Tooltip
            content={allowControl ? t('browser.chat.controlOnHint') : t('browser.chat.controlOffHint')}
            position='top'
          >
            <span className='flex items-center gap-6px text-12px text-t-tertiary'>
              <Click theme='outline' size='14' className={allowControl ? 'text-primary' : ''} />
              <span>{t('browser.chat.allowControl')}</span>
              <Switch
                size='small'
                aria-label={t('browser.chat.allowControl')}
                checked={allowControl}
                disabled={!ready}
                onChange={onAllowControlChange}
              />
            </span>
          </Tooltip>
          {running ? (
            <Button
              type='outline'
              status='danger'
              size='small'
              icon={<PauseOne theme='outline' size='14' />}
              onClick={onStop}
            >
              {t('browser.chat.stop')}
            </Button>
          ) : (
            <Button
              type='primary'
              size='small'
              disabled={!ready || draft.trim().length === 0}
              icon={<Right theme='outline' size='14' />}
              onClick={onSend}
            >
              {t('browser.chat.send')}
            </Button>
          )}
        </div>
      </footer>

      <Modal
        title={t('browser.chat.personaTitle')}
        visible={personaOpen}
        onCancel={() => setPersonaOpen(false)}
        onOk={() => void savePersona()}
        confirmLoading={personaSaving}
        okText={t('browser.chat.personaSave')}
        cancelText={t('browser.chat.personaCancel')}
        unmountOnExit
      >
        <p className='m-0 mb-8px text-13px text-t-secondary leading-relaxed'>{t('browser.chat.personaHint')}</p>
        <TextArea
          value={persona}
          autoSize={{ minRows: 4, maxRows: 10 }}
          placeholder={t('browser.chat.personaPlaceholder')}
          onChange={setPersona}
        />
      </Modal>
    </section>
  );
};

/** Render one transcript entry as a styled bubble / step line. */
const ChatBubble: React.FC<{ message: ChatMessage }> = ({ message }) => {
  const { t } = useTranslation();
  if (message.kind === 'user') {
    return (
      <div className='self-end max-w-85% px-12px py-8px rd-10px rd-br-2px bg-primary text-white text-14px leading-relaxed whitespace-pre-wrap break-words'>
        {message.text}
      </div>
    );
  }
  if (message.kind === 'assistant') {
    return (
      <div className='self-start max-w-90% px-12px py-8px rd-10px rd-bl-2px bg-fill-2 text-t-primary text-14px leading-relaxed whitespace-pre-wrap break-words'>
        {message.text}
      </div>
    );
  }
  if (message.kind === 'error') {
    return (
      <div className='self-start max-w-90% px-12px py-8px rd-10px bg-danger-light-1 text-danger text-13px leading-relaxed break-words'>
        {message.text}
      </div>
    );
  }
  // step
  const dot =
    message.status === 'ok' ? 'bg-success' : message.status === 'fail' ? 'bg-danger' : 'bg-primary animate-pulse';
  return (
    <div className='self-start flex items-center gap-8px pl-6px text-12px text-t-tertiary font-mono'>
      <span className={`size-6px rd-full shrink-0 ${dot}`} />
      <span className='break-all'>{message.summary}</span>
      {message.status === 'fail' && <span className='text-danger'>· {t('browser.chat.stepFailed')}</span>}
    </div>
  );
};

export default AgentChatPanel;
