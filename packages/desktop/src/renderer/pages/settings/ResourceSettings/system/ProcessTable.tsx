/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ProcessMetric, ProcessPriorityLevel } from '@process/system/systemInfoTypes';
import { Message, Select } from '@arco-design/web-react';
import { Application } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import SectionCard from '../components/SectionCard';
import { clampPercent, formatMemoryMB, toneForPercent } from './formatters';
import { PRIORITY_LEVELS, niceToLevel, priorityLabelKey } from './priorityOptions';

const TONE_TEXT: Record<'normal' | 'warning' | 'danger', string> = {
  normal: 'text-t-secondary',
  warning: 'text-warning',
  danger: 'text-danger',
};

/** Cap the rendered rows so a busy machine does not produce an endless table. */
const ROW_LIMIT = 24;

/**
 * Per-process table: the app's processes sorted heaviest-first, each with a
 * priority dropdown so the user can de-prioritise a hungry background process
 * (or boost one). Priority changes call the Main process and surface a toast.
 */
const ProcessTable: React.FC<{
  processes: ProcessMetric[];
  onSetPriority: (pid: number, level: ProcessPriorityLevel) => Promise<{ ok: boolean; error?: string }>;
}> = ({ processes, onSetPriority }) => {
  const { t } = useTranslation();
  const [pendingPid, setPendingPid] = useState<number | null>(null);

  const handleChange = async (process: ProcessMetric, level: ProcessPriorityLevel) => {
    setPendingPid(process.pid);
    try {
      const result = await onSetPriority(process.pid, level);
      if (result.ok) Message.success(t('system.process.prioritySet', { name: process.name }));
      else Message.warning(t('system.process.priorityError'));
    } catch {
      Message.warning(t('system.process.priorityError'));
    } finally {
      setPendingPid(null);
    }
  };

  const rows = processes.slice(0, ROW_LIMIT);

  return (
    <SectionCard
      icon={<Application theme='outline' size='18' />}
      title={t('system.process.title')}
      subtitle={t('system.process.subtitle')}
    >
      {rows.length === 0 ? (
        <p className='m-0 text-13px text-t-tertiary'>{t('system.process.none')}</p>
      ) : (
        <div className='flex flex-col'>
          <div className='flex items-center gap-12px px-2px pb-8px text-11px font-600 text-t-tertiary uppercase tracking-wide'>
            <span className='flex-1 min-w-0'>{t('system.process.name')}</span>
            <span className='w-64px text-right'>{t('system.process.cpu')}</span>
            <span className='w-80px text-right'>{t('system.process.memory')}</span>
            <span className='w-140px text-right'>{t('system.process.priority')}</span>
          </div>
          <div className='flex flex-col divide-y divide-border-2'>
            {rows.map((process) => {
              const cpu = clampPercent(process.cpuPercent);
              const tone = toneForPercent(cpu);
              const currentLevel = niceToLevel(process.priority) ?? undefined;
              return (
                <div key={process.pid} className='flex items-center gap-12px py-8px text-13px'>
                  <div className='flex-1 min-w-0'>
                    <div className='text-t-primary truncate'>{process.name}</div>
                    <div className='text-11px text-t-tertiary truncate'>
                      {process.type} · PID {process.pid}
                    </div>
                  </div>
                  <span className={`w-64px text-right tabular-nums ${TONE_TEXT[tone]}`}>
                    {process.cpuPercent.toFixed(1)}%
                  </span>
                  <span className='w-80px text-right tabular-nums text-t-secondary'>
                    {formatMemoryMB(process.memoryMB, t('system.units.mb'), t('system.units.gb'))}
                  </span>
                  <div className='w-140px flex justify-end'>
                    <Select
                      size='mini'
                      value={currentLevel}
                      placeholder={t('system.priority.normal')}
                      loading={pendingPid === process.pid}
                      disabled={pendingPid === process.pid}
                      onChange={(level) => handleChange(process, level as ProcessPriorityLevel)}
                      style={{ width: 132 }}
                      triggerProps={{ autoAlignPopupWidth: false }}
                    >
                      {PRIORITY_LEVELS.map((level) => (
                        <Select.Option key={level} value={level}>
                          {t(priorityLabelKey(level))}
                        </Select.Option>
                      ))}
                    </Select>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </SectionCard>
  );
};

export default ProcessTable;
