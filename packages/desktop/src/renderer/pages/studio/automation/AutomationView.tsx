/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `AutomationView` — the Automation Studio surface. A left rail lists saved
 * workflows (create / select / delete); the centre hosts the {@link WorkflowEditor}
 * for the selected workflow; a bottom dock shows the live run log streamed from
 * the engine while a workflow runs.
 *
 * This is the n8n-style "deterministic backbone" surface: the workflow engine
 * runs steps in order, and the AI node is just one step in the pipeline. When
 * the Main-process bridge is not wired the view shows a friendly notice instead
 * of hanging.
 *
 * Renderer-only; all text via i18n; Arco + icon-park + UnoCSS tokens only.
 */

import { Button, Empty, Modal, Result, Spin } from '@arco-design/web-react';
import { Left, Lightning, Key, MagicWand, Play, Plus, Refresh, Square } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAutomation } from './useAutomation';
import WorkflowEditor from './components/WorkflowEditor';
import RunLogPanel from './components/RunLogPanel';
import WorkflowList from './components/WorkflowList';
import WorkflowChatPanel from './components/WorkflowChatPanel';
import CredentialManager from './components/CredentialManager';
import type { Workflow } from './automationClient';

type AutomationViewProps = {
  onBack: () => void;
};

const AutomationView: React.FC<AutomationViewProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const automation = useAutomation();
  const [creating, setCreating] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [credOpen, setCredOpen] = useState(false);

  // When the AI creates or edits a workflow, refresh the list and open it.
  const handleWorkflowChanged = async (workflow: Workflow): Promise<void> => {
    await automation.reload();
    automation.select(workflow.id);
  };

  const handleCreate = async (): Promise<void> => {
    setCreating(true);
    await automation.save({
      name: t('automation.newWorkflowName'),
      nodes: [{ id: 'trigger', kind: 'trigger.manual', name: t('automation.node.manual'), config: {} }],
      enabled: true,
    });
    setCreating(false);
  };

  const confirmRemove = (id: string, name: string): void => {
    Modal.confirm({
      title: t('automation.remove.title'),
      content: t('automation.remove.content', { name }),
      okText: t('automation.remove.confirm'),
      cancelText: t('automation.remove.cancel'),
      okButtonProps: { status: 'danger' },
      onOk: () => automation.remove(id),
    });
  };

  const running = automation.runningRunId !== null;

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <header className='shrink-0 flex items-center gap-12px px-16px h-52px border-b border-b-1'>
        <Button type='text' icon={<Left theme='outline' size={18} />} className='!text-t-secondary' onClick={onBack}>
          {t('studio.action.back')}
        </Button>
        <span className='flex items-center gap-8px'>
          <Lightning theme='outline' size={18} fill='currentColor' className='text-primary' />
          <span className='text-14px font-[500] text-t-primary'>{t('automation.title')}</span>
        </span>
        <div className='flex-1' />
        <Button
          type='text'
          icon={<Key theme='outline' size={15} />}
          className='!text-t-secondary'
          onClick={() => setCredOpen(true)}
        >
          {t('automation.cred.title')}
        </Button>
        <Button
          type={chatOpen ? 'primary' : 'text'}
          icon={<MagicWand theme='outline' size={15} />}
          className={chatOpen ? '' : '!text-t-secondary'}
          onClick={() => setChatOpen((v) => !v)}
        >
          {t('automation.chat.designer')}
        </Button>
        {automation.selected ? (
          running ? (
            <Button status='danger' icon={<Square theme='filled' size={13} />} onClick={() => void automation.cancel()}>
              {t('automation.stop')}
            </Button>
          ) : (
            <Button
              type='primary'
              icon={<Play theme='outline' size={15} />}
              onClick={() => void automation.run(automation.selected!.id)}
            >
              {t('automation.run')}
            </Button>
          )
        ) : null}
      </header>

      {automation.bridgeError && automation.workflows.length === 0 && !automation.loading ? (
        <div className='flex-1 min-h-0 flex-center'>
          <Result
            status='warning'
            title={t('automation.unavailableTitle')}
            subTitle={t('automation.unavailableSubtitle')}
          >
            <Button
              type='outline'
              icon={<Refresh theme='outline' size={14} />}
              onClick={() => void automation.reload()}
            >
              {t('automation.retry')}
            </Button>
          </Result>
        </div>
      ) : (
        <div className='flex-1 min-h-0 flex'>
          {/* Workflow list rail */}
          <aside className='w-240px shrink-0 min-h-0 flex flex-col border-r border-b-1'>
            <div className='shrink-0 p-12px'>
              <Button
                long
                type='primary'
                loading={creating}
                icon={<Plus theme='outline' size={15} />}
                onClick={() => void handleCreate()}
              >
                {t('automation.newWorkflow')}
              </Button>
            </div>
            <div className='flex-1 min-h-0 overflow-y-auto px-8px pb-12px'>
              {automation.loading ? (
                <div className='flex-center h-full'>
                  <Spin />
                </div>
              ) : automation.workflows.length === 0 ? (
                <div className='flex-center h-full px-12px'>
                  <Empty description={t('automation.empty')} />
                </div>
              ) : (
                <WorkflowList
                  workflows={automation.workflows}
                  selectedId={automation.selectedId}
                  onSelect={automation.select}
                  onRemove={confirmRemove}
                />
              )}
            </div>
          </aside>

          {/* Editor + run log */}
          <main className='flex-1 min-w-0 min-h-0 flex flex-col'>
            {automation.selected ? (
              <>
                <div className='flex-1 min-h-0'>
                  <WorkflowEditor
                    key={automation.selected.id}
                    workflow={automation.selected}
                    onSave={automation.save}
                  />
                </div>
                {automation.runLog.length > 0 ? (
                  <RunLogPanel
                    lines={automation.runLog}
                    running={running}
                    onClear={automation.clearLog}
                    totalSteps={automation.selected.nodes.length}
                  />
                ) : null}
              </>
            ) : (
              <div className='h-full flex-center'>
                <Empty description={t('automation.pickWorkflow')} />
              </div>
            )}
          </main>

          {/* AI Workflow Designer chat panel */}
          {chatOpen ? (
            <WorkflowChatPanel
              currentWorkflow={automation.selected}
              existingWorkflows={automation.workflows.map((w) => ({ id: w.id, name: w.name }))}
              onWorkflowChanged={(wf) => void handleWorkflowChanged(wf)}
              onClose={() => setChatOpen(false)}
            />
          ) : null}
        </div>
      )}
      {credOpen ? <CredentialManager onClose={() => setCredOpen(false)} /> : null}
    </div>
  );
};

export default AutomationView;
