/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tasks tab (Requirements 1–4). Lays out the day-focused panel, the AI-create
 * box, filters, and the grouped task list. Designed to reduce visual overload
 * (criterion 4.1): "today / next" is foregrounded, completed work is collapsed,
 * and a progress bar gives a sense of accomplishment (criterion 4.4).
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from '@arco-design/web-react';
import { Plus } from '@icon-park/react';
import type { Task, TaskKind, Priority, TaskStatus } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import { PRIORITIES, STATUSES, TASK_KINDS, priorityKey, statusKey, taskKindKey } from '../managerStrings';
import TaskCard from './TaskCard';
import TodayPanel from './TodayPanel';
import TaskEditor from './TaskEditor';
import AiCreateTasks from './AiCreateTasks';
import ReviewTasks from './ReviewTasks';
import QuickAdd from './QuickAdd';

const Option = Select.Option;

const TasksView: React.FC<{ store: UseManagerStore }> = ({ store }) => {
  const { t } = useTranslation();
  const { data } = store;

  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<Priority | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<TaskKind | 'all'>('all');
  const [editing, setEditing] = useState<Task | 'new' | null>(null);

  const filtered = useMemo(() => {
    return data.tasks.filter((task) => {
      if (statusFilter !== 'all' && task.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false;
      if (kindFilter !== 'all' && task.kind !== kindFilter) return false;
      return true;
    });
  }, [data.tasks, statusFilter, priorityFilter, kindFilter]);

  // Group: active (not done) sorted by due/priority, then a collapsed "done" set.
  const active = filtered.filter((task) => task.status !== 'done');
  const done = filtered.filter((task) => task.status === 'done');

  return (
    <div className='h-full overflow-y-auto px-24px pb-32px'>
      <div className='max-w-880px mx-auto flex flex-col gap-16px pt-4px'>
        {/* Day focus + progress */}
        <TodayPanel store={store} onEdit={(task) => setEditing(task)} />

        {/* Quick natural-language add */}
        <QuickAdd store={store} />

        {/* AI create from description */}
        <AiCreateTasks store={store} />

        {/* Toolbar: filters + new */}
        <div className='flex items-center gap-8px flex-wrap'>
          <Select
            size='small'
            value={statusFilter}
            onChange={(v) => setStatusFilter(v)}
            style={{ width: 140 }}
            aria-label={t('manager.tasks.filterStatus')}
          >
            <Option value='all'>{t('manager.tasks.filterStatusAll')}</Option>
            {STATUSES.map((s) => (
              <Option key={s} value={s}>
                {t(statusKey(s))}
              </Option>
            ))}
          </Select>
          <Select size='small' value={priorityFilter} onChange={(v) => setPriorityFilter(v)} style={{ width: 140 }}>
            <Option value='all'>{t('manager.tasks.filterPriorityAll')}</Option>
            {PRIORITIES.map((p) => (
              <Option key={p} value={p}>
                {t(priorityKey(p))}
              </Option>
            ))}
          </Select>
          <Select size='small' value={kindFilter} onChange={(v) => setKindFilter(v)} style={{ width: 140 }}>
            <Option value='all'>{t('manager.tasks.filterKindAll')}</Option>
            {TASK_KINDS.map((k) => (
              <Option key={k} value={k}>
                {t(taskKindKey(k))}
              </Option>
            ))}
          </Select>
          <div className='flex-1' />
          <ReviewTasks store={store} onOpenTask={(task) => setEditing(task)} />
          <Button
            type='primary'
            size='small'
            icon={<Plus theme='outline' size='14' />}
            onClick={() => setEditing('new')}
          >
            {t('manager.tasks.create')}
          </Button>
        </div>

        {/* Active tasks */}
        {active.length === 0 && done.length === 0 && (
          <div className='text-center text-13px text-t-tertiary py-40px'>{t('manager.tasks.empty')}</div>
        )}
        {active.length === 0 && done.length > 0 && (
          <div className='text-center text-13px text-t-tertiary py-12px'>{t('manager.tasks.noMatches')}</div>
        )}
        <div className='flex flex-col gap-8px'>
          {active.map((task) => (
            <TaskCard key={task.id} task={task} store={store} onEdit={() => setEditing(task)} />
          ))}
        </div>

        {/* Completed (collapsed visual treatment) */}
        {done.length > 0 && (
          <div className='flex flex-col gap-8px mt-8px'>
            <div className='text-12px font-[600] text-t-tertiary uppercase tracking-wide'>
              {t('manager.tasks.done')} · {done.length}
            </div>
            {done.map((task) => (
              <TaskCard key={task.id} task={task} store={store} onEdit={() => setEditing(task)} />
            ))}
          </div>
        )}
      </div>

      {editing !== null && (
        <TaskEditor store={store} task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
};

export default TasksView;
