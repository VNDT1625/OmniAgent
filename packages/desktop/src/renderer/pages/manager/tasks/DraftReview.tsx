/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Review modal for AI-proposed tasks (Requirement 2.2, 2.3). Each proposal is
 * selectable; the user saves the selected subset (or all), or cancels. Nothing
 * is written to the store until "Save selected".
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox, Message, Modal, Tag } from '@arco-design/web-react';
import type { TaskProposal } from '@process/manager/managerAi';
import type { UseManagerStore } from '../useManagerStore';
import { priorityColor, priorityKey, taskKindKey } from '../managerStrings';

const DraftReview: React.FC<{
  store: UseManagerStore;
  drafts: TaskProposal[];
  onClose: (savedCount: number) => void;
}> = ({ store, drafts, onClose }) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<boolean[]>(() => drafts.map(() => true));
  const [saving, setSaving] = useState(false);

  const selectedCount = selected.filter(Boolean).length;

  const toggle = (index: number) => {
    setSelected((prev) => prev.map((v, i) => (i === index ? !v : v)));
  };

  const handleSave = async () => {
    if (selectedCount === 0) {
      Message.warning(t('manager.draftReview.selectAtLeastOne'));
      return;
    }
    setSaving(true);
    try {
      let saved = 0;
      for (let i = 0; i < drafts.length; i += 1) {
        if (!selected[i]) continue;
        const d = drafts[i];
        const ok = await store.run(() =>
          store.client.addTask({
            input: {
              title: d.title,
              description: d.description,
              kind: d.kind,
              priority: d.priority,
              dueAt: d.dueAt ?? null,
              estimateMinutes: d.estimateMinutes ?? null,
              tags: d.tags,
              subtasks: d.subtasks,
            },
          })
        );
        if (ok) saved += 1;
      }
      Message.success(t('manager.draftReview.saved', { count: saved }));
      onClose(saved);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible
      title={t('manager.draftReview.title')}
      onCancel={() => onClose(0)}
      onOk={() => void handleSave()}
      okText={t('manager.draftReview.saveSelected')}
      cancelText={t('manager.draftReview.cancel')}
      confirmLoading={saving}
      style={{ width: 560 }}
    >
      <div className='text-12px text-t-tertiary mb-8px'>
        {t('manager.draftReview.selectedCount', { count: selectedCount, total: drafts.length })}
      </div>
      <div className='flex flex-col gap-8px max-h-420px overflow-y-auto'>
        {drafts.map((draft, index) => (
          <div
            key={index}
            className='flex items-start gap-10px rd-8px border border-solid border-arco-2 p-10px cursor-pointer hover:bg-fill-1'
            onClick={() => toggle(index)}
          >
            <Checkbox checked={selected[index]} onChange={() => toggle(index)} className='mt-2px' />
            <div className='flex-1 min-w-0'>
              <div className='flex items-center gap-8px'>
                <span className='text-14px text-t-primary truncate'>{draft.title}</span>
                {draft.priority && (
                  <Tag size='small' color={priorityColor(draft.priority)}>
                    {t(priorityKey(draft.priority))}
                  </Tag>
                )}
                {draft.kind && (
                  <Tag size='small' bordered>
                    {t(taskKindKey(draft.kind))}
                  </Tag>
                )}
              </div>
              {draft.description && (
                <div className='text-12px text-t-secondary mt-4px line-clamp-2'>{draft.description}</div>
              )}
              {draft.subtasks && draft.subtasks.length > 0 && (
                <div className='text-12px text-t-tertiary mt-4px'>
                  {t('manager.draftReview.subtaskCount', { count: draft.subtasks.length })}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
};

export default DraftReview;
