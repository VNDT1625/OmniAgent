/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Input, Modal, Select, Switch } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { emptyScheduleDraft, type ScheduleDraft } from '../constants';

/**
 * Modal to create or edit a terminal schedule (Phase 2): a script that runs in
 * a shell on a cron expression. The classic use case is "launch 9router every
 * morning" without babysitting a terminal.
 *
 * Arco-only, semantic tokens, all strings via `t('terminal.schedule.*')`.
 */
type ScheduleEditorProps = {
  visible: boolean;
  initial: ScheduleDraft | null;
  onCancel: () => void;
  onSave: (draft: ScheduleDraft) => Promise<void>;
};

const ScheduleEditor: React.FC<ScheduleEditorProps> = ({ visible, initial, onCancel, onSave }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ScheduleDraft>(emptyScheduleDraft());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) setDraft(initial ?? emptyScheduleDraft());
  }, [visible, initial]);

  const patch = (updates: Partial<ScheduleDraft>): void => setDraft((prev) => ({ ...prev, ...updates }));

  const canSave = draft.name.trim().length > 0 && draft.script.trim().length > 0;

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      title={initial?.id ? t('terminal.schedule.editTitle') : t('terminal.schedule.newTitle')}
      onCancel={onCancel}
      onOk={() => void handleSave()}
      okButtonProps={{ disabled: !canSave, loading: saving }}
      okText={t('terminal.schedule.save')}
      cancelText={t('common.cancel')}
      autoFocus={false}
      unmountOnExit
    >
      <div className='flex flex-col gap-16px py-4px'>
        <Field label={t('terminal.schedule.name')}>
          <Input
            value={draft.name}
            onChange={(value) => patch({ name: value })}
            placeholder={t('terminal.schedule.namePlaceholder')}
          />
        </Field>

        <div className='flex gap-12px'>
          <Field label={t('terminal.schedule.kind')} className='flex-1'>
            <Select value={draft.kind} onChange={(value) => patch({ kind: value })}>
              <Select.Option value='cron'>{t('terminal.schedule.kindCron')}</Select.Option>
              <Select.Option value='once'>{t('terminal.schedule.kindOnce')}</Select.Option>
            </Select>
          </Field>
          {draft.kind === 'cron' && (
            <Field label={t('terminal.schedule.cron')} className='flex-1'>
              <Input value={draft.cron} onChange={(value) => patch({ cron: value })} placeholder='0 9 * * *' />
            </Field>
          )}
        </div>

        {draft.kind === 'cron' && <p className='m-0 text-11px text-t-tertiary'>{t('terminal.schedule.cronHint')}</p>}

        <Field label={t('terminal.schedule.shell')}>
          <Input
            value={draft.shell}
            onChange={(value) => patch({ shell: value })}
            placeholder={t('terminal.schedule.shellPlaceholder')}
          />
        </Field>

        <Field label={t('terminal.schedule.cwd')}>
          <Input
            value={draft.cwd}
            onChange={(value) => patch({ cwd: value })}
            placeholder={t('terminal.schedule.cwdPlaceholder')}
          />
        </Field>

        <Field label={t('terminal.schedule.script')}>
          <Input.TextArea
            value={draft.script}
            onChange={(value) => patch({ script: value })}
            autoSize={{ minRows: 3, maxRows: 8 }}
            className='font-mono !text-12px'
            placeholder={t('terminal.schedule.scriptPlaceholder')}
          />
        </Field>

        <div className='flex items-center gap-8px'>
          <Switch size='small' checked={draft.enabled} onChange={(checked) => patch({ enabled: checked })} />
          <span className='text-13px text-t-primary'>{t('terminal.schedule.enabled')}</span>
        </div>
      </div>
    </Modal>
  );
};

/** Small labelled field wrapper for the form rows. */
const Field: React.FC<{ label: string; className?: string; children: React.ReactNode }> = ({
  label,
  className,
  children,
}) => (
  <div className={`flex flex-col gap-6px ${className ?? ''}`}>
    <span className='text-13px font-500 text-t-primary'>{label}</span>
    {children}
  </div>
);

export default ScheduleEditor;
