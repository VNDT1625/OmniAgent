/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Create/edit a task manually (Requirement 1.1, 1.2). Covers the core fields —
 * title, description, kind, priority, due date, estimate, tags, subtasks, and an
 * optional reminder offset before the due date.
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, DatePicker, Input, InputNumber, InputTag, Message, Modal, Select } from '@arco-design/web-react';
import { Delete, Plus } from '@icon-park/react';
import type { Priority, RecurrenceRule, Task, TaskKind } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import { PRIORITIES, TASK_KINDS, priorityKey, taskKindKey } from '../managerStrings';

const Option = Select.Option;
const { TextArea } = Input;

type DraftSubtask = { title: string };

const TaskEditor: React.FC<{ store: UseManagerStore; task: Task | null; onClose: () => void }> = ({
  store,
  task,
  onClose,
}) => {
  const { t } = useTranslation();
  const isEdit = task != null;

  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [kind, setKind] = useState<TaskKind>(task?.kind ?? 'oneoff');
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium');
  const [dueAt, setDueAt] = useState<number | null>(task?.dueAt ?? null);
  const [estimate, setEstimate] = useState<number | undefined>(task?.estimateMinutes ?? undefined);
  const [tags, setTags] = useState<string[]>(task?.tags ?? []);
  const [subtasks, setSubtasks] = useState<DraftSubtask[]>(() =>
    (task?.subtasks ?? []).map((s) => ({ title: s.title }))
  );
  const [reminderMinutes, setReminderMinutes] = useState<number | undefined>(undefined);
  const [recurrenceFreq, setRecurrenceFreq] = useState<RecurrenceRule['freq'] | 'none'>(
    task?.recurrence?.freq ?? 'none'
  );
  const [recurrenceInterval, setRecurrenceInterval] = useState<number>(task?.recurrence?.interval ?? 1);
  const [saving, setSaving] = useState(false);

  const recurrence = useMemo<RecurrenceRule | null>(() => {
    if (kind !== 'recurring' || recurrenceFreq === 'none') return null;
    return { freq: recurrenceFreq, interval: Math.max(1, recurrenceInterval || 1) };
  }, [kind, recurrenceFreq, recurrenceInterval]);

  /** Default the repeat frequency to weekly the first time a task becomes recurring. */
  const handleKindChange = (next: TaskKind) => {
    setKind(next);
    if (next === 'recurring' && recurrenceFreq === 'none') setRecurrenceFreq('weekly');
  };

  const reminders = useMemo(() => {
    if (dueAt == null || reminderMinutes == null) return undefined;
    return [{ fireAt: dueAt - reminderMinutes * 60_000 }];
  }, [dueAt, reminderMinutes]);

  const handleSave = async () => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      Message.warning(t('manager.taskEditor.fieldTitle'));
      return;
    }
    setSaving(true);
    try {
      const cleanSubtasks = subtasks.map((s) => ({ title: s.title.trim() })).filter((s) => s.title.length > 0);
      let ok: boolean;
      if (isEdit && task) {
        ok = await store.run(() =>
          store.client.updateTask({
            id: task.id,
            patch: {
              title: trimmed,
              description,
              kind,
              priority,
              dueAt,
              estimateMinutes: estimate ?? null,
              tags,
              recurrence,
              subtasks: cleanSubtasks.map((s, i) => ({
                id: task.subtasks[i]?.id ?? `${task.id}-s${i}`,
                title: s.title,
                done: task.subtasks[i]?.done ?? false,
              })),
            },
          })
        );
      } else {
        ok = await store.run(() =>
          store.client.addTask({
            input: {
              title: trimmed,
              description,
              kind,
              priority,
              dueAt,
              estimateMinutes: estimate ?? null,
              tags,
              subtasks: cleanSubtasks,
              recurrence,
              reminders,
            },
          })
        );
      }
      if (ok) {
        Message.success(t('manager.taskEditor.saved'));
        onClose();
      } else {
        Message.error(t('manager.taskEditor.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible
      title={isEdit ? t('manager.taskEditor.editTitle') : t('manager.taskEditor.createTitle')}
      onCancel={onClose}
      onOk={() => void handleSave()}
      okText={t('manager.taskEditor.save')}
      cancelText={t('manager.taskEditor.cancel')}
      confirmLoading={saving}
      style={{ width: 560 }}
    >
      <div className='flex flex-col gap-12px'>
        <div>
          <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.fieldTitle')}</div>
          <Input value={title} onChange={setTitle} placeholder={t('manager.taskEditor.titlePlaceholder')} />
        </div>

        <div>
          <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.fieldDescription')}</div>
          <TextArea
            value={description}
            onChange={setDescription}
            placeholder={t('manager.taskEditor.descriptionPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 5 }}
          />
        </div>

        <div className='flex gap-12px'>
          <div className='flex-1'>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.fieldKind')}</div>
            <Select value={kind} onChange={handleKindChange}>
              {TASK_KINDS.map((k) => (
                <Option key={k} value={k}>
                  {t(taskKindKey(k))}
                </Option>
              ))}
            </Select>
          </div>
          <div className='flex-1'>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.fieldPriority')}</div>
            <Select value={priority} onChange={setPriority}>
              {PRIORITIES.map((p) => (
                <Option key={p} value={p}>
                  {t(priorityKey(p))}
                </Option>
              ))}
            </Select>
          </div>
        </div>

        {kind === 'recurring' && (
          <div className='flex gap-12px items-end'>
            <div className='flex-1'>
              <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.repeatEvery')}</div>
              <InputNumber
                value={recurrenceInterval}
                onChange={(v) => setRecurrenceInterval((v as number) || 1)}
                min={1}
                max={365}
              />
            </div>
            <div className='flex-1'>
              <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.repeatUnit')}</div>
              <Select value={recurrenceFreq} onChange={setRecurrenceFreq}>
                <Option value='none'>{t('manager.taskEditor.repeatNone')}</Option>
                <Option value='daily'>{t('manager.taskEditor.repeatDaily')}</Option>
                <Option value='weekly'>{t('manager.taskEditor.repeatWeekly')}</Option>
                <Option value='monthly'>{t('manager.taskEditor.repeatMonthly')}</Option>
              </Select>
            </div>
          </div>
        )}

        <div className='flex gap-12px'>
          <div className='flex-1'>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.fieldDueAt')}</div>
            <DatePicker
              showTime
              style={{ width: '100%' }}
              value={dueAt ?? undefined}
              onChange={(_str, date) => setDueAt(date ? date.valueOf() : null)}
            />
          </div>
          <div className='w-140px'>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.fieldEstimate')}</div>
            <InputNumber
              value={estimate}
              onChange={(v) => setEstimate(v as number | undefined)}
              min={0}
              suffix={t('manager.taskEditor.estimateSuffix')}
            />
          </div>
        </div>

        {dueAt != null && (
          <div className='w-200px'>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.reminderMinutesBefore')}</div>
            <InputNumber
              value={reminderMinutes}
              onChange={(v) => setReminderMinutes(v as number | undefined)}
              min={0}
              suffix={t('manager.taskEditor.estimateSuffix')}
            />
          </div>
        )}

        <div>
          <div className='text-12px text-t-secondary mb-4px'>{t('manager.taskEditor.fieldTags')}</div>
          <InputTag value={tags} onChange={setTags} placeholder={t('manager.taskEditor.tagsPlaceholder')} />
        </div>

        <div>
          <div className='flex items-center justify-between mb-4px'>
            <div className='text-12px text-t-secondary'>{t('manager.taskEditor.subtasks')}</div>
            <Button
              size='mini'
              icon={<Plus theme='outline' size='12' />}
              onClick={() => setSubtasks((prev) => [...prev, { title: '' }])}
            >
              {t('manager.taskEditor.addSubtask')}
            </Button>
          </div>
          <div className='flex flex-col gap-6px'>
            {subtasks.map((s, i) => (
              <div key={i} className='flex items-center gap-6px'>
                <Input
                  value={s.title}
                  onChange={(v) => setSubtasks((prev) => prev.map((it, idx) => (idx === i ? { title: v } : it)))}
                  placeholder={t('manager.taskEditor.subtaskPlaceholder')}
                />
                <span
                  className='size-26px rd-6px flex items-center justify-center cursor-pointer text-t-secondary hover:bg-danger-light-1 hover:text-danger'
                  onClick={() => setSubtasks((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  <Delete theme='outline' size='14' />
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default TaskEditor;
