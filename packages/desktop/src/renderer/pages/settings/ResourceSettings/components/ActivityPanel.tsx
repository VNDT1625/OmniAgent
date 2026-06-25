/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Lease, QueuedTask, TaskKind } from '@process/resource/leaseTypes';
import { SortThree } from '@icon-park/react';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { TASK_KINDS, taskKindLabelKey } from '../constants';
import SectionCard from './SectionCard';

/** A large headline metric (active / queued totals). */
const Metric: React.FC<{ value: number; label: string; tone: 'active' | 'queued' }> = ({ value, label, tone }) => (
  <div className='flex-1 bg-fill-1 rd-12px px-16px py-12px'>
    <div className={`text-24px font-700 leading-none ${tone === 'active' ? 'text-primary' : 'text-warning'}`}>
      {value}
    </div>
    <div className='text-12px text-t-tertiary mt-6px'>{label}</div>
  </div>
);

/**
 * Live activity view: total active leases and queued tasks, plus a per-kind
 * breakdown. Only task kinds with activity are listed to keep the panel compact;
 * when nothing is running an empty-state line is shown instead.
 */
const ActivityPanel: React.FC<{ active: Lease[]; queued: QueuedTask[] }> = ({ active, queued }) => {
  const { t } = useTranslation();

  // Tally active leases and queued tasks per kind in a single pass each.
  const { activeByKind, queuedByKind } = useMemo(() => {
    const a = {} as Record<TaskKind, number>;
    const q = {} as Record<TaskKind, number>;
    for (const lease of active) a[lease.kind] = (a[lease.kind] ?? 0) + 1;
    for (const task of queued) q[task.kind] = (q[task.kind] ?? 0) + 1;
    return { activeByKind: a, queuedByKind: q };
  }, [active, queued]);

  const rows = TASK_KINDS.filter((kind) => (activeByKind[kind] ?? 0) > 0 || (queuedByKind[kind] ?? 0) > 0);

  return (
    <SectionCard
      icon={<SortThree theme='outline' size='18' />}
      title={t('resource.leases.title')}
      subtitle={t('resource.leases.subtitle')}
    >
      <div className='flex gap-12px mb-16px'>
        <Metric value={active.length} label={t('resource.leases.activeTotal')} tone='active' />
        <Metric value={queued.length} label={t('resource.leases.queuedTotal')} tone='queued' />
      </div>

      {rows.length === 0 ? (
        <p className='m-0 text-13px text-t-tertiary'>{t('resource.leases.none')}</p>
      ) : (
        <div className='flex flex-col'>
          <div className='flex items-center gap-12px px-2px pb-8px text-12px font-600 text-t-tertiary uppercase tracking-wide'>
            <span className='flex-1'>{t('resource.leases.kindHeader')}</span>
            <span className='w-72px text-right'>{t('resource.leases.activeHeader')}</span>
            <span className='w-72px text-right'>{t('resource.leases.queuedHeader')}</span>
          </div>
          <div className='flex flex-col divide-y divide-border-2'>
            {rows.map((kind) => (
              <div key={kind} className='flex items-center gap-12px py-10px text-13px'>
                <span className='flex-1 text-t-primary truncate'>{t(taskKindLabelKey(kind))}</span>
                <span className='w-72px text-right text-t-secondary tabular-nums'>{activeByKind[kind] ?? 0}</span>
                <span className='w-72px text-right text-t-secondary tabular-nums'>{queuedByKind[kind] ?? 0}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  );
};

export default ActivityPanel;
