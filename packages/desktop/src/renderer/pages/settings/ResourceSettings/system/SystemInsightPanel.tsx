/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Message, Spin } from '@arco-design/web-react';
import { Components } from '@icon-park/react';
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import LiveMetricsSection from './LiveMetricsSection';
import ProcessTable from './ProcessTable';
import StaticInfoSection from './StaticInfoSection';
import { useSystemMetrics } from './useSystemMetrics';

/**
 * System Insight panel (Settings › Quan sát).
 *
 * Composes the static host profile (Refresh-on-demand), the live metrics
 * (gauges + sparklines + per-core load) and the per-process priority table.
 * Live data comes from {@link useSystemMetrics}, which subscribes to the
 * Main-process sampler push while mounted.
 */
const SystemInsightPanel: React.FC = () => {
  const { t } = useTranslation();
  const { status, staticInfo, live, history, refreshStatic, setProcessPriority } = useSystemMetrics();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    refreshStatic()
      .then(() => Message.success(t('system.refreshed')))
      .catch(() => Message.error(t('system.refreshError')))
      .finally(() => setRefreshing(false));
  }, [refreshStatic, t]);

  if (status === 'loading') {
    return (
      <div className='flex-center py-48px'>
        <Spin size={26} />
      </div>
    );
  }

  if (status === 'error' && !staticInfo) {
    return (
      <div className='flex flex-col items-center gap-12px py-48px text-center'>
        <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
          <Components theme='outline' size='24' />
        </span>
        <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('system.loadError')}</p>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-16px'>
      {staticInfo && <StaticInfoSection info={staticInfo} onRefresh={handleRefresh} refreshing={refreshing} />}
      {live ? <LiveMetricsSection live={live} history={history} /> : <p className='m-0 text-13px text-t-tertiary px-4px'>{t('system.live.waiting')}</p>}
      {live && <ProcessTable processes={live.processes} onSetPriority={setProcessPriority} />}
    </div>
  );
};

export default SystemInsightPanel;
