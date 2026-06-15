/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StaticSystemInfo } from '@process/system/systemInfoTypes';
import { Button, Tooltip } from '@arco-design/web-react';
import { Components, Cpu, GraphicDesign, HardDisk, MemoryOne, Refresh, Wifi } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import SectionCard from '../components/SectionCard';
import { formatMemoryMB } from './formatters';

/** A labelled key/value row inside the static profile grid. */
const InfoRow: React.FC<{ icon?: React.ReactNode; label: string; value: string; mono?: boolean }> = ({ icon, label, value, mono }) => (
  <div className='flex items-start gap-10px bg-fill-1 rd-10px px-12px py-10px min-w-0'>
    {icon && <span className='shrink-0 size-22px flex-center text-t-secondary mt-2px'>{icon}</span>}
    <div className='min-w-0 flex-1'>
      <div className='text-11px text-t-tertiary truncate'>{label}</div>
      <div className={`text-13px font-600 text-t-primary break-words ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  </div>
);

/**
 * Static host profile (OS, CPU, RAM, GPU, disks, network, versions). Read at
 * startup and re-read only via the Refresh button — these values rarely change.
 */
const StaticInfoSection: React.FC<{ info: StaticSystemInfo; onRefresh: () => void; refreshing: boolean }> = ({ info, onRefresh, refreshing }) => {
  const { t } = useTranslation();
  const mb = t('system.units.mb');
  const gb = t('system.units.gb');

  const gpuValue = info.gpus.length > 0 ? info.gpus.map((gpu) => `${gpu.vendor} ${gpu.model}`.trim()).join(', ') : t('system.static.gpuNone');
  const networkValue =
    info.network.length > 0 ? info.network.map((iface) => `${iface.name}: ${iface.addresses[0] ?? iface.mac}`).join('  •  ') : t('system.static.noNetwork');
  const versionsValue = `App ${info.versions.app} · Electron ${info.versions.electron} · Chromium ${info.versions.chrome} · Node ${info.versions.node}`;

  return (
    <SectionCard
      icon={<Components theme='outline' size='18' />}
      title={t('system.static.title')}
      subtitle={t('system.static.subtitle')}
      extra={
        <Tooltip content={t('system.refresh')}>
          <Button size='small' type='secondary' loading={refreshing} icon={<Refresh theme='outline' size='14' />} onClick={onRefresh}>
            {t('system.refresh')}
          </Button>
        </Tooltip>
      }
    >
      <div className='grid grid-cols-1 md:grid-cols-2 gap-10px'>
        <InfoRow icon={<Components theme='outline' size='16' />} label={t('system.static.os')} value={`${info.os.type} ${info.os.release} (${info.os.arch})`} />
        <InfoRow label={t('system.static.hostname')} value={`${info.os.hostname} · ${info.os.username}`} />
        <InfoRow icon={<Cpu theme='outline' size='16' />} label={t('system.static.cpu')} value={`${info.cpu.model} — ${t('system.static.cores', { count: info.cpu.logicalCores })}${info.cpu.speedMHz ? ` @ ${(info.cpu.speedMHz / 1000).toFixed(2)} GHz` : ''}`} />
        <InfoRow icon={<MemoryOne theme='outline' size='16' />} label={t('system.static.memory')} value={formatMemoryMB(info.totalMemoryMB, mb, gb)} />
        <InfoRow icon={<GraphicDesign theme='outline' size='16' />} label={t('system.static.gpu')} value={gpuValue} />
        <InfoRow
          icon={<HardDisk theme='outline' size='16' />}
          label={t('system.static.disk')}
          value={info.disks.map((disk) => `${formatMemoryMB(disk.freeMB, mb, gb)} / ${formatMemoryMB(disk.totalMB, mb, gb)}`).join(', ') || '—'}
        />
        <InfoRow icon={<Wifi theme='outline' size='16' />} label={t('system.static.network')} value={networkValue} />
        <InfoRow label={t('system.static.versions')} value={versionsValue} mono />
      </div>
    </SectionCard>
  );
};

export default StaticInfoSection;
