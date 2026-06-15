/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `WorkflowChatPanel` — the AI Workflow Designer side panel. Users describe what
 * they want in natural language; the AI creates / modifies / explains / fixes
 * the workflow, and any workflow it returns is applied to the editor.
 *
 * Renderer-only; all text via i18n; Arco + icon-park + UnoCSS tokens only.
 */

import { Button, Empty, Input, Select } from '@arco-design/web-react';
import { Close, MagicWand, Robot, Send } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useAutomationChat } from '../useAutomationChat';
import type { Workflow } from '../automationClient';

const { TextArea } = Input;

type WorkflowChatPanelProps = {
  /** The workflow currently open (context for the AI). */
  currentWorkflow: Workflow | null;
  /** All workflows ({id,name}) so the AI avoids duplicate names. */
  existingWorkflows: Array<{ id: string; name: string }>;
  /** Called when the AI created or edited a workflow. */
  onWorkflowChanged: (workflow: Workflow) => void;
  /** Close the panel. */
  onClose: () => void;
};

/** Intent chips shown above the composer. */
const INTENTS: Array<{ value: 'create' | 'modify' | 'explain' | 'fix'; labelKey: string }> = [
  { value: 'create', labelKey: 'automation.chat.intentCreate' },
  { value: 'modify', labelKey: 'automation.chat.intentModify' },
  { value: 'explain', labelKey: 'automation.chat.intentExplain' },
  { value: 'fix', labelKey: 'automation.chat.intentFix' },
];

const WorkflowChatPanel: React.FC<WorkflowChatPanelProps> = ({
  currentWorkflow,
  existingWorkflows,
  onWorkflowChanged,
  onClose,
}) => {
  const { t } = useTranslation();
  const { providers, getAvailableModels } = useModelProviderList();
  const [model, setModel] = useState<string>('');
  const [intent, setIntent] = useState<'create' | 'modify' | 'explain' | 'fix'>('create');
  const [draft, setDraft] = useState('');

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const provider of providers) {
      for (const m of getAvailableModels(provider)) {
        if (seen.has(m)) continue;
        seen.add(m);
        options.push(m);
      }
    }
    return options;
  }, [providers, getAvailableModels]);

  // Default the model to the first available one.
  const effectiveModel = model || modelOptions[0] || '';

  const chat = useAutomationChat({
    model: effectiveModel,
    getCurrentWorkflow: () => currentWorkflow,
    getExistingWorkflows: () => existingWorkflows,
    onWorkflowChanged,
  });

  const handleSend = (): void => {
    if (draft.trim().length === 0) return;
    void chat.send(draft, intent);
    setDraft('');
  };

  return (
    <div className='w-340px shrink-0 min-h-0 flex flex-col border-l border-b-1 bg-1'>
      <header className='shrink-0 flex items-center gap-8px px-12px h-44px border-b border-b-1'>
        <MagicWand theme='outline' size={16} fill='currentColor' className='text-primary' />
        <span className='text-13px font-[600] text-t-primary flex-1'>{t('automation.chat.title')}</span>
        <Button
          type='text'
          size='mini'
          icon={<Close theme='outline' size={14} />}
          onClick={onClose}
          aria-label={t('automation.chat.close')}
        />
      </header>

      {/* Transcript */}
      <div className='flex-1 min-h-0 overflow-y-auto px-12px py-10px flex flex-col gap-10px'>
        {chat.lines.length === 0 ? (
          <div className='h-full flex-center'>
            <Empty description={t('automation.chat.empty')} />
          </div>
        ) : (
          chat.lines.map((line) => (
            <div key={line.id} className={`flex gap-8px ${line.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <span
                className={`flex-center shrink-0 size-24px rd-6px ${line.role === 'user' ? 'bg-primary text-white' : 'bg-fill-2 text-t-secondary'}`}
              >
                <Robot theme='outline' size={13} fill='currentColor' />
              </span>
              <div
                className={`max-w-[80%] rd-8px px-10px py-7px text-13px leading-relaxed whitespace-pre-wrap ${line.role === 'user' ? 'bg-primary-light text-t-primary' : 'bg-fill-1 text-t-primary'}`}
              >
                {line.content}
              </div>
            </div>
          ))
        )}
        {chat.busy ? <div className='text-12px text-t-tertiary px-2px'>{t('automation.chat.thinking')}</div> : null}
        {chat.error ? <div className='text-12px text-danger px-2px'>{chat.error}</div> : null}
      </div>

      {/* Composer */}
      <div className='shrink-0 border-t border-b-1 p-10px flex flex-col gap-8px'>
        <div className='flex gap-6px'>
          <Select
            value={effectiveModel || undefined}
            onChange={setModel}
            placeholder={t('automation.config.pickModel')}
            size='mini'
            showSearch
            className='flex-1'
            aria-label={t('automation.config.model')}
          >
            {modelOptions.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
          <Select
            value={intent}
            onChange={(v) => setIntent(v)}
            size='mini'
            className='w-110px'
            aria-label={t('automation.chat.intent')}
          >
            {INTENTS.map((it) => (
              <Select.Option key={it.value} value={it.value}>
                {t(it.labelKey)}
              </Select.Option>
            ))}
          </Select>
        </div>
        <TextArea
          value={draft}
          onChange={setDraft}
          autoSize={{ minRows: 2, maxRows: 5 }}
          placeholder={t('automation.chat.placeholder')}
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <div className='flex items-center gap-8px'>
          <Button
            type='text'
            size='mini'
            className='!text-t-tertiary'
            onClick={chat.clear}
            disabled={chat.lines.length === 0}
          >
            {t('automation.chat.clear')}
          </Button>
          <div className='flex-1' />
          <Button
            type='primary'
            size='small'
            icon={<Send theme='outline' size={14} />}
            loading={chat.busy}
            disabled={draft.trim().length === 0 || effectiveModel.length === 0}
            onClick={handleSend}
          >
            {t('automation.chat.send')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default WorkflowChatPanel;
