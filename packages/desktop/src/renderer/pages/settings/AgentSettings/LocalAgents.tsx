/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import AionModal from '@/renderer/components/base/AionModal';
import { useAgents } from '@/renderer/hooks/agent/useAgents';
import { Button, Modal, Typography } from '@arco-design/web-react';
import { Home, Plus } from '@icon-park/react';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import AgentCard from './AgentCard';
import { AgentHubModal } from './AgentHubModal';
import InlineAgentEditor, { type CustomAgentDraft } from './InlineAgentEditor';
import { getAgentKey } from '@/renderer/pages/guid/hooks/agentSelectionUtils';

const LocalAgents: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [hubModalVisible, setHubModalVisible] = useState(false);

  // Single fetch for all agents; both detected and custom lists are derived from it.
  // Settings page is the management surface — it consumes the *unfiltered* cache so
  // disabled rows remain visible (otherwise the user could not re-enable them).
  const { agents: allAgents, revalidate: mutateAgents } = useAgents();

  const detectedAgents = useMemo(
    () => allAgents.filter((a) => a.agent_type !== 'remote' && a.agent_source !== 'custom'),
    [allAgents]
  );
  const customAgents: AgentMetadata[] = useMemo(
    () => allAgents.filter((a) => a.agent_source === 'custom'),
    [allAgents]
  );

  const [editorVisible, setEditorVisible] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentMetadata | null>(null);

  const handleSaveCustomAgent = useCallback(
    async (draft: CustomAgentDraft) => {
      const body = {
        name: draft.name,
        command: draft.command,
        icon: draft.icon,
        args: draft.args,
        env: draft.env,
        advanced: draft.advanced,
      };
      try {
        if (editingAgent) {
          await ipcBridge.acpConversation.updateCustomAgent.invoke({ id: editingAgent.id, ...body });
        } else {
          await ipcBridge.acpConversation.createCustomAgent.invoke(body);
        }
        await mutateAgents();
        setEditorVisible(false);
        setEditingAgent(null);
      } catch (err) {
        // Surface backend rejection (e.g. cli_not_found / acp_init_failed) without crashing.
        console.error('save custom agent failed:', err);
      }
    },
    [editingAgent, mutateAgents]
  );

  const handleDeleteCustomAgent = useCallback(
    async (agentId: string) => {
      try {
        await ipcBridge.acpConversation.deleteCustomAgent.invoke({ id: agentId });
        await mutateAgents();
      } catch (err) {
        console.error('delete custom agent failed:', err);
      }
    },
    [mutateAgents]
  );

  const applyEnabledChange = useCallback(
    async (agentId: string, enabled: boolean) => {
      try {
        await ipcBridge.acpConversation.setAgentEnabled.invoke({ id: agentId, enabled });
        await mutateAgents();
      } catch (err) {
        console.error('toggle agent failed:', err);
      }
    },
    [mutateAgents]
  );

  // Enabled→disabled requires a confirm modal so users understand the scope of
  // hiding (home / assistant editor / team leader picker). Disabled→enabled
  // toggles immediately — no friction needed.
  const handleToggleAgent = useCallback(
    (agent: { id: string; name: string; enabled?: boolean }, nextEnabled: boolean) => {
      if (nextEnabled) {
        void applyEnabledChange(agent.id, true);
        return;
      }
      Modal.confirm({
        title: t('settings.agentManagement.disableConfirmTitle', { agentName: agent.name }),
        content: (
          <div className='flex flex-col gap-8px text-13px leading-20px'>
            <span>{t('settings.agentManagement.disableConfirmIntro')}</span>
            <ul className='m-0 pl-20px flex flex-col gap-2px'>
              <li>{t('settings.agentManagement.disableConfirmScopeHome')}</li>
              <li>{t('settings.agentManagement.disableConfirmScopeAssistant')}</li>
              <li>{t('settings.agentManagement.disableConfirmScopeTeam')}</li>
            </ul>
            <span>{t('settings.agentManagement.disableConfirmKeepWorking')}</span>
            <span className='text-t-secondary'>{t('settings.agentManagement.disableConfirmReenableHint')}</span>
          </div>
        ),
        okText: t('settings.agentManagement.disableConfirmConfirm'),
        cancelText: t('settings.agentManagement.disableConfirmCancel'),
        okButtonProps: { status: 'danger' },
        onOk: async () => {
          await applyEnabledChange(agent.id, false);
        },
      });
    },
    [applyEnabledChange, t]
  );

  // Aion CLI is always pinned first within whichever section it lives in.
  const sortDetected = useCallback((list: AgentMetadata[]): AgentMetadata[] => {
    const aion = list.find((a) => a.agent_type === 'aionrs' || a.backend === 'aionrs');
    const others = list.filter((a) => a !== aion);
    return aion ? [aion, ...others] : others;
  }, []);

  const enabledDetected = useMemo(
    () => sortDetected(detectedAgents.filter((a) => a.enabled !== false)),
    [detectedAgents, sortDetected]
  );
  const disabledDetected = useMemo(
    () => sortDetected(detectedAgents.filter((a) => a.enabled === false)),
    [detectedAgents, sortDetected]
  );
  const enabledCustom = useMemo(() => customAgents.filter((a) => a.enabled !== false), [customAgents]);
  const disabledCustom = useMemo(() => customAgents.filter((a) => a.enabled === false), [customAgents]);

  const hasDisabled = disabledDetected.length > 0 || disabledCustom.length > 0;

  const openCustomAgentEditor = useCallback(() => {
    setEditingAgent(null);
    setEditorVisible(true);
  }, []);

  const goToChatWithAgent = useCallback(
    (agent: AgentMetadata) => {
      navigate('/guid', { state: { selectedAgentKey: getAgentKey(agent) } });
    },
    [navigate]
  );

  return (
    <div className='flex flex-col gap-8px py-16px'>
      <div className='px-16px text-12px text-t-secondary'>
        <span>{t('settings.agentManagement.localAgentsDescription')} </span>
        <Button
          type='text'
          size='mini'
          className='!h-auto !p-0 !align-baseline !text-12px !font-normal !text-primary-6 hover:!text-primary-7 hover:!underline underline-offset-2'
          onClick={openCustomAgentEditor}
        >
          {t('settings.agentManagement.detectCustomAgent')}
        </Button>
      </div>

      {process.env.NODE_ENV === 'development' && (
        <div className='px-16px mt-8px'>
          <div className='flex flex-col gap-14px rounded-16px border border-solid border-[rgba(var(--primary-6),0.18)] bg-[rgba(var(--primary-6),0.06)] p-16px md:flex-row md:items-center md:justify-between'>
            <div className='flex items-center gap-12px'>
              <div className='flex h-40px w-40px items-center justify-center leading-none rounded-12px border border-solid border-[rgba(var(--primary-6),0.12)] bg-[rgba(var(--primary-6),0.10)] text-primary-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]'>
                <Home theme='outline' size='20' strokeWidth={2} className='block' />
              </div>
              <div className='min-w-0'>
                <Typography.Text className='mb-4px block text-15px font-medium text-t-primary'>
                  {t('settings.agentManagement.installFromMarket')}
                </Typography.Text>
                <Typography.Text className='block text-12px leading-18px text-t-secondary'>
                  {t('settings.agentManagement.discoverMoreAgents')}
                </Typography.Text>
              </div>
            </div>

            <Button
              type='primary'
              size='small'
              icon={<Plus size='14' />}
              className='!rounded-10px md:!min-w-144px'
              onClick={() => setHubModalVisible(true)}
            >
              {t('settings.agentManagement.installFromMarket')}
            </Button>
          </div>
        </div>
      )}

      {/* Enabled section */}
      <div className='px-16px mt-8px'>
        <Typography.Text className='text-12px font-medium text-t-secondary mb-4px block'>
          {t('settings.agentManagement.sectionEnabled')}
        </Typography.Text>
      </div>
      {enabledDetected.length === 0 && enabledCustom.length === 0 ? (
        <Typography.Text type='secondary' className='block px-16px py-16px text-center text-12px'>
          {t('settings.agentManagement.localAgentsEmpty')}
        </Typography.Text>
      ) : (
        <>
          {enabledDetected.length > 0 && (
            <div className='grid grid-cols-2 gap-10px px-16px md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'>
              {enabledDetected.map((agent) => (
                <AgentCard
                  key={agent.id || agent.backend || agent.agent_type}
                  type='detected'
                  agent={agent}
                  onGoToChat={() => goToChatWithAgent(agent)}
                  onToggle={(next) => handleToggleAgent(agent, next)}
                />
              ))}
            </div>
          )}
          {enabledCustom.length > 0 && (
            <div className='flex flex-col gap-4px px-0 mt-4px'>
              {enabledCustom.map((agent) => (
                <AgentCard
                  key={agent.id}
                  type='custom'
                  agent={agent}
                  onGoToChat={() => goToChatWithAgent(agent)}
                  onEdit={() => {
                    setEditingAgent(agent);
                    setEditorVisible(true);
                  }}
                  onDelete={() => void handleDeleteCustomAgent(agent.id)}
                  onToggle={(next) => handleToggleAgent(agent, next)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Disabled section — only rendered when at least one disabled row exists */}
      {hasDisabled && (
        <>
          <div className='px-16px mt-16px'>
            <Typography.Text className='text-12px font-medium text-t-secondary mb-4px block'>
              {t('settings.agentManagement.sectionDisabled')}
            </Typography.Text>
          </div>
          {disabledDetected.length > 0 && (
            <div className='grid grid-cols-2 gap-10px px-16px md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'>
              {disabledDetected.map((agent) => (
                <AgentCard
                  key={agent.id || agent.backend || agent.agent_type}
                  type='detected'
                  agent={agent}
                  onGoToChat={() => goToChatWithAgent(agent)}
                  onToggle={(next) => handleToggleAgent(agent, next)}
                />
              ))}
            </div>
          )}
          {disabledCustom.length > 0 && (
            <div className='flex flex-col gap-4px px-0 mt-4px'>
              {disabledCustom.map((agent) => (
                <AgentCard
                  key={agent.id}
                  type='custom'
                  agent={agent}
                  onGoToChat={() => goToChatWithAgent(agent)}
                  onEdit={() => {
                    setEditingAgent(agent);
                    setEditorVisible(true);
                  }}
                  onDelete={() => void handleDeleteCustomAgent(agent.id)}
                  onToggle={(next) => handleToggleAgent(agent, next)}
                />
              ))}
            </div>
          )}
        </>
      )}

      <AionModal
        visible={editorVisible}
        onCancel={() => {
          setEditorVisible(false);
          setEditingAgent(null);
        }}
        header={{
          title: editingAgent
            ? t('settings.agentManagement.editCustomAgent')
            : t('settings.agentManagement.detectCustomAgent'),
          showClose: true,
        }}
        footer={null}
        style={{ maxWidth: '92vw', borderRadius: 16 }}
        contentStyle={{
          background: 'var(--dialog-fill-0)',
          borderRadius: 16,
          padding: '20px 24px 16px',
          overflow: 'auto',
        }}
      >
        {/* Conditional mount + key unmounts the editor on close so the
            next `创建自定义 Agent` click always starts from a blank form.
            The inner useEffect([agent]) only resets when the `agent`
            reference changes; two consecutive `null` values would not
            retrigger it. */}
        {editorVisible && (
          <InlineAgentEditor
            key={editingAgent?.id ?? 'new'}
            agent={editingAgent}
            onSave={(agent) => void handleSaveCustomAgent(agent)}
            onCancel={() => {
              setEditorVisible(false);
              setEditingAgent(null);
            }}
          />
        )}
      </AionModal>

      {hubModalVisible && <AgentHubModal visible={hubModalVisible} onCancel={() => setHubModalVisible(false)} />}
    </div>
  );
};

export default LocalAgents;
