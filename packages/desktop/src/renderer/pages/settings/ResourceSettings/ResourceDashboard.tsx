/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ApplicablePreset, ResourceBudget, ResourceMode } from '@process/resource/leaseTypes';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { useSettingsViewMode } from '@/renderer/components/settings/SettingsModal/settingsViewContext';
import { Message, Spin } from '@arco-design/web-react';
import { Components } from '@icon-park/react';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import ActivityPanel from './components/ActivityPanel';
import AdjustmentsList from './components/AdjustmentsList';
import BudgetEditor from './components/BudgetEditor';
import MachineProfileCard from './components/MachineProfileCard';
import ModeSelector from './components/ModeSelector';
import PresetButtons from './components/PresetButtons';
import SystemInsightPanel from './system/SystemInsightPanel';
import { useResourceState } from './useResourceState';

/**
 * Resource Dashboard content (Requirement 5.2, 5.3, 5.8).
 *
 * Composes the machine profile, mode switch, quick presets, editable budget,
 * live activity, and the adjustment-reason history into a single scrollable
 * surface. Live state comes from {@link useResourceState}, which subscribes to
 * the coordinator's `stateChanged` push.
 */
const ResourceDashboard: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const { state, status, setMode, applyPreset, setBudget } = useResourceState();

  const handleModeChange = useCallback(
    (mode: ResourceMode) => {
      setMode(mode).catch(() => Message.error(t('resource.mode.changeError')));
    },
    [setMode, t]
  );

  const handleApplyPreset = useCallback(
    (preset: ApplicablePreset) => {
      applyPreset(preset)
        .then(() => Message.success(t('resource.preset.applied')))
        .catch(() => Message.error(t('resource.preset.applyError')));
    },
    [applyPreset, t]
  );

  const handleSaveBudget = useCallback(
    (budget: Partial<ResourceBudget>) => {
      setBudget(budget)
        .then(() => Message.success(t('resource.budget.saved')))
        .catch(() => Message.error(t('resource.budget.saveError')));
    },
    [setBudget, t]
  );

  return (
    <div className='flex flex-col h-full w-full'>
      <header className='mb-16px'>
        <h2 className='m-0 text-20px font-700 text-t-primary'>{t('resource.title')}</h2>
        <p className='m-0 mt-4px text-13px text-t-secondary'>{t('resource.subtitle')}</p>
      </header>

      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        <div className='flex flex-col gap-24px'>
          {/* System observation — the whole-machine view the user asked for. */}
          <SystemInsightPanel />

          {/* Resource coordinator (lease budget + self-balancing). */}
          <section className='flex flex-col gap-16px'>
            <header>
              <h3 className='m-0 text-16px font-700 text-t-primary'>{t('resource.coordinatorTitle')}</h3>
              <p className='m-0 mt-2px text-12px text-t-tertiary'>{t('resource.coordinatorSubtitle')}</p>
            </header>

            {status === 'loading' && (
              <div className='flex-center py-32px'>
                <Spin size={24} />
              </div>
            )}

            {status === 'error' && (
              <div className='flex flex-col items-center gap-12px py-32px text-center'>
                <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
                  <Components theme='outline' size='24' />
                </span>
                <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('resource.loadError')}</p>
              </div>
            )}

            {status === 'ready' && state && (
              <div className='flex flex-col gap-16px'>
                <MachineProfileCard machine={state.machine} />
                <div className='grid grid-cols-1 lg:grid-cols-2 gap-16px'>
                  <ModeSelector mode={state.mode} onChange={handleModeChange} />
                  <PresetButtons current={state.preset} onApply={handleApplyPreset} disabled={state.mode === 'suggest'} />
                </div>
                <BudgetEditor budget={state.budget} editable={state.mode === 'detailed'} onSave={handleSaveBudget} />
                <ActivityPanel active={state.active} queued={state.queued} />
                <AdjustmentsList adjustments={state.lastAdjustments} />
              </div>
            )}
          </section>
        </div>
      </AionScrollArea>
    </div>
  );
};

export default ResourceDashboard;
