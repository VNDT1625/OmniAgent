/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `IdeHooksPanel` — the IDE "Agent Hooks" mode body. Lists the workspace's
 * automations and lets the user create/edit/enable/run/delete them. A hook
 * reacts to an IDE event (file saved/created/deleted, or a manual trigger) by
 * asking the IDE Chat agent a prompt or running a shell command.
 *
 * Renders strictly with Arco + `@icon-park/react` + UnoCSS semantic tokens; all
 * copy via i18n. Empty/loading/unavailable states are handled inline. The
 * actual firing + dispatch lives in {@link useIdeHooks}.
 */

import { Button, Empty, Input, Modal, Select, Spin, Switch, Tag, Tooltip } from '@arco-design/web-react';
import { AddOne, Delete, Edit, Lightning, Play, Robot, Terminal as TerminalIcon } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IDE_HOOK_ACTIONS,
  IDE_HOOK_EVENTS,
  type IdeHook,
  type IdeHookActionKind,
  type IdeHookEvent,
} from '@process/ide/hooks/ideHookTypes';
import type { UseIdeHooks } from '../hooks/useIdeHooks';

const { Option } = Select;
const { TextArea } = Input;

type IdeHooksPanelProps = {
  rootPath: string;
  /** The workspace's hook controller (owned by IdeWorkspace so firing is global). */
  controller: UseIdeHooks;
};

/** Draft state for the create/edit modal. */
type HookDraft = {
  id?: string;
  name: string;
  description: string;
  enabled: boolean;
  event: IdeHookEvent;
  filePatterns: string;
  action: IdeHookActionKind;
  prompt: string;
  command: string;
};

const emptyDraft = (): HookDraft => ({
  name: '',
  description: '',
  enabled: true,
  event: 'fileSaved',
  filePatterns: '',
  action: 'askAgent',
  prompt: '',
  command: '',
});

const draftFromHook = (hook: IdeHook): HookDraft => ({
  id: hook.id,
  name: hook.name,
  description: hook.description ?? '',
  enabled: hook.enabled,
  event: hook.event,
  filePatterns: hook.filePatterns.join(', '),
  action: hook.action,
  prompt: hook.prompt ?? '',
  command: hook.command ?? '',
});

