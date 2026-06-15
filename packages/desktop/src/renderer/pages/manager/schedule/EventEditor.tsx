/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Create/edit a calendar event (Requirement 6.2, 6.5, 7.1, 7.4, 7.5). Lets the
 * user choose fixed vs flexible. Changing the *time* of a fixed event asks for
 * confirmation (criterion 7.5) — the lock only blocks the AI optimiser, not the
 * user, but we guard against accidental edits.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DatePicker, Input, Message, Modal, Radio, Select } from '@arco-design/web-react';
import type { CalendarEvent, EventLockKind } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';

const Option = Select.Option;
const { TextArea } = Input;

const EventEditor: React.FC<{
  store: UseManagerStore;
  event: CalendarEvent | null;
  defaultStart?: number;
  onClose: () => void;
}> = ({ store, event, defaultStart, onClose }) => {
  const { t } = useTranslation();
  const isEdit = event != null;
  const baseStart = event?.startAt ?? defaultStart ?? Date.now();

  const [title, setTitle] = useState(event?.title ?? '');
  const [startAt, setStartAt] = useState<number>(baseStart);
  const [endAt, setEndAt] = useState<number>(event?.endAt ?? baseStart + 60 * 60_000);
  const [lockKind, setLockKind] = useState<EventLockKind>(event?.lockKind ?? 'flexible');
  const [location, setLocation] = useState(event?.location ?? '');
  const [linkedTaskId, setLinkedTaskId] = useState<string | undefined>(event?.linkedTaskId ?? undefined);
  const [note, setNote] = useState(event?.note ?? '');
  const [saving, setSaving] = useState(false);

  const timeChanged = isEdit && event != null && (startAt !== event.startAt || endAt !== event.endAt);

  const persist = async () => {
    setSaving(true);
    try {
      let ok: boolean;
      if (isEdit && event) {
        ok = await store.run(() =>
          store.client.updateEvent({
            id: event.id,
            patch: {
              title: title.trim(),
              startAt,
              endAt,
              lockKind,
              location: location || null,
              linkedTaskId: linkedTaskId ?? null,
              note: note || null,
            },
          })
        );
      } else {
        ok = await store.run(() =>
          store.client.addEvent({
            input: {
              title: title.trim(),
              startAt,
              endAt,
              lockKind,
              location: location || null,
              linkedTaskId: linkedTaskId ?? null,
              note: note || null,
              source: 'manual',
            },
          })
        );
      }
      if (ok) {
        Message.success(t('manager.schedule.editor.saved'));
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (title.trim().length === 0) {
      Message.warning(t('manager.schedule.editor.titleRequired'));
      return;
    }
    if (endAt <= startAt) {
      Message.warning(t('manager.schedule.editor.timeInvalid'));
      return;
    }
    // Guard: changing a fixed event's time asks for confirmation (criterion 7.5).
    if (isEdit && event?.lockKind === 'fixed' && timeChanged) {
      Modal.confirm({
        title: t('manager.schedule.editor.timeChangeConfirmTitle'),
        content: t('manager.schedule.editor.timeChangeConfirm'),
        onOk: () => void persist(),
      });
      return;
    }
    void persist();
  };

  const handleDelete = () => {
    if (!isEdit || !event) return;
    Modal.confirm({
      title: t('manager.schedule.editor.deleteConfirmTitle'),
      content: t('manager.schedule.editor.deleteConfirm'),
      onOk: async () => {
        await store.run(() => store.client.removeEvent({ id: event.id }));
        onClose();
      },
    });
  };

  return (
    <Modal
      visible
      title={isEdit ? t('manager.schedule.editor.editTitle') : t('manager.schedule.editor.createTitle')}
      onCancel={onClose}
      onOk={handleSave}
      okText={t('manager.schedule.editor.save')}
      cancelText={t('manager.schedule.editor.cancel')}
      confirmLoading={saving}
      style={{ width: 520 }}
    >
      <div className='flex flex-col gap-12px'>
        <div>
          <div className='text-12px text-t-secondary mb-4px'>{t('manager.schedule.editor.title')}</div>
          <Input value={title} onChange={setTitle} placeholder={t('manager.schedule.editor.titlePlaceholder')} />
        </div>

        <div className='flex gap-12px'>
          <div className='flex-1'>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.schedule.editor.start')}</div>
            <DatePicker
              showTime
              style={{ width: '100%' }}
              value={startAt}
              onChange={(_s, d) => d && setStartAt(d.valueOf())}
            />
          </div>
          <div className='flex-1'>
            <div className='text-12px text-t-secondary mb-4px'>{t('manager.schedule.editor.end')}</div>
            <DatePicker
              showTime
              style={{ width: '100%' }}
              value={endAt}
              onChange={(_s, d) => d && setEndAt(d.valueOf())}
            />
          </div>
        </div>

        <div>
          <div className='text-12px text-t-secondary mb-4px'>{t('manager.schedule.editor.lockKind')}</div>
          <Radio.Group type='button' value={lockKind} onChange={setLockKind}>
            <Radio value='flexible'>{t('manager.schedule.flexible')}</Radio>
            <Radio value='fixed'>{t('manager.schedule.fixed')}</Radio>
          </Radio.Group>
        </div>

        <div>
          <div className='text-12px text-t-secondary mb-4px'>{t('manager.schedule.editor.location')}</div>
          <Input
            value={location}
            onChange={setLocation}
            placeholder={t('manager.schedule.editor.locationPlaceholder')}
          />
        </div>

        <div>
          <div className='text-12px text-t-secondary mb-4px'>{t('manager.schedule.editor.linkedTask')}</div>
          <Select
            allowClear
            value={linkedTaskId}
            onChange={setLinkedTaskId}
            placeholder={t('manager.schedule.editor.linkedTaskPlaceholder')}
          >
            {store.data.tasks.map((task) => (
              <Option key={task.id} value={task.id}>
                {task.title}
              </Option>
            ))}
          </Select>
        </div>

        <div>
          <div className='text-12px text-t-secondary mb-4px'>{t('manager.schedule.editor.note')}</div>
          <TextArea
            value={note}
            onChange={setNote}
            placeholder={t('manager.schedule.editor.notePlaceholder')}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        </div>

        {isEdit && (
          <div className='text-13px text-danger cursor-pointer w-fit' onClick={handleDelete}>
            {t('manager.schedule.editor.delete')}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default EventEditor;
