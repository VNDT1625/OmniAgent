/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manager popup — opened from a button on the Company page — where you watch the
 * company actually work. It has two modes (Requirement 7 / spec
 * agent-company-pipeline):
 *
 * - **Pipeline (real work)** — the recursive engine drives each role's assigned
 *   CLI/assistant to execute for real (read/write files, run tests). Shows the
 *   recursive role tree, the transcript, produced artifacts, approval gates.
 * - **Conversation (quick)** — the lightweight model-chat engine: the President
 *   and direct reports "talk" (no real files). Useful to preview a flow fast.
 *
 * Pipeline is the default when a structure exists. Both share the transcript,
 * status, and permission-panel building blocks.
 *
 * Renderer-only. Arco + UnoCSS semantic tokens; all copy via i18n.
 */

import type { CompanyStructure } from '@process/company/companyOrchestrator';
import { Loading, Pause, Play, Robot } from '@icon-park/react';
import { Button, Input, Message, Modal, Radio } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCompanyConversation } from '../useCompanyConversation';
import { useCompanyPipeline } from '../useCompanyPipeline';
import ConversationTranscript from './ConversationTranscript';
import PermissionPanel from './PermissionPanel';
import StatusBoard from './StatusBoard';
import RoleTreeBoard from './RoleTreeBoard';
import ArtifactList from './ArtifactList';

const { TextArea } = Input;
const RadioGroup = Radio.Group;

/** Props for {@link ManagerPopup}. */
export type ManagerPopupProps = {
  /** Whether the modal is open. */
  visible: boolean;
  /** Close the modal. */
  onClose: () => void;
  /** Active company id (runs are scoped to it). */
  companyId: string | null;
  /** Active company display name. */
  companyName?: string;
  /** Company rules (folded into briefings for the real pipeline). */
  rules?: string[];
  /** The active company structure. */
  structure: CompanyStructure | null;
  /** Model id the run should use (optional). */
  model?: string;
  /** UI language (forwarded to the pipeline executor). */
  language?: string;
};

/** Which engine the popup is driving. */
type ManagerMode = 'pipeline' | 'conversation';

/** A labelled section inside the popup. */
const Panel: React.FC<{ title: string; extra?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  extra,
  children,
}) => (
  <section className='flex flex-col gap-10px'>
    <div className='flex items-center justify-between'>
      <h4 className='m-0 text-12px font-600 uppercase tracking-wide text-t-tertiary'>{title}</h4>
      {extra}
    </div>
    {children}
  </section>
);

/** A shared error banner. */
const ErrorBanner: React.FC<{ message: string }> = ({ message }) => (
  <div className='rd-10px border border-solid border-danger bg-danger-1 px-12px py-8px text-12px text-danger'>
    {message}
  </div>
);

/** The real-work pipeline view. */
const PipelineView: React.FC<{
  companyId: string | null;
  companyName: string;
  rules: string[];
  structure: CompanyStructure | null;
  model?: string;
  language: string;
  goal: string;
  setGoal: (v: string) => void;
}> = ({ companyId, companyName, rules, structure, model, language, goal, setGoal }) => {
  const { t } = useTranslation();
  const { snapshot, running, start, resolveApproval, stop } = useCompanyPipeline(companyId);
  const canStart = !!companyId && !!structure && goal.trim().length > 0 && !running;

  const handleStart = (): void => {
    if (!canStart || !structure) return;
    start({ companyName, structure, rules, goal: goal.trim(), model, language });
  };

  const handleResolve = (requestId: string, approved: boolean): void => {
    resolveApproval(requestId, approved);
    Message.info(t(approved ? 'company.conversation.permission.approved' : 'company.conversation.permission.denied'));
  };

  return (
    <div className='flex flex-col gap-16px'>
      <Panel
        title={t('company.conversation.goalTitle')}
        extra={
          running ? (
            <Button size='small' status='danger' icon={<Pause theme='outline' size='13' />} onClick={stop}>
              {t('company.conversation.stop')}
            </Button>
          ) : null
        }
      >
        <TextArea
          value={goal}
          onChange={setGoal}
          placeholder={t('company.conversation.goalPlaceholder')}
          autoSize={{ minRows: 2, maxRows: 4 }}
          disabled={running}
        />
        <div className='flex items-center justify-between'>
          <span className='text-11px text-t-tertiary'>
            {running ? t('company.conversation.runningHint') : t('company.pipeline.startHint')}
          </span>
          <Button
            type='primary'
            icon={running ? <Loading theme='outline' size='14' /> : <Play theme='outline' size='14' />}
            loading={running}
            disabled={!canStart}
            onClick={handleStart}
          >
            {t('company.conversation.start')}
          </Button>
        </div>
      </Panel>

      {snapshot.pending.length > 0 && (
        <Panel title={t('company.conversation.permission.title')}>
          <PermissionPanel
            pending={snapshot.pending.map((p) => ({
              id: p.id,
              fromId: p.fromId,
              action: p.summary,
              reason: p.artifactPreview,
              at: p.at,
            }))}
            participants={Object.values(snapshot.states).map((s) => ({ id: s.nodeId, name: s.name, role: s.role }))}
            onResolve={handleResolve}
          />
        </Panel>
      )}

      {snapshot.error && <ErrorBanner message={snapshot.error} />}

      <div className='grid grid-cols-1 lg:grid-cols-2 gap-16px'>
        <Panel title={t('company.pipeline.boardTitle')}>
          <div className='max-h-360px overflow-auto pr-4px'>
            <RoleTreeBoard states={snapshot.states} rootId={snapshot.rootId} />
          </div>
        </Panel>
        <Panel title={t('company.conversation.transcriptTitle')}>
          <div className='max-h-360px overflow-auto pr-4px'>
            <ConversationTranscript
              messages={snapshot.messages}
              participants={Object.values(snapshot.states).map((s) => ({ id: s.nodeId, name: s.name, role: s.role }))}
            />
          </div>
        </Panel>
      </div>

      <Panel title={t('company.pipeline.artifactsTitle')}>
        <ArtifactList artifacts={snapshot.artifacts} />
      </Panel>

      {snapshot.summary && (
        <Panel title={t('company.conversation.summaryTitle')}>
          <div className='rd-12px border border-solid border-success bg-success-1 px-14px py-12px text-13px leading-relaxed text-t-primary'>
            {snapshot.summary}
          </div>
        </Panel>
      )}
    </div>
  );
};

