/** Exact AionRS context inspector. Internal request state is read-only; custom context is editable. */
import { Alert, Button, Collapse, Empty, Input, Message, Spin, Tag, Typography } from '@arco-design/web-react';
import { AddOne, Data, Delete, Refresh, Save } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AionrsContextBranch } from '@/common';
import { areContextBranchesValid, estimateContextBranchTokens } from './contextBranchUtils';
import { useAionrsContext } from './useAionrsContext';

type AionrsContextPanelProps = {
  conversationId: string;
  active: boolean;
};

const JsonBlock: React.FC<{ value: unknown }> = ({ value }) => (
  <Typography.Paragraph className='!mb-0 whitespace-pre-wrap break-words font-mono text-12px leading-relaxed text-t-secondary'>
    {JSON.stringify(value, null, 2)}
  </Typography.Paragraph>
);

const AionrsContextPanel: React.FC<AionrsContextPanelProps> = ({ conversationId, active }) => {
  const { t } = useTranslation();
  const { snapshot, loading, saving, error, refresh, save } = useAionrsContext(conversationId, active);
  const [draft, setDraft] = useState('');
  const [customDirty, setCustomDirty] = useState(false);
  const [branchDrafts, setBranchDrafts] = useState<AionrsContextBranch[]>([]);
  const [branchesDirty, setBranchesDirty] = useState(false);
  const assistantReplyCount = snapshot?.messages.filter((message) => message.role === 'assistant').length ?? 0;

  useEffect(() => {
    if (!customDirty && snapshot) setDraft(snapshot.custom_context);
    if (!branchesDirty && snapshot) setBranchDrafts(snapshot.context_branches ?? []);
  }, [branchesDirty, customDirty, snapshot]);

  const messageItems = useMemo(
    () =>
      (snapshot?.messages ?? []).map(
        (item: import('@/common/adapter/ipcBridge').AionrsContextMessage, index: number) => ({
          key: String(index),
          header: `${index + 1}. ${item.role}`,
          content: <JsonBlock value={item.content} />,
        })
      ),
    [snapshot]
  );

  const submit = async (): Promise<void> => {
    if (!areContextBranchesValid(branchDrafts)) {
      Message.error(t('ide.memory.context.branchInvalid'));
      return;
    }
    const saveError = await save(draft, branchDrafts);
    if (saveError) {
      Message.error(t('ide.memory.context.saveFailed'));
      return;
    }
    setCustomDirty(false);
    setBranchesDirty(false);
    Message.success(t('ide.memory.context.saved'));
  };

  const addBranch = (): void => {
    if (branchDrafts.length >= 12) return;
    const id = `context-${Date.now().toString(36)}`;
    setBranchDrafts((current) => [...current, { id, title: '', summary: '', content: '' }]);
    setBranchesDirty(true);
  };

  const updateBranch = (index: number, patch: Partial<AionrsContextBranch>): void => {
    setBranchDrafts((current) =>
      current.map((branch, itemIndex) => (itemIndex === index ? { ...branch, ...patch } : branch))
    );
    setBranchesDirty(true);
  };

  const removeBranch = (index: number): void => {
    setBranchDrafts((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setBranchesDirty(true);
  };

  if (!snapshot && loading) {
    return (
      <div className='h-full flex-center'>
        <Spin tip={t('ide.memory.context.loading')} />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className='h-full flex flex-col gap-12px'>
        {error ? <Alert type='error' content={t('ide.memory.context.loadFailed')} /> : null}
        <div className='flex-1 flex-center'>
          <Empty description={t('ide.memory.context.empty')} />
        </div>
        <Button icon={<Refresh theme='outline' />} onClick={() => void refresh()}>
          {t('ide.memory.refresh')}
        </Button>
      </div>
    );
  }

  return (
    <div className='h-full min-h-0 flex flex-col gap-14px'>
      <div className='shrink-0 p-12px rd-12px bg-primary-light-1 border border-primary-light-3'>
        <div className='flex items-start gap-10px'>
          <span className='size-30px rd-9px flex-center bg-primary text-white shrink-0'>
            <Data theme='outline' size={16} />
          </span>
          <div className='min-w-0 flex-1'>
            <div className='text-13px font-600 text-t-primary'>{t('ide.memory.context.exactTitle')}</div>
            <div className='mt-2px text-11px leading-relaxed text-t-secondary'>{t('ide.memory.context.exactHint')}</div>
            <div className='mt-8px flex flex-wrap gap-6px'>
              <Tag color='arcoblue' size='small'>
                {snapshot.model}
              </Tag>

              <Tag size='small'>{t('ide.memory.context.tokenEstimate', { count: snapshot.token_estimate.total })}</Tag>

              <Tag size='small'>
                {t('ide.memory.context.messageWindow', {
                  sent: snapshot.messages.length,
                  assistant: assistantReplyCount,
                  total: snapshot.full_message_count,
                })}
              </Tag>
              <Tag size='small'>{t('ide.memory.context.toolCount', { count: snapshot.tools.length })}</Tag>
              <Tag size='small'>{t('ide.memory.context.maxTokens', { count: snapshot.max_tokens })}</Tag>
            </div>
          </div>
        </div>
      </div>

      {error ? <Alert type='error' content={t('ide.memory.context.loadFailed')} /> : null}

      <div className='shrink-0 flex flex-col gap-7px'>
        <div>
          <div className='text-12px font-600 text-t-primary'>{t('ide.memory.context.customTitle')}</div>
          <div className='text-11px text-t-tertiary'>{t('ide.memory.context.customHint')}</div>
        </div>
        <Input.TextArea
          value={draft}
          onChange={(value) => {
            setDraft(value);
            setCustomDirty(value !== snapshot.custom_context);
          }}
          placeholder={t('ide.memory.context.customPlaceholder')}
          autoSize={{ minRows: 4, maxRows: 8 }}
        />
        <div className='flex justify-end'>
          <Button
            type='primary'
            size='small'
            icon={<Save theme='outline' size={14} />}
            loading={saving}
            disabled={!customDirty && !branchesDirty}
            onClick={() => void submit()}
          >
            {t('ide.memory.context.save')}
          </Button>
        </div>
      </div>

      <div className='flex-1 min-h-0 overflow-y-auto pr-2px'>
        <Collapse defaultActiveKey={['system']} destroyOnHide>
          <Collapse.Item
            name='context-branches'
            header={t('ide.memory.context.branchesTitle', { count: branchDrafts.length })}
          >
            <div className='flex flex-col gap-10px'>
              <div className='flex items-start justify-between gap-12px'>
                <div className='text-11px leading-relaxed text-t-tertiary'>{t('ide.memory.context.branchesHint')}</div>
                <Button
                  size='mini'
                  type='outline'
                  icon={<AddOne theme='outline' size={13} />}
                  disabled={branchDrafts.length >= 12}
                  onClick={addBranch}
                >
                  {t('ide.memory.context.branchAdd')}
                </Button>
              </div>
              {branchDrafts.length === 0 ? (
                <Empty description={t('ide.memory.context.branchesEmpty')} />
              ) : (
                branchDrafts.map((branch, index) => {
                  const isActive = (snapshot.active_context_branch_ids ?? []).includes(branch.id);
                  const tokenEstimate = estimateContextBranchTokens(branch.content);
                  return (
                    <div key={`${branch.id}-${index}`} className='p-10px rd-10px border border-border-2 bg-fill-1'>
                      <div className='mb-8px flex items-center justify-between gap-8px'>
                        <div className='flex flex-wrap items-center gap-6px'>
                          <Tag size='small' color={isActive ? 'green' : 'gray'}>
                            {isActive ? t('ide.memory.context.branchActive') : t('ide.memory.context.branchDormant')}
                          </Tag>
                          <Tag size='small'>{t('ide.memory.context.branchTokens', { count: tokenEstimate })}</Tag>
                        </div>
                        <Button
                          size='mini'
                          type='text'
                          status='danger'
                          icon={<Delete theme='outline' size={13} />}
                          onClick={() => removeBranch(index)}
                        />
                      </div>
                      <div className='grid grid-cols-2 gap-8px'>
                        <Input
                          value={branch.id}
                          maxLength={64}
                          disabled
                          placeholder={t('ide.memory.context.branchId')}
                          onChange={(value) => updateBranch(index, { id: value })}
                        />
                        <Input
                          value={branch.title}
                          maxLength={160}
                          placeholder={t('ide.memory.context.branchName')}
                          onChange={(value) => updateBranch(index, { title: value })}
                        />
                      </div>
                      <Input
                        className='mt-8px'
                        value={branch.summary}
                        maxLength={500}
                        placeholder={t('ide.memory.context.branchSummary')}
                        onChange={(value) => updateBranch(index, { summary: value })}
                      />
                      <Input.TextArea
                        className='mt-8px'
                        value={branch.content}
                        maxLength={8000}
                        showWordLimit
                        autoSize={{ minRows: 3, maxRows: 8 }}
                        placeholder={t('ide.memory.context.branchContent')}
                        onChange={(value) => updateBranch(index, { content: value })}
                      />
                    </div>
                  );
                })
              )}
              <div className='flex justify-end'>
                <Button
                  type='primary'
                  size='small'
                  icon={<Save theme='outline' size={14} />}
                  loading={saving}
                  disabled={!customDirty && !branchesDirty}
                  onClick={() => void submit()}
                >
                  {t('ide.memory.context.save')}
                </Button>
              </div>
            </div>
          </Collapse.Item>
          <Collapse.Item name='working-memory' header={t('ide.memory.context.workingMemory')}>
            <JsonBlock value={snapshot.working_memory} />
          </Collapse.Item>
          <Collapse.Item name='tool-cache' header={t('ide.memory.context.toolCache')}>
            <JsonBlock value={snapshot.tool_cache} />
          </Collapse.Item>
          <Collapse.Item name='session-expbase' header={t('ide.memory.context.sessionExpbase')}>
            <JsonBlock value={snapshot.session_experience} />
          </Collapse.Item>
          <Collapse.Item name='token-estimate' header={t('ide.memory.context.tokenEstimateDetail')}>
            <JsonBlock value={snapshot.token_estimate} />
          </Collapse.Item>
          <Collapse.Item name='system' header={t('ide.memory.context.systemPrompt')}>
            <Typography.Paragraph className='!mb-0 whitespace-pre-wrap break-words font-mono text-12px leading-relaxed text-t-secondary'>
              {snapshot.system}
            </Typography.Paragraph>
          </Collapse.Item>
          <Collapse.Item name='messages' header={t('ide.memory.context.messages', { count: snapshot.messages.length })}>
            {messageItems.length > 0 ? (
              <Collapse accordion>
                {messageItems.map((item) => (
                  <Collapse.Item key={item.key} name={item.key} header={item.header}>
                    {item.content}
                  </Collapse.Item>
                ))}
              </Collapse>
            ) : (
              <Empty />
            )}
          </Collapse.Item>
          <Collapse.Item name='tools' header={t('ide.memory.context.tools', { count: snapshot.tools.length })}>
            <JsonBlock value={snapshot.tools} />
          </Collapse.Item>
          <Collapse.Item name='config' header={t('ide.memory.context.requestConfig')}>
            <JsonBlock
              value={{
                model: snapshot.model,
                max_tokens: snapshot.max_tokens,
                thinking: snapshot.thinking,
                reasoning_effort: snapshot.reasoning_effort,
              }}
            />
          </Collapse.Item>
        </Collapse>
      </div>

      <div className='shrink-0 flex justify-end pt-8px border-t border-t-1'>
        <Button
          size='small'
          icon={loading ? <Spin size={12} /> : <Refresh theme='outline' size={14} />}
          onClick={() => void refresh()}
        >
          {t('ide.memory.refresh')}
        </Button>
      </div>
    </div>
  );
};

export default AionrsContextPanel;
