/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `DocAssistantPanel` — the AI side-panel of the Studio editor.
 *
 * Rewritten (Plan A): instead of the previous bespoke engines (a one-shot
 * completion + a hand-rolled ReAct loop that frequently broke), the panel now
 * embeds the MAIN {@link ChatConversation} — the same component the routed
 * `/conversation/:id` page renders. The chat is therefore functionally
 * identical to the main chat: streaming, markdown, preview, full CLI-agent tool
 * use, and global history.
 *
 * The chat is a single real conversation (see {@link useDocChat}) pinned to the
 * open file's folder (`extra.workspace`), so a CLI agent (Claude Code / Codex /
 * Gemini …) runs with that folder as its cwd. When the built-in Office-editor
 * MCP server is registered, it is attached to the conversation so the agent can
 * edit the LIVE document with fast, formatting-preserving `office_*` tools.
 *
 * Before a chat is started the panel shows an agent picker (CLI agents + preset
 * assistants), mirroring the IDE chat's "+" menu. Picking one creates the
 * conversation and embeds it.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Dropdown, Menu, Spin, Tooltip } from '@arco-design/web-react';
import { CloseSmall, Plus, Refresh, Robot } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { TChatConversation } from '@/common/config/storage';
import { useConversationAgents } from '@/renderer/pages/conversation/hooks/useConversationAgents';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import ChatConversation from '@/renderer/pages/conversation/components/ChatConversation';
import { useDocChat, type DocChatLauncher } from '../hooks/useDocChat';

type DocAssistantPanelProps = {
  /** Absolute path of the open file (keys the chat conversation). */
  filePath: string;
  fileName: string;
  /** Close (hide) the assistant panel. */
  onClose: () => void;
};

const DocAssistantPanel: React.FC<DocAssistantPanelProps> = ({ filePath, fileName, onClose }) => {
  const { t, i18n } = useTranslation();
  const chat = useDocChat(filePath);
  const { cliAgents, presetAssistants, isLoading: loadingAgents } = useConversationAgents();
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <section className='flex flex-col h-full min-h-0 w-full bg-2 border border-b-1 rd-12px overflow-hidden'>
      <header className='flex items-center justify-between gap-8px px-14px py-10px border-b border-b-1 shrink-0'>
        <span className='flex items-center gap-8px text-t-primary min-w-0'>
          <Robot theme='outline' size='17' className='text-primary' />
          <span className='text-14px font-600 truncate'>{t('studio.assistant.title')}</span>
        </span>
        <span className='flex items-center gap-2px shrink-0'>
          {chat.conversationId ? (
            <Tooltip content={t('studio.assistant.newChat')} mini>
              <Button
                type='text'
                size='mini'
                aria-label={t('studio.assistant.newChat')}
                icon={<Refresh theme='outline' size='15' />}
                onClick={() => void chat.reset()}
              />
            </Tooltip>
          ) : null}
          <Tooltip content={t('studio.assistant.close')} mini>
            <Button
              type='text'
              size='mini'
              aria-label={t('studio.assistant.close')}
              icon={<CloseSmall theme='outline' size='16' />}
              onClick={onClose}
            />
          </Tooltip>
        </span>
      </header>

      <div className='flex-1 min-h-0 relative'>
        {chat.restoring ? (
          <div className='size-full flex-center'>
            <Spin />
          </div>
        ) : chat.conversationId ? (
          <DocChatBody conversationId={chat.conversationId} />
        ) : (
          <DocChatStart
            fileName={fileName}
            creating={chat.creating}
            loadingAgents={loadingAgents}
            pickerOpen={pickerOpen}
            onPickerVisibleChange={setPickerOpen}
            droplist={
              <AgentMenu
                cliAgents={cliAgents}
                presetAssistants={presetAssistants}
                language={i18n.language}
                loading={loadingAgents}
                disabled={chat.creating}
                onPick={async (launcher) => {
                  setPickerOpen(false);
                  await chat.open(launcher);
                }}
              />
            }
          />
        )}
      </div>
    </section>
  );
};

/**
 * Empty state shown before a chat exists: a prompt + an agent picker. Picking a
 * CLI agent or preset assistant creates the conversation pinned to the file.
 */