/** The lightweight model-chat view. */
const ConversationView: React.FC<{
  companyId: string | null;
  structure: CompanyStructure | null;
  model?: string;
  goal: string;
  setGoal: (v: string) => void;
}> = ({ companyId, structure, model, goal, setGoal }) => {
  const { t } = useTranslation();
  const { phase, participants, statuses, messages, pending, summary, error, start, resolve, cancel } =
    useCompanyConversation(companyId);
  const running = phase === 'running';
  const canStart = !!companyId && !!structure && goal.trim().length > 0 && !running;

  const handleResolve = (requestId: string, approved: boolean): void => {
    void resolve(requestId, approved);
    Message.info(t(approved ? 'company.conversation.permission.approved' : 'company.conversation.permission.denied'));
  };

  return (
    <div className='flex flex-col gap-16px'>
      <Panel
        title={t('company.conversation.goalTitle')}
        extra={
          running ? (
            <Button
              size='small'
              status='danger'
              icon={<Pause theme='outline' size='13' />}
              onClick={() => void cancel()}
            >
              {t('company.conversation.stop')}
            </Button>
          ) : null
        }
      >
        <TextArea
          value={goal}
          onChange={setGoal}
          placeholder={t('company.conversation.goalPlaceholder')}
          autoSize={{ minRows: 2, maxRows: 4 }}
          disabled={running}
        />
        <div className='flex items-center justify-between'>
          <span className='text-11px text-t-tertiary'>
            {running ? t('company.conversation.runningHint') : t('company.conversation.startHint')}
          </span>
          <Button
            type='primary'
            icon={running ? <Loading theme='outline' size='14' /> : <Play theme='outline' size='14' />}
            loading={running}
            disabled={!canStart}
            onClick={() => void start(goal.trim(), model)}
          >
            {t('company.conversation.start')}
          </Button>
        </div>
      </Panel>

      {pending.length > 0 && (
        <Panel title={t('company.conversation.permission.title')}>
          <PermissionPanel pending={pending} participants={participants} onResolve={handleResolve} />
        </Panel>
      )}

      {error && <ErrorBanner message={error} />}

      <div className='grid grid-cols-1 lg:grid-cols-2 gap-16px'>
        <Panel title={t('company.conversation.boardTitle')}>
          <StatusBoard participants={participants} statuses={statuses} />
        </Panel>
        <Panel title={t('company.conversation.transcriptTitle')}>
          <div className='max-h-360px overflow-auto pr-4px'>
            <ConversationTranscript messages={messages} participants={participants} />
          </div>
        </Panel>
      </div>

      {summary && (
        <Panel title={t('company.conversation.summaryTitle')}>
          <div className='rd-12px border border-solid border-success bg-success-1 px-14px py-12px text-13px leading-relaxed text-t-primary'>
            {summary}
          </div>
        </Panel>
      )}
    </div>
  );
};

/** The Manager popup with a Pipeline / Conversation mode switch. */
const ManagerPopup: React.FC<ManagerPopupProps> = ({
  visible,
  onClose,
  companyId,
  companyName,
  rules,
  structure,
  model,
  language,
}) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ManagerMode>('pipeline');
  const [goal, setGoal] = useState('');

  return (
    <Modal
      visible={visible}
      onCancel={onClose}
      footer={null}
      title={
        <div className='flex items-center gap-8px'>
          <span className='size-28px flex-center rd-8px bg-primary text-color-white'>
            <Robot theme='outline' size='16' />
          </span>
          <span className='text-15px font-600 text-t-primary'>{t('company.conversation.managerTitle')}</span>
        </div>
      }
      style={{ width: 'min(980px, 95vw)' }}
      autoFocus={false}
      unmountOnExit
    >
      <div className='flex flex-col gap-16px'>
        <RadioGroup type='button' value={mode} onChange={(v) => setMode(v as ManagerMode)} size='small'>
          <Radio value='pipeline'>{t('company.pipeline.modePipeline')}</Radio>
          <Radio value='conversation'>{t('company.pipeline.modeConversation')}</Radio>
        </RadioGroup>
        <p className='m-0 text-11px text-t-tertiary'>
          {mode === 'pipeline' ? t('company.pipeline.modePipelineHint') : t('company.pipeline.modeConversationHint')}
        </p>

        {mode === 'pipeline' ? (
          <PipelineView
            companyId={companyId}
            companyName={companyName ?? companyId ?? ''}
            rules={rules ?? []}
            structure={structure}
            model={model}
            language={language ?? 'en'}
            goal={goal}
            setGoal={setGoal}
          />
        ) : (
          <ConversationView companyId={companyId} structure={structure} model={model} goal={goal} setGoal={setGoal} />
        )}
      </div>
    </Modal>
  );
};

export default ManagerPopup;
