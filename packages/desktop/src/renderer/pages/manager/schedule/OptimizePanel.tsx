/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AI schedule optimisation review (Requirement 8.4, 8.5, 8.6). Shows a
 * before/after comparison for the flexible events that moved, plus the AI's
 * rationale. The user applies or cancels; applying keeps a snapshot so the
 * change can be undone (the parent owns the undo buffer).
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Modal } from '@arco-design/web-react';
import { ArrowRight } from '@icon-park/react';
import type { CalendarEvent, OptimizeResult } from '@process/manager/managerTypes';
import { formatTimeRange } from './scheduleUtils';

type Props = {
  result: OptimizeResult;
  /** The events before optimisation, to compute the diff. */
  before: CalendarEvent[];
  onApply: () => void;
  onCancel: () => void;
  applying: boolean;
};

const OptimizePanel: React.FC<Props> = ({ result, before, onApply, onCancel, applying }) => {
  const { t } = useTranslation();
  const beforeById = new Map(before.map((e) => [e.id, e]));

  // Only show events whose time actually changed.
  const changes = result.proposed
    .map((after) => ({ after, prev: beforeById.get(after.id) }))
    .filter((c) => c.prev && (c.prev.startAt !== c.after.startAt || c.prev.endAt !== c.after.endAt));

  return (
    <Modal
      visible
      title={t('manager.schedule.optimizeReview.title')}
      onCancel={onCancel}
      footer={
        <div className='flex justify-end gap-8px'>
          <Button onClick={onCancel}>{t('manager.schedule.optimizeReview.cancel')}</Button>
          <Button type='primary' loading={applying} onClick={onApply}>
            {t('manager.schedule.applyPlan')}
          </Button>
        </div>
      }
      style={{ width: 560 }}
    >
      <div className='text-12px text-t-tertiary mb-10px'>{t('manager.schedule.optimizeReview.fixedKept')}</div>

      {changes.length === 0 ? (
        <div className='text-13px text-t-secondary py-12px text-center'>
          {t('manager.schedule.optimizeReview.noChanges')}
        </div>
      ) : (
        <div className='flex flex-col gap-8px'>
          {changes.map(({ after, prev }) => (
            <div key={after.id} className='rd-8px border border-solid border-arco-2 p-10px'>
              <div className='text-13px font-[600] text-t-primary mb-4px'>{after.title}</div>
              <div className='flex items-center gap-8px text-12px'>
                <span className='text-t-tertiary line-through'>
                  {prev && formatTimeRange(prev.startAt, prev.endAt)}
                </span>
                <ArrowRight theme='outline' size='13' className='text-t-tertiary' />
                <span className='text-primary font-[600]'>{formatTimeRange(after.startAt, after.endAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {result.rationale.length > 0 && (
        <ul className='mt-12px pl-16px flex flex-col gap-4px'>
          {result.rationale.map((reason, i) => (
            <li key={i} className='text-12px text-t-secondary list-disc'>
              {reason}
            </li>
          ))}
        </ul>
      )}

      {result.travelLegs && result.travelLegs.length > 0 && (
        <div className='mt-14px'>
          <div className='text-12px font-[600] text-t-secondary mb-6px'>{t('manager.settings.travelLegsTitle')}</div>
          <div className='flex flex-col gap-4px'>
            {result.travelLegs.map((leg, i) => (
              <div key={i} className='flex items-center gap-6px text-12px text-t-tertiary'>
                <span className='truncate max-w-160px'>{leg.fromLocation}</span>
                <ArrowRight theme='outline' size='12' />
                <span className='truncate max-w-160px'>{leg.toLocation}</span>
                <span className='text-t-secondary'>
                  · {Math.round(leg.durationSeconds / 60)} {t('manager.settings.minutesShort')} ·{' '}
                  {Math.round((leg.distanceMeters / 1000) * 10) / 10} km
                </span>
                {leg.source === 'estimate' && (
                  <span className='text-t-tertiary opacity-70'>· {t('manager.settings.estimated')}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
};

export default OptimizePanel;
