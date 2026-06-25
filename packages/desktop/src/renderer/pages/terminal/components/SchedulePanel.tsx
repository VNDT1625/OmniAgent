/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Empty, Popconfirm, Tag, Tooltip } from '@arco-design/web-react';
import { Time, Delete, Edit, Play, Plus } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalSchedule } from '@process/terminal/terminalTypes';

/**
 * Schedule manager (Phase 2): lists saved terminal schedules with their cron /
 * one-shot timing, last-run status, and per-schedule actions (run now, edit,
 * delete). The advanced "set a script to launch tools like 9router on a
 * schedule" capability the user asked for.
 */
type SchedulePanelProps = {
  schedules: TerminalSchedule[];
  onNew: () => void;
  onEdit: (schedule: TerminalSchedule) => void;
  onRunNow: (id: string) => void;
  onRemove: (id: string) => void;
};

const SchedulePanel: React.FC<SchedulePanelProps> = ({ schedules, onNew, onEdit, onRunNow, onRemove }) => {
  const { t } = useTranslation();

  const formatTiming = (schedule: TerminalSchedule): string => {
    if (schedule.kind === 'cron') return schedule.cron ?? '—';
    if (schedule.at) return new Date(schedule.at).toLocaleString();
    return '—';
  };

  return (
    <section className='flex flex-col gap-10px'>
      <div className='flex items-center justify-between gap-12px'>
        <div className='flex items-center gap-8px'>
          <Time theme='outline' size='16' className='text-t-secondary' />
          <h3 className='m-0 text-15px font-600 text-t-primary'>{t('terminal.schedule.title')}</h3>
          <Tag size='small' color='arcoblue'>
            {t('terminal.schedule.count', { count: schedules.length })}
          </Tag>
        </div>
        <Button type='primary' size='mini' icon={<Plus theme='outline' size='14' />} onClick={onNew}>
          {t('terminal.schedule.new')}
        </Button>
      </div>
      <p className='m-0 text-12px text-t-tertiary'>{t('terminal.schedule.hint')}</p>

      {schedules.length === 0 ? (
        <Empty description={t('terminal.schedule.empty')} />
      ) : (
        <div className='flex flex-col gap-8px'>
          {schedules.map((schedule) => (
            <div
              key={schedule.id}
              className='flex items-center gap-12px px-12px py-10px rd-10px bg-fill-1 b-1 b-solid border-b-1'
            >
              <div className='flex flex-col min-w-0 flex-1 gap-2px'>
                <div className='flex items-center gap-8px min-w-0'>
                  <span className='text-13px font-600 text-t-primary truncate'>{schedule.name}</span>
                  {!schedule.enabled && (
                    <Tag size='small' color='gray'>
                      {t('terminal.schedule.paused')}
                    </Tag>
                  )}
                  {schedule.lastStatus === 'ok' && (
                    <Tag size='small' color='green'>
                      {t('terminal.schedule.statusOk')}
                    </Tag>
                  )}
                  {schedule.lastStatus === 'error' && (
                    <Tooltip content={schedule.lastError ?? ''}>
                      <Tag size='small' color='red'>
                        {t('terminal.schedule.statusError')}
                      </Tag>
                    </Tooltip>
                  )}
                </div>
                <span className='text-11px text-t-tertiary truncate font-mono'>
                  {formatTiming(schedule)} · {schedule.shell || t('terminal.schedule.defaultShell')}
                </span>
              </div>

              <div className='flex items-center gap-4px shrink-0'>
                <Tooltip content={t('terminal.schedule.runNow')}>
                  <Button
                    type='text'
                    size='mini'
                    icon={<Play theme='outline' size='14' />}
                    onClick={() => onRunNow(schedule.id)}
                    aria-label={t('terminal.schedule.runNow')}
                  />
                </Tooltip>
                <Tooltip content={t('terminal.schedule.edit')}>
                  <Button
                    type='text'
                    size='mini'
                    icon={<Edit theme='outline' size='14' />}
                    onClick={() => onEdit(schedule)}
                    aria-label={t('terminal.schedule.edit')}
                  />
                </Tooltip>
                <Popconfirm
                  title={t('terminal.schedule.removeConfirm')}
                  onOk={() => onRemove(schedule.id)}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                >
                  <Button
                    type='text'
                    size='mini'
                    status='danger'
                    icon={<Delete theme='outline' size='14' />}
                    aria-label={t('terminal.schedule.remove')}
                  />
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export default SchedulePanel;
