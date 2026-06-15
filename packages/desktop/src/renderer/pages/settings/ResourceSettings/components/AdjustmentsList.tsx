/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BudgetAdjustment } from '@process/resource/leaseTypes';
import { History } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { TASK_KINDS, taskKindLabelKey } from '../constants';
import SectionCard from './SectionCard';

type TFn = ReturnType<typeof useTranslation>['t'];

/**
 * Translate the diff between an adjustment's `from`/`to` budget snapshots into a
 * list of human-readable change strings (memory ceiling, user reserve, and any
 * per-kind concurrency changes). Returns an empty array when nothing changed.
 */
function describeChanges(adjustment: BudgetAdjustment, t: TFn): string[] {
  const { from, to } = adjustment;
  const changes: string[] = [];

  if (from.maxTotalMemoryMB !== to.maxTotalMemoryMB) {
    changes.push(t('resource.adjustments.memoryChange', { from: from.maxTotalMemoryMB, to: to.maxTotalMemoryMB }));
  }
  if (from.reserveForUserMB !== to.reserveForUserMB) {
    changes.push(t('resource.adjustments.reserveChange', { from: from.reserveForUserMB, to: to.reserveForUserMB }));
  }
  for (const kind of TASK_KINDS) {
    const a = from.maxConcurrent[kind];
    const b = to.maxConcurrent[kind];
    if (a !== b) {
      changes.push(t('resource.adjustments.concurrencyChange', { kind: t(taskKindLabelKey(kind)), from: a, to: b }));
    }
  }

  return changes;
}

/**
 * The adjustment-reason history (criterion 5.8).
 *
 * Renders each automatic budget adjustment newest-first with its reason, the
 * concrete before/after changes, and a timestamp — so the user can see WHY the
 * coordinator rebalanced. This visibility is an explicit acceptance criterion.
 */
const AdjustmentsList: React.FC<{ adjustments: BudgetAdjustment[] }> = ({ adjustments }) => {
  const { t, i18n } = useTranslation();

  // Newest first without mutating the source array.
  const ordered = [...adjustments].toSorted((a, b) => b.at - a.at);
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <SectionCard
      icon={<History theme='outline' size='18' />}
      title={t('resource.adjustments.title')}
      subtitle={t('resource.adjustments.subtitle')}
    >
      {ordered.length === 0 ? (
        <p className='m-0 text-13px text-t-tertiary'>{t('resource.adjustments.empty')}</p>
      ) : (
        <ol className='m-0 p-0 list-none flex flex-col gap-12px'>
          {ordered.map((adjustment, index) => {
            const changes = describeChanges(adjustment, t);
            return (
              <li
                key={`${adjustment.at}-${index}`}
                className='relative pl-16px border-l-2 border-solid border-primary/40'
              >
                <span className='absolute -left-5px top-6px size-8px rd-full bg-primary' />
                <div className='flex items-baseline justify-between gap-12px flex-wrap'>
                  <span className='text-13px font-600 text-t-primary'>{adjustment.reason}</span>
                  <time className='text-12px text-t-tertiary tabular-nums'>
                    {dateFormatter.format(new Date(adjustment.at))}
                  </time>
                </div>
                <ul className='m-0 mt-6px p-0 list-none flex flex-col gap-2px'>
                  {changes.length > 0 ? (
                    changes.map((change, changeIndex) => (
                      <li key={changeIndex} className='text-12px text-t-secondary tabular-nums'>
                        {change}
                      </li>
                    ))
                  ) : (
                    <li className='text-12px text-t-tertiary'>{t('resource.adjustments.noFieldChange')}</li>
                  )}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
};

export default AdjustmentsList;
