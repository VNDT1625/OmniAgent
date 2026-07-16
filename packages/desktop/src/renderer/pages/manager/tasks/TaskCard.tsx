/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A single task row. Shows a complete-toggle, the kind icon, title, a priority
 * tag, due date, and subtask progress. Completing a task gives gentle positive
 * feedback (a brief check animation) that respects `prefers-reduced-motion`
 * (criterion 4.3). Colours come from semantic tokens (criterion 4.2).
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox, Popconfirm, Tag, Tooltip } from '@arco-design/web-react';
import { Calendar, Delete, Edit, Flag, Lightning, Refresh } from '@icon-park/react';
import type { Task } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import { priorityColor, priorityKey } from '../managerStrings';
import styles from '../manager.module.css';

/** Resolve the kind icon component (avoids dynamic-name lookup). */
const KindIcon: React.FC<{ kind: Task['kind']; className?: string }> = ({ kind, className }) => {
  const size = '14';
  if (kind === 'recurring') return <Refresh theme='outline' size={size} className={className} />;
  if (kind === 'habit') return <Lightning theme='outline' size={size} className={className} />;
  if (kind === 'milestone') return <Flag theme='outline' size={size} className={className} />;
  return <Calendar theme='outline' size={size} className={className} />;
};

const formatDue = (dueAt: number): string => new Date(dueAt).toLocaleString();

const TaskCard: React.FC<{ task: Task; store: UseManagerStore; onEdit: () => void }> = ({ task, store, onEdit }) => {
  const { t } = useTranslation();
  const [justDone, setJustDone] = useState(false);
  const isDone = task.status === 'done';
  const subtotal = task.subtasks.length;
  const subdone = task.subtasks.filter((s) => s.done).length;

  const toggleComplete = () => {
    const next = isDone ? 'todo' : 'done';
    if (next === 'done') {
      setJustDone(true);
      window.setTimeout(() => setJustDone(false), 700);
    }
    void store.run(() => store.client.setTaskStatus({ id: task.id, status: next }));
  };

  return (
    <div
      className={[
        styles.row,
        'group flex items-start gap-10px p-12px',
        isDone ? 'opacity-65' : '',
        justDone ? styles.completePulse : '',
      ].join(' ')}
    >
      <Checkbox
        checked={isDone}
        onChange={toggleComplete}
        aria-label={t('manager.tasks.toggleComplete')}
        className='mt-2px'
      />

      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-8px'>
          <Tooltip content={t(`manager.kind.${task.kind}`)}>
            <span className='text-t-tertiary shrink-0'>
              <KindIcon kind={task.kind} />
            </span>
          </Tooltip>
          <span
            className={['text-14px truncate', isDone ? 'line-through text-t-tertiary' : 'text-t-primary'].join(' ')}
          >
            {task.title}
          </span>
          <Tag size='small' color={priorityColor(task.priority)} className='shrink-0'>
            {t(priorityKey(task.priority))}
          </Tag>
        </div>

        {task.description && <div className='text-12px text-t-secondary mt-4px line-clamp-2'>{task.description}</div>}

        <div className='flex items-center gap-12px mt-6px text-12px text-t-tertiary'>
          {task.dueAt != null && (
            <span className='flex items-center gap-4px'>
              <Calendar theme='outline' size='12' /> {formatDue(task.dueAt)}
            </span>
          )}
          {subtotal > 0 && <span>{t('manager.tasks.subtaskProgress', { done: subdone, total: subtotal })}</span>}
          {task.tags.map((tag) => (
            <span key={tag} className='px-6px py-1px rd-full bg-fill-2 text-t-secondary'>
              #{tag}
            </span>
          ))}
        </div>
      </div>

      <div className='flex items-center gap-2px opacity-0 group-hover:opacity-100 transition-opacity'>
        <Tooltip content={t('manager.tasks.edit')}>
          <span
            className='size-26px rd-6px flex items-center justify-center cursor-pointer text-t-secondary hover:bg-fill-2 hover:text-t-primary'
            onClick={onEdit}
          >
            <Edit theme='outline' size='14' />
          </span>
        </Tooltip>
        <Popconfirm
          title={t('manager.tasks.deleteConfirmTitle')}
          content={t('manager.tasks.deleteConfirm', { title: task.title })}
          okText={t('manager.tasks.deleteConfirmOk')}
          cancelText={t('manager.tasks.deleteConfirmCancel')}
          onOk={() => void store.run(() => store.client.removeTask({ id: task.id }))}
        >
          <span className='size-26px rd-6px flex items-center justify-center cursor-pointer text-t-secondary hover:bg-danger-light-1 hover:text-danger'>
            <Delete theme='outline' size='14' />
          </span>
        </Popconfirm>
      </div>
    </div>
  );
};

export default TaskCard;
