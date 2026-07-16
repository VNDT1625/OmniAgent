/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A single calendar event chip. Fixed events get a lock icon + warning-tinted
 * border so they read as immovable (criterion 7.3); flexible events use the
 * primary tint. Colours come from semantic tokens (no hardcoded hex).
 */

import React from 'react';
import { Lock, Unlock } from '@icon-park/react';
import type { CalendarEvent } from '@process/manager/managerTypes';
import { formatTimeRange } from './scheduleUtils';

const EventCard: React.FC<{ event: CalendarEvent; onClick: () => void; compact?: boolean }> = ({
  event,
  onClick,
  compact,
}) => {
  const fixed = event.lockKind === 'fixed';
  // Notion-style: a soft surface with a coloured left rail (accent for flexible,
  // warning for locked) instead of a fully tinted box — calmer, more editorial.
  const rail = fixed ? 'var(--warning)' : 'var(--mgr-accent, var(--primary))';
  return (
    <div
      onClick={onClick}
      className='rd-6px cursor-pointer px-8px py-6px bg-fill-1 hover:bg-fill-2 transition-colors'
      style={{ borderLeft: `3px solid ${rail}` }}
    >
      <div className='flex items-center gap-4px'>
        {fixed ? (
          <Lock theme='outline' size='11' className='text-warning shrink-0' />
        ) : (
          <Unlock
            theme='outline'
            size='11'
            className='shrink-0'
            style={{ color: 'var(--mgr-accent, var(--primary))' }}
          />
        )}
        <span className='text-12px font-[600] text-t-primary truncate'>{event.title}</span>
      </div>
      {!compact && (
        <div className='text-11px text-t-secondary mt-2px'>{formatTimeRange(event.startAt, event.endAt)}</div>
      )}
      {!compact && event.location && <div className='text-11px text-t-tertiary truncate'>{event.location}</div>}
    </div>
  );
};

export default EventCard;
