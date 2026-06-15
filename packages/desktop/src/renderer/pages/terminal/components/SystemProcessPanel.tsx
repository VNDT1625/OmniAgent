/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Empty, Tag } from '@arco-design/web-react';
import { Refresh, Monitor } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SystemTerminalProcess } from '@process/terminal/terminalTypes';

/**
 * Read-only view of shell/terminal-like processes discovered on the whole
 * machine. These are NOT interactive — the app only counts and lists them (via
 * the OS process table). Clearly separated from the app-managed sessions, which
 * ARE interactive.
 */
type SystemProcessPanelProps = {
  processes: SystemTerminalProcess[];
  onRefresh: () => Promise<void>;
};

const SystemProcessPanel: React.FC<SystemProcessPanelProps> = ({ processes, onRefresh }) => {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className='flex flex-col gap-10px'>
      <div className='flex items-center justify-between gap-12px'>
        <div className='flex items-center gap-8px'>
          <Monitor theme='outline' size='16' className='text-t-secondary' />
          <h3 className='m-0 text-15px font-600 text-t-primary'>{t('terminal.system.title')}</h3>
          <Tag size='small' color='arcoblue'>
            {t('terminal.system.count', { count: processes.length })}
          </Tag>
        </div>
        <Button
          type='outline'
          size='mini'
          loading={refreshing}
          icon={<Refresh theme='outline' size='14' />}
          onClick={() => void handleRefresh()}
        >
          {t('terminal.system.refresh')}
        </Button>
      </div>
      <p className='m-0 text-12px text-t-tertiary'>{t('terminal.system.hint')}</p>

      {processes.length === 0 ? (
        <Empty description={t('terminal.system.empty')} />
      ) : (
        <div className='flex flex-wrap gap-8px'>
          {processes.map((proc) => (
            <div
              key={proc.pid}
              className='flex items-center gap-8px px-10px h-30px rd-8px bg-fill-2 b-1 b-solid border-b-1'
            >
              <span className='text-12px font-500 text-t-primary'>{proc.name}</span>
              <span className='text-11px text-t-tertiary'>PID {proc.pid}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export default SystemProcessPanel;
