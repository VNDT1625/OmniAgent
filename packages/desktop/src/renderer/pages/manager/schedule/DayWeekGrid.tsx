/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Day / week calendar grid (criterion 6.1). A lightweight column layout (one
 * column for Day, seven for Week) listing the events in each day, ordered by
 * start time. Clicking an event opens the editor.
 */

import React from 'react';
import type { CalendarEvent } from '@process/manager/managerTypes';
import { DAY_MS, eventsInRange, startOfDay } from './scheduleUtils';
import EventCard from './EventCard';

type Props = {
  view: 'day' | 'week';
  /** Day-start timestamps to render as columns. */
  days: number[];
  events: CalendarEvent[];
  onEventClick: (event: CalendarEvent) => void;
};

const dayLabel = (ts: number): { weekday: string; date: string } => {
  const d = new Date(ts);
  return {
    weekday: d.toLocaleDateString([], { weekday: 'short' }),
    date: d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
  };
};

const DayWeekGrid: React.FC<Props> = ({ view, days, events, onEventClick }) => {
  const isToday = (ts: number) => startOfDay(Date.now()) === ts;

  return (
    <div className={['grid gap-8px', view === 'week' ? 'grid-cols-7' : 'grid-cols-1'].join(' ')}>
      {days.map((day) => {
        const dayEvents = eventsInRange(events, day, day + DAY_MS);
        const { weekday, date } = dayLabel(day);
        return (
          <div key={day} className='flex flex-col gap-6px min-h-160px'>
            <div
              className={[
                'text-center py-4px rd-6px',
                isToday(day) ? 'bg-primary-light-1 text-primary' : 'text-t-secondary',
              ].join(' ')}
            >
              <div className='text-11px uppercase tracking-wide'>{weekday}</div>
              <div className='text-13px font-[600]'>{date}</div>
            </div>
            <div className='flex flex-col gap-6px'>
              {dayEvents.map((event) => (
                <EventCard key={event.id} event={event} compact={view === 'week'} onClick={() => onEventClick(event)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export default DayWeekGrid;
