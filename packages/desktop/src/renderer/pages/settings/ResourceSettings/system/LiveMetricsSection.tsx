/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LiveSystemMetrics, MetricSample } from '@process/system/systemInfoTypes';
import { ChartHistogram, DashboardOne, Lightning, Time } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import SectionCard from '../components/SectionCard';
import Gauge from './Gauge';
import Sparkline from './Sparkline';
import { clampPercent, formatDuration, formatMemoryMB, toneForPercent } from './formatters';

const TONE_BAR: Record<'normal' | 'warning' | 'danger', string> = {
  normal: 'bg-primary',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

/** A small labelled chip for secondary live readouts (load, uptime, power). */
const Chip: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className='flex items-center gap-8px bg-fill-1 rd-10px px-12px py-8px'>
    <span className='shrink-0 size-22px flex-center text-t-secondary'>{icon}</span>
    <div className='min-w-0'>
      <div className='text-11px text-t-tertiary truncate'>{label}</div>
      <div className='text-13px font-600 text-t-primary truncate tabular-nums'>{value}</div>
    </div>
  </div>
);

/**
 * Live metrics: CPU + memory gauges, rolling sparklines, a per-core load grid,
 * and secondary chips (load average, uptime, power source). Updates on every
 * pushed sample while the page is open.
 */
const LiveMetricsSection: React.FC<{ live: LiveSystemMetrics; history: MetricSample[] }> = ({ live, history }) => {
  const { t } = useTranslation();
  const mb = t('system.units.mb');
  const gb = t('system.units.gb');

  const cpuSeries = history.map((sample) => sample.cpu);
  const memSeries = history.map((sample) => sample.mem);
  const hasLoadAvg = live.loadAvg.some((value) => value > 0);

  return (
    <SectionCard
      icon={<DashboardOne theme='outline' size='18' />}
      title={t('system.live.title')}
      subtitle={t('system.live.subtitle')}
    >
      <div className='flex flex-col gap-20px'>
        {/* Gauges + sparklines */}
        <div className='grid grid-cols-1 lg:grid-cols-2 gap-16px'>
          <div className='flex items-center gap-16px bg-fill-1 rd-12px p-16px'>
            <Gauge percent={live.cpu.overallPercent} label={t('system.live.cpu')} />
            <div className='flex-1 min-w-0'>
              <div className='text-12px text-t-tertiary mb-4px flex items-center gap-6px'>
                <ChartHistogram theme='outline' size='13' />
                {t('system.live.cpu')}
              </div>
              <Sparkline values={cpuSeries} colorClass='text-primary' />
            </div>
          </div>
          <div className='flex items-center gap-16px bg-fill-1 rd-12px p-16px'>
            <Gauge
              percent={live.memory.usedPercent}
              label={t('system.live.memory')}
              caption={`${formatMemoryMB(live.memory.usedMB, mb, gb)} / ${formatMemoryMB(live.memory.totalMB, mb, gb)}`}
            />
            <div className='flex-1 min-w-0'>
              <div className='text-12px text-t-tertiary mb-4px flex items-center gap-6px'>
                <ChartHistogram theme='outline' size='13' />
                {t('system.live.memory')}
              </div>
              <Sparkline values={memSeries} colorClass='text-success' />
            </div>
          </div>
        </div>

        {/* Per-core load grid */}
        {live.cpu.perCorePercent.length > 0 && (
          <div>
            <div className='text-12px font-600 text-t-secondary mb-8px'>{t('system.live.perCore')}</div>
            <div className='grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-8px'>
              {live.cpu.perCorePercent.map((percent, index) => {
                const value = clampPercent(percent);
                const tone = toneForPercent(value);
                return (
                  <div key={index} className='bg-fill-1 rd-8px px-8px py-6px'>
                    <div className='flex items-center justify-between text-10px text-t-tertiary mb-4px'>
                      <span>#{index + 1}</span>
                      <span className='tabular-nums'>{value}%</span>
                    </div>
                    <div className='h-4px rd-full bg-fill-3 overflow-hidden'>
                      <div
                        className={`h-full rd-full ${TONE_BAR[tone]}`}
                        style={{ width: `${value}%`, transition: 'width 400ms ease' }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Secondary chips */}
        <div className='grid grid-cols-2 lg:grid-cols-3 gap-10px'>
          <Chip
            icon={<Time theme='outline' size='15' />}
            label={t('system.live.uptime')}
            value={formatDuration(live.uptimeSec, {
              day: t('system.units.day'),
              hour: t('system.units.hour'),
              min: t('system.units.min'),
            })}
          />
          {hasLoadAvg && (
            <Chip
              icon={<DashboardOne theme='outline' size='15' />}
              label={t('system.live.loadAvg')}
              value={live.loadAvg.map((value) => value.toFixed(2)).join('  ')}
            />
          )}
          <Chip
            icon={<Lightning theme='outline' size='15' />}
            label={t('system.live.battery')}
            value={live.power.onBattery ? t('system.live.onBattery') : t('system.live.plugged')}
          />
        </div>
      </div>
    </SectionCard>
  );
};

export default LiveMetricsSection;
