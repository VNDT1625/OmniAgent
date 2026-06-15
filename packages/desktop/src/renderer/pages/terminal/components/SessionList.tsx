/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Badge, Button, Tooltip } from '@arco-design/web-react';
import { Plus, Close, Delete, Time } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalSession } from '@process/terminal/terminalTypes';

/**
 * Left rail listing app-managed terminal sessions. Shows the live count, lets
 * the user create a new session, select one to interact with, kill a running
 * session, or remove an exited one.
 */
type SessionListProps = {
  sessions: TerminalSession[];
  runningCount: number;
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onKill: (id: string) => void;
  onRemove: (id: string) => void;
};

const SessionList: React.FC<SessionListProps> = ({
  sessions,
  runningCount,
  activeId,
  onSelect,
  onCreate,
  onKill,
  onRemove,
}) => {
  const { t } = useTranslation();

  return (
    <div className='flex flex-col gap-8px w-220px shrink-0 min-h-0'>
      <div className='flex items-center justify-between gap-8px'>
        <div className='flex items-center gap-6px text-13px font-600 text-t-primary'>
          <span>{t('terminal.sessions.title')}</span>
          <Badge count={runningCount} className='terminal-running-badge' />
        </div>
        <Tooltip content={t('terminal.sessions.new')}>
          <Button
            type='primary'
            size='mini'
            icon={<Plus theme='outline' size='14' />}
            onClick={onCreate}
            aria-label={t('terminal.sessions.new')}
          />
        </Tooltip>
      </div>

      <div className='flex flex-col gap-4px overflow-y-auto min-h-0 flex-1'>
        {sessions.length === 0 ? (
          <p className='m-0 px-8px py-12px text-12px text-t-tertiary'>{t('terminal.sessions.empty')}</p>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === activeId;
            const isRunning = session.status === 'running';
            return (
              <div
                key={session.id}
                role='button'
                tabIndex={0}
                onClick={() => onSelect(session.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onSelect(session.id);
                }}
                className={classNames(
                  'group flex items-center gap-8px px-8px h-40px rd-8px cursor-pointer transition-colors shrink-0',
                  isActive ? '!bg-fill-3' : 'hover:bg-fill-2'
                )}
              >
                <span
                  className={classNames('size-8px rd-full shrink-0', isRunning ? 'bg-success' : 'bg-fill-4')}
                  aria-hidden
                />
                <div className='flex flex-col min-w-0 flex-1'>
                  <div className='flex items-center gap-4px min-w-0'>
                    <span className='text-13px text-t-primary truncate'>{session.title}</span>
                    {session.scheduled && (
                      <Tooltip content={t('terminal.sessions.scheduledTag')}>
                        <Time theme='outline' size='12' className='text-t-tertiary shrink-0' />
                      </Tooltip>
                    )}
                  </div>
                  <span className='text-11px text-t-tertiary truncate'>
                    {isRunning ? `PID ${session.pid ?? '—'}` : t('terminal.sessions.exited')}
                  </span>
                </div>
                {isRunning ? (
                  <Tooltip content={t('terminal.sessions.kill')}>
                    <Button
                      type='text'
                      size='mini'
                      status='danger'
                      className='opacity-0 group-hover:opacity-100'
                      icon={<Close theme='outline' size='14' />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onKill(session.id);
                      }}
                      aria-label={t('terminal.sessions.kill')}
                    />
                  </Tooltip>
                ) : (
                  <Tooltip content={t('terminal.sessions.remove')}>
                    <Button
                      type='text'
                      size='mini'
                      className='opacity-0 group-hover:opacity-100 text-t-tertiary'
                      icon={<Delete theme='outline' size='14' />}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(session.id);
                      }}
                      aria-label={t('terminal.sessions.remove')}
                    />
                  </Tooltip>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SessionList;
