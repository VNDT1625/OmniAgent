/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Day-focus panel (criterion 4.1, 4.4). Foregrounds what's due today / next and
 * shows today's completion progress, so the user starts from a calm, finite set
 * rather than a long list.
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Progress } from '@arco-design/web-react';
import type { Task } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import { isDueToday, isSameDay } from '../managerStrings';
import TaskCard from './TaskCard';
import styles from '../manager.module.css';

const TodayPanel: React.FC<{ store: UseManagerStore; onEdit: (task: Task) => void }> = ({ store, onEdit }) => {
  const { t } = useTranslation();
  const now = Date.now();
  const tasks = store.data.tasks;

  const { todayTasks, completedToday, totalToday } = useMemo(() => {
    const dueToday = tasks.filter((task) => task.status !== 'done' && isDueToday(task.dueAt, now));
    // Tasks completed today contribute to the progress sense-of-done.
    const doneToday = tasks.filter(
      (task) => task.status === 'done' && task.completedAt != null && isSameDay(task.completedAt, now)
    );
    const total = dueToday.length + doneToday.length;
    return { todayTasks: dueToday, completedToday: doneToday.length, totalToday: total };
  }, [tasks, now]);

  const percent = totalToday === 0 ? 0 : Math.round((completedToday / totalToday) * 100);

  return (
    <div className={styles.card}>
      <div className='flex items-end justify-between mb-12px'>
        <div className='flex flex-col gap-3px'>
          <span className={styles.eyebrow}>{t('manager.tasks.today')}</span>
          <span className='text-22px font-[650] text-t-primary leading-none' style={{ letterSpacing: '-0.5px' }}>
            {completedToday}
            <span className='text-15px font-[500] text-t-tertiary'> / {totalToday}</span>
          </span>
        </div>
        <div className='flex items-center gap-10px'>
          <span className='text-12px text-t-tertiary'>
            {t('manager.tasks.todayProgressCount', { done: completedToday, total: totalToday })}
          </span>
          <Progress
            type='circle'
            percent={percent}
            size='mini'
            color='var(--mgr-accent)'
            status={percent === 100 && totalToday > 0 ? 'success' : 'normal'}
          />
        </div>
      </div>

      {todayTasks.length === 0 ? (
        <div className='text-12.5px text-t-tertiary py-6px'>{t('manager.tasks.noDue')}</div>
      ) : (
        <div className='flex flex-col gap-7px'>
          {todayTasks.map((task) => (
            <TaskCard key={task.id} task={task} store={store} onEdit={() => onEdit(task)} />
          ))}
        </div>
      )}
    </div>
  );
};

export default TodayPanel;
