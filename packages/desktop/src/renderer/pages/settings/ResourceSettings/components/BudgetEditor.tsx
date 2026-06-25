/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResourceBudget, TaskKind } from '@process/resource/leaseTypes';
import { Button, InputNumber } from '@arco-design/web-react';
import { ChartHistogram, Lock, Save } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TASK_KINDS, taskKindLabelKey } from '../constants';
import SectionCard from './SectionCard';

/** Deep-clone the per-kind concurrency map so edits don't mutate the snapshot. */
function cloneBudget(budget: ResourceBudget): ResourceBudget {
  return {
    maxTotalMemoryMB: budget.maxTotalMemoryMB,
    reserveForUserMB: budget.reserveForUserMB,
    maxConcurrent: { ...budget.maxConcurrent },
  };
}

/** Shallow value-equality for two budgets (used to enable the Save button). */
function budgetsEqual(a: ResourceBudget, b: ResourceBudget): boolean {
  if (a.maxTotalMemoryMB !== b.maxTotalMemoryMB) return false;
  if (a.reserveForUserMB !== b.reserveForUserMB) return false;
  return TASK_KINDS.every((kind) => a.maxConcurrent[kind] === b.maxConcurrent[kind]);
}

/** A labelled numeric row used for both memory ceilings and concurrency limits. */
const NumberRow: React.FC<{
  label: string;
  value: number;
  suffix?: string;
  min?: number;
  disabled: boolean;
  onChange: (value: number) => void;
}> = ({ label, value, suffix, min = 0, disabled, onChange }) => (
  <div className='flex items-center justify-between gap-16px py-10px'>
    <span className='text-13px text-t-secondary min-w-0 truncate'>{label}</span>
    <InputNumber
      className='!w-128px shrink-0'
      size='small'
      value={value}
      min={min}
      step={1}
      disabled={disabled}
      suffix={suffix}
      onChange={(v) => onChange(typeof v === 'number' ? v : min)}
    />
  </div>
);

/**
 * Editable budget controls (criterion 5.2).
 *
 * In `detailed` mode every field is editable and a Save button commits the diff
 * via `setBudget`. In `suggest` mode the inputs are disabled (read-only) and a
 * lock hint is shown, since the coordinator owns the budget there.
 */
const BudgetEditor: React.FC<{
  budget: ResourceBudget;
  editable: boolean;
  onSave: (budget: Partial<ResourceBudget>) => void;
}> = ({ budget, editable, onSave }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ResourceBudget>(() => cloneBudget(budget));

  // Re-sync the local draft whenever the authoritative budget changes
  // (preset applied, mode switched, or a Tier-B self-balance pushed new values).
  useEffect(() => {
    setDraft(cloneBudget(budget));
  }, [budget]);

  const dirty = useMemo(() => !budgetsEqual(draft, budget), [draft, budget]);
  const mb = t('resource.units.mb');

  const setConcurrency = (kind: TaskKind, value: number) => {
    setDraft((prev) => ({ ...prev, maxConcurrent: { ...prev.maxConcurrent, [kind]: value } }));
  };

  return (
    <SectionCard
      icon={<ChartHistogram theme='outline' size='18' />}
      title={t('resource.budget.title')}
      subtitle={t('resource.budget.subtitle')}
      extra={
        editable ? (
          <Button
            type='primary'
            size='small'
            icon={<Save theme='outline' size='14' />}
            disabled={!dirty}
            onClick={() => onSave(draft)}
          >
            {t('resource.budget.save')}
          </Button>
        ) : (
          <span className='flex items-center gap-6px text-12px text-t-tertiary'>
            <Lock theme='outline' size='14' />
            {t('resource.budget.readOnlyHint')}
          </span>
        )
      }
    >
      <div className='grid grid-cols-1 lg:grid-cols-2 gap-x-24px'>
        <div className='flex flex-col divide-y divide-border-2'>
          <NumberRow
            label={t('resource.budget.memoryCeiling')}
            value={draft.maxTotalMemoryMB}
            suffix={mb}
            min={0}
            disabled={!editable}
            onChange={(v) => setDraft((prev) => ({ ...prev, maxTotalMemoryMB: v }))}
          />
          <NumberRow
            label={t('resource.budget.userReserve')}
            value={draft.reserveForUserMB}
            suffix={mb}
            min={0}
            disabled={!editable}
            onChange={(v) => setDraft((prev) => ({ ...prev, reserveForUserMB: v }))}
          />
        </div>
        <div className='mt-12px lg:mt-0'>
          <div className='text-12px font-600 text-t-tertiary uppercase tracking-wide mb-2px'>
            {t('resource.budget.concurrency')}
          </div>
          <div className='flex flex-col divide-y divide-border-2'>
            {TASK_KINDS.map((kind) => (
              <NumberRow
                key={kind}
                label={t(taskKindLabelKey(kind))}
                value={draft.maxConcurrent[kind] ?? 0}
                min={0}
                disabled={!editable}
                onChange={(v) => setConcurrency(kind, v)}
              />
            ))}
          </div>
        </div>
      </div>
    </SectionCard>
  );
};

export default BudgetEditor;