const DocChatStart: React.FC<{
  fileName: string;
  creating: boolean;
  loadingAgents: boolean;
  pickerOpen: boolean;
  onPickerVisibleChange: (open: boolean) => void;
  droplist: React.ReactNode;
}> = ({ fileName, creating, loadingAgents, pickerOpen, onPickerVisibleChange, droplist }) => {
  const { t } = useTranslation();
  return (
    <div className='size-full flex flex-col items-center justify-center gap-12px text-center px-16px'>
      <span className='size-48px flex-center rd-full bg-fill-2 text-primary'>
        <Robot theme='outline' size='24' />
      </span>
      <p className='m-0 text-15px font-600 text-t-primary'>{t('studio.assistant.emptyTitle')}</p>
      <p className='m-0 max-w-280px text-13px text-t-secondary leading-relaxed'>
        {t('studio.assistant.startHint', { file: fileName })}
      </p>
      <Dropdown
        position='bottom'
        popupVisible={pickerOpen}
        onVisibleChange={onPickerVisibleChange}
        trigger='click'
        droplist={droplist}
      >
        <Button type='primary' loading={creating || loadingAgents} icon={<Plus theme='outline' size={15} />}>
          {t('studio.assistant.startChat')}
        </Button>
      </Dropdown>
    </div>
  );
};

/**
 * Embed `<ChatConversation>` for the editor's conversation. The conversation
 * object is fetched via the same SWR cache the routed `/conversation/:id` page
 * uses, so the panel shares its underlying state with the main chat surface.
 */
const DocChatBody: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const { data, isLoading } = useSWR<TChatConversation | null>(`conversation/${conversationId}`, () =>
    getConversationOrNull(conversationId)
  );
  if (isLoading || !data) {
    return (
      <div className='size-full flex-center'>
        <Spin />
      </div>
    );
  }
  return (
    <div className='absolute inset-0'>
      <ChatConversation conversation={data} embedded />
    </div>
  );
};

/** The agent picker menu — CLI agents + preset assistants (mirrors the IDE chat). */
const AgentMenu: React.FC<{
  cliAgents: ReturnType<typeof useConversationAgents>['cliAgents'];
  presetAssistants: ReturnType<typeof useConversationAgents>['presetAssistants'];
  language: string;
  loading: boolean;
  disabled: boolean;
  onPick: (launcher: DocChatLauncher) => void | Promise<void>;
}> = ({ cliAgents, presetAssistants, language, loading, disabled, onPick }) => {
  const { t } = useTranslation();
  const cliItems = useMemo(() => cliAgents.filter((agent) => agent.available !== false), [cliAgents]);
  const presetItems = useMemo(
    () => presetAssistants.filter((assistant) => assistant.enabled !== false),
    [presetAssistants]
  );
  const menuStyle: React.CSSProperties = { maxHeight: 360, overflowY: 'auto', minWidth: 220, maxWidth: 280 };

  if (loading) {
    return (
      <Menu style={menuStyle}>
        <Menu.Item key='loading' disabled>
          <Spin size={12} /> <span className='ml-6px'>{t('studio.assistant.loading')}</span>
        </Menu.Item>
      </Menu>
    );
  }

  if (cliItems.length === 0 && presetItems.length === 0) {
    return (
      <Menu style={menuStyle}>
        <Menu.Item key='noAgents' disabled>
          {t('studio.assistant.noAgents')}
        </Menu.Item>
      </Menu>
    );
  }

  return (
    <Menu style={menuStyle}>
      {cliItems.length > 0 ? (
        <Menu.ItemGroup title={t('studio.assistant.cliGroup')}>
          {cliItems.map((agent) => (
            <Menu.Item key={`cli:${agent.id}`} disabled={disabled} onClick={() => void onPick({ kind: 'cli', agent })}>
              <span className='block truncate' title={agent.name}>
                {agent.name}
              </span>
            </Menu.Item>
          ))}
        </Menu.ItemGroup>
      ) : null}
      {presetItems.length > 0 ? (
        <Menu.ItemGroup title={t('studio.assistant.presetGroup')}>
          {presetItems.map((assistant) => (
            <Menu.Item
              key={`preset:${assistant.id}`}
              disabled={disabled}
              onClick={() => void onPick({ kind: 'preset', assistant, language })}
            >
              <span className='block truncate' title={assistant.name}>
                {assistant.name}
              </span>
            </Menu.Item>
          ))}
        </Menu.ItemGroup>
      ) : null}
    </Menu>
  );
};

export default DocAssistantPanel;
