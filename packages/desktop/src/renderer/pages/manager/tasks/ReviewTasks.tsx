/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AI task review (Requirement 3.4, 3.5) — a coach pass over the current task
 * list. The user clicks "AI review"; the model returns suggestions (overdue
 * items, priority changes, merge/split, a sensible order) which are shown as a
 * read-only list. Suggestions are advice only — nothing mutates the store
 * automatically (criterion 3.5). Each suggestion that references a task offers a
 * shortcut to open that task for editing.
 *
 * Renderer-only. No Node.js APIs.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Empty, Message, Modal, Tag } from '@arco-design/web-react';
import { Lightning } from '@icon-park/react';
import type { Task, TaskSuggestion } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';

/** Semantic colour per suggestion kind. */
const kindColor = (kind: TaskSuggestion['kind']): string => {
  switch (kind) {
    case 'overdue':
      return 'red';
    case 'priority':
      return 'orange';
    case 'merge':
    case 'split':
      return 'arcoblue';
    case 'order':
      return 'purple';
    default:
      return 'gray';
  }
};

const ReviewTasks: React.FC<{ store: UseManagerStore; onOpenTask: (task: Task) => void }> = ({ store, onOpenTask }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<TaskSuggestion[] | null>(null);

  const run = async () => {
    setOpen(true);
    setLoading(true);
    setSuggestions(null);
    try {
      const res = await store.client.aiReviewTasks();
      if (res.ok) {
        setSuggestions(res.data);
      } else if ((res as { code?: string }).code === 'no-model') {
        Message.warning(t('manager.review.noModel'));
        setOpen(false);
      } else {
        Message.error(t('manager.review.failed'));
        setOpen(false);
      }
    } catch {
      Message.error(t('manager.review.failed'));
      setOpen(false);
    } finally {
      setLoading(false);
    }
  };

  const findTask = (id?: string): Task | undefined =>
    id ? store.data.tasks.find((task) => task.id === id) : undefined;

  return (
    <>
      <Button size='small' icon={<Lightning theme='outline' size='14' />} onClick={() => void run()}>
        {t('manager.review.action')}
      </Button>

      <Modal
        visible={open}
        title={t('manager.review.title')}
        onCancel={() => setOpen(false)}
        footer={
          <div className='flex justify-end gap-8px'>
            <Button onClick={() => setOpen(false)}>{t('manager.review.close')}</Button>
            <Button type='primary' loading={loading} onClick={() => void run()}>
              {t('manager.review.rerun')}
            </Button>
          </div>
        }
        style={{ width: 560 }}
      >
        <div className='text-12px text-t-tertiary mb-10px'>{t('manager.review.hint')}</div>
        {loading ? (
          <div className='text-center text-13px text-t-tertiary py-32px'>{t('manager.review.thinking')}</div>
        ) : suggestions && suggestions.length > 0 ? (
          <div className='flex flex-col gap-8px max-h-440px overflow-y-auto'>
            {suggestions.map((s, i) => {
              const task = findTask(s.taskId);
              return (
                <div key={i} className='rd-8px border border-solid border-arco-2 p-10px flex items-start gap-8px'>
                  <Tag size='small' color={kindColor(s.kind)} className='shrink-0 mt-2px'>
                    {t(`manager.review.kind.${s.kind}`)}
                  </Tag>
                  <div className='flex-1 min-w-0'>
                    <div className='text-13px text-t-primary'>{s.message}</div>
                    {task && (
                      <div
                        className='text-12px text-primary cursor-pointer hover:underline mt-2px'
                        onClick={() => {
                          setOpen(false);
                          onOpenTask(task);
                        }}
                      >
                        {task.title}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : suggestions ? (
          <Empty description={t('manager.review.empty')} />
        ) : null}
      </Modal>
    </>
  );
};

export default ReviewTasks;
