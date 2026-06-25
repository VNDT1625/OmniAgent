/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MachineProfile } from '@process/resource/leaseTypes';
import { Cpu, HardDisk, MemoryOne, GraphicDesign } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { formatMemory } from '../constants';
import SectionCard from './SectionCard';

/** A single labelled machine-stat tile. */
const StatTile: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className='flex items-center gap-12px bg-fill-1 rd-12px px-14px py-12px'>
    <span className='shrink-0 size-28px flex-center text-t-secondary'>{icon}</span>
    <div className='min-w-0'>
      <div className='text-12px text-t-tertiary truncate'>{label}</div>
      <div className='text-14px font-600 text-t-primary truncate'>{value}</div>
    </div>
  </div>
);

/**
 * Static host machine profile read at startup (criterion 5.1): total RAM, CPU
 * cores, discrete GPU presence, and free disk space.
 */
const MachineProfileCard: React.FC<{ machine: MachineProfile }> = ({ machine }) => {
  const { t } = useTranslation();
  const mb = t('resource.units.mb');
  const gb = t('resource.units.gb');

  return (
    <SectionCard icon={<Cpu theme='outline' size='18' />} title={t('resource.machine.title')}>
      <div className='grid grid-cols-2 lg:grid-cols-4 gap-12px'>
        <StatTile
          icon={<MemoryOne theme='outline' size='20' />}
          label={t('resource.machine.ram')}
          value={formatMemory(machine.totalMemMB, mb, gb)}
        />
        <StatTile
          icon={<Cpu theme='outline' size='20' />}
          label={t('resource.machine.cpu')}
          value={`${machine.cpuCores} ${t('resource.units.cores')}`}
        />
        <StatTile
          icon={<GraphicDesign theme='outline' size='20' />}
          label={t('resource.machine.gpu')}
          value={machine.hasDiscreteGPU ? t('resource.machine.gpuPresent') : t('resource.machine.gpuNone')}
        />
        <StatTile
          icon={<HardDisk theme='outline' size='20' />}
          label={t('resource.machine.disk')}
          value={formatMemory(machine.freeDiskMB, mb, gb)}
        />
      </div>
    </SectionCard>
  );
};

export default MachineProfileCard;