const IdeHooksPanel: React.FC<IdeHooksPanelProps> = ({ controller }) => {
  const { t } = useTranslation();
  const { hooks, loading, unavailable, save, remove, runNow } = controller;
  const [editing, setEditing] = useState<HookDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const openCreate = (): void => setEditing(emptyDraft());
  const openEdit = (hook: IdeHook): void => setEditing(draftFromHook(hook));

  const handleSave = async (): Promise<void> => {
    if (!editing || editing.name.trim().length === 0) return;
    setSaving(true);
    try {
      const ok = await save({
        id: editing.id,
        name: editing.name.trim(),
        description: editing.description.trim() || undefined,
        enabled: editing.enabled,
        event: editing.event,
        filePatterns: editing.filePatterns
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
        action: editing.action,
        prompt: editing.action === 'askAgent' ? editing.prompt.trim() : undefined,
        command: editing.action === 'runCommand' ? editing.command.trim() : undefined,
      });
      if (ok) setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <header className='shrink-0 flex items-center gap-12px px-16px h-52px border-b border-b-1'>
        <span className='flex items-center gap-8px'>
          <Lightning theme='outline' size={18} className='text-primary' />
          <span className='text-14px font-[500] text-t-primary'>{t('ide.hooks.title')}</span>
          <span className='text-12px text-t-tertiary'>· {t('ide.hooks.subtitle')}</span>
        </span>
        <div className='flex-1' />
        <Button type='primary' size='small' icon={<AddOne theme='outline' size={15} />} onClick={openCreate}>
          {t('ide.hooks.create')}
        </Button>
      </header>

      <div className='flex-1 min-h-0 overflow-auto p-16px'>
        {loading ? (
          <div className='flex-center h-full'>
            <Spin />
          </div>
        ) : unavailable ? (
          <div className='flex-center h-full'>
            <Empty description={t('ide.hooks.unavailable')} />
          </div>
        ) : hooks.length === 0 ? (
          <div className='flex-center flex-col gap-12px h-full'>
            <span className='size-56px flex-center rd-16px bg-primary-light-1 text-primary'>
              <Lightning theme='outline' size={28} />
            </span>
            <p className='m-0 text-14px font-600 text-t-primary'>{t('ide.hooks.emptyTitle')}</p>
            <p className='m-0 max-w-420px text-13px text-t-secondary leading-relaxed text-center'>
              {t('ide.hooks.emptyHint')}
            </p>
            <Button type='outline' icon={<AddOne theme='outline' size={15} />} onClick={openCreate}>
              {t('ide.hooks.create')}
            </Button>
          </div>
        ) : (
          <div className='flex flex-col gap-10px max-w-720px mx-auto'>
            {hooks.map((hook) => (
              <HookRow
                key={hook.id}
                hook={hook}
                onToggle={(enabled) => void save({ ...hook, enabled })}
                onRun={() => void runNow(hook.id)}
                onEdit={() => openEdit(hook)}
                onDelete={() => void remove(hook.id)}
              />
            ))}
          </div>
        )}
      </div>

      <HookEditorModal
        draft={editing}
        saving={saving}
        onChange={setEditing}
        onCancel={() => setEditing(null)}
        onSave={() => void handleSave()}
      />
    </div>
  );
};

/** One hook in the list: name, event/action badges, status, and row actions. */
const HookRow: React.FC<{
  hook: IdeHook;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}> = ({ hook, onToggle, onRun, onEdit, onDelete }) => {
  const { t } = useTranslation();
  const isCommand = hook.action === 'runCommand';
  return (
    <div className='flex items-center gap-12px p-12px rd-10px bg-2 border border-b-1'>
      <Switch size='small' checked={hook.enabled} onChange={onToggle} aria-label={t('ide.hooks.enabled')} />
      <span
        className={`size-32px shrink-0 flex-center rd-8px ${isCommand ? 'bg-warning-light-1 text-warning' : 'bg-primary-light-1 text-primary'}`}
      >
        {isCommand ? <TerminalIcon theme='outline' size={16} /> : <Robot theme='outline' size={16} />}
      </span>
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-8px'>
          <span className='text-13px font-[500] text-t-primary truncate'>{hook.name}</span>
          <Tag size='small' color='arcoblue'>
            {t(`ide.hooks.event.${hook.event}`)}
          </Tag>
          <Tag size='small'>{t(`ide.hooks.action.${hook.action}`)}</Tag>
        </div>
        <p className='m-0 mt-2px text-12px text-t-tertiary truncate'>
          {hook.description || (isCommand ? hook.command : hook.prompt) || ''}
        </p>
      </div>
      <Tooltip content={t('ide.hooks.runNow')}>
        <Button type='text' size='small' icon={<Play theme='outline' size={15} />} onClick={onRun} />
      </Tooltip>
      <Tooltip content={t('ide.hooks.edit')}>
        <Button type='text' size='small' icon={<Edit theme='outline' size={15} />} onClick={onEdit} />
      </Tooltip>
      <Tooltip content={t('ide.hooks.delete')}>
        <Button
          type='text'
          size='small'
          status='danger'
          icon={<Delete theme='outline' size={15} />}
          onClick={onDelete}
        />
      </Tooltip>
    </div>
  );
};

/** Create/edit modal for a single hook. */
const HookEditorModal: React.FC<{
  draft: HookDraft | null;
  saving: boolean;
  onChange: (draft: HookDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}> = ({ draft, saving, onChange, onCancel, onSave }) => {
  const { t } = useTranslation();
  if (!draft) return null;
  const isFileEvent = draft.event !== 'manual';
  const isCommand = draft.action === 'runCommand';
  const nameMissing = draft.name.trim().length === 0;

  return (
    <Modal
      title={draft.id ? t('ide.hooks.editTitle') : t('ide.hooks.createTitle')}
      visible
      onOk={onSave}
      onCancel={onCancel}
      okText={t('ide.hooks.save')}
      cancelText={t('common.cancel')}
      confirmLoading={saving}
      okButtonProps={{ disabled: nameMissing }}
      style={{ width: 560 }}
    >
      <div className='flex flex-col gap-14px'>
        <Field label={t('ide.hooks.fieldName')}>
          <Input
            value={draft.name}
            onChange={(v) => onChange({ ...draft, name: v })}
            placeholder={t('ide.hooks.namePlaceholder')}
          />
        </Field>

        <Field label={t('ide.hooks.fieldDescription')}>
          <Input
            value={draft.description}
            onChange={(v) => onChange({ ...draft, description: v })}
            placeholder={t('ide.hooks.descriptionPlaceholder')}
          />
        </Field>

        <Field label={t('ide.hooks.fieldEvent')}>
          <Select value={draft.event} onChange={(v) => onChange({ ...draft, event: v as IdeHookEvent })}>
            {IDE_HOOK_EVENTS.map((ev) => (
              <Option key={ev} value={ev}>
                {t(`ide.hooks.event.${ev}`)}
              </Option>
            ))}
          </Select>
        </Field>

        {isFileEvent ? (
          <Field label={t('ide.hooks.fieldPatterns')} hint={t('ide.hooks.patternsHint')}>
            <Input
              value={draft.filePatterns}
              onChange={(v) => onChange({ ...draft, filePatterns: v })}
              placeholder='*.ts, src/**/*.tsx'
            />
          </Field>
        ) : null}

        <Field label={t('ide.hooks.fieldAction')}>
          <Select value={draft.action} onChange={(v) => onChange({ ...draft, action: v as IdeHookActionKind })}>
            {IDE_HOOK_ACTIONS.map((ac) => (
              <Option key={ac} value={ac}>
                {t(`ide.hooks.action.${ac}`)}
              </Option>
            ))}
          </Select>
        </Field>

        {isCommand ? (
          <Field label={t('ide.hooks.fieldCommand')} hint={t('ide.hooks.commandHint')}>
            <Input
              value={draft.command}
              onChange={(v) => onChange({ ...draft, command: v })}
              placeholder='npm run lint'
            />
          </Field>
        ) : (
          <Field label={t('ide.hooks.fieldPrompt')} hint={t('ide.hooks.promptHint')}>
            <TextArea
              value={draft.prompt}
              onChange={(v) => onChange({ ...draft, prompt: v })}
              autoSize={{ minRows: 2, maxRows: 5 }}
              placeholder={t('ide.hooks.promptPlaceholder')}
            />
          </Field>
        )}

        <div className='flex items-center gap-8px'>
          <Switch size='small' checked={draft.enabled} onChange={(v) => onChange({ ...draft, enabled: v })} />
          <span className='text-13px text-t-secondary'>{t('ide.hooks.enabled')}</span>
        </div>
      </div>
    </Modal>
  );
};

/** A labelled form field with an optional hint line. */
const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className='flex flex-col gap-4px'>
    <span className='text-13px font-[500] text-t-primary'>{label}</span>
    {children}
    {hint ? <span className='text-12px text-t-tertiary'>{hint}</span> : null}
  </div>
);

export default IdeHooksPanel;
