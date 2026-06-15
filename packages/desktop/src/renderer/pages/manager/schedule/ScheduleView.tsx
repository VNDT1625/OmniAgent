/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Schedule tab (Requirements 6, 7, 8). Day/week navigation, a conflict warning,
 * manual event create/edit, import-from-text/image, and AI optimisation with a
 * before/after review and undo.
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message, Radio } from '@arco-design/web-react';
import { Calendar, Left, Lightning, Plus, Right, Upload, Return, Setting } from '@icon-park/react';
import type { CalendarEvent, OptimizeResult } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import { DAY_MS, countConflicts, eventsInRange, startOfDay, startOfWeek, weekDays } from './scheduleUtils';
import DayWeekGrid from './DayWeekGrid';
import EventEditor from './EventEditor';
import ImportFromImage from './ImportFromImage';
import OptimizePanel from './OptimizePanel';
import ManagerSettingsModal from './ManagerSettingsModal';

const ScheduleView: React.FC<{ store: UseManagerStore }> = ({ store }) => {
  const { t } = useTranslation();
  const [view, setView] = useState<'day' | 'week'>('week');
  const [anchor, setAnchor] = useState<number>(() => Date.now());
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [plan, setPlan] = useState<{ result: OptimizeResult; before: CalendarEvent[] } | null>(null);
  const [undoBuffer, setUndoBuffer] = useState<CalendarEvent[] | null>(null);

  const days = useMemo(() => (view === 'week' ? weekDays(anchor) : [startOfDay(anchor)]), [view, anchor]);
  const rangeFrom = days[0];
  const rangeTo = days[days.length - 1] + DAY_MS;
  const visibleEvents = useMemo(
    () => eventsInRange(store.data.events, rangeFrom, rangeTo),
    [store.data.events, rangeFrom, rangeTo]
  );
  const conflicts = useMemo(() => countConflicts(visibleEvents), [visibleEvents]);

  const shift = (dir: -1 | 1) => {
    const step = view === 'week' ? 7 * DAY_MS : DAY_MS;
    setAnchor((prev) => prev + dir * step);
  };

  const handleOptimize = async () => {
    setOptimizing(true);
    try {
      const result = await store.client.aiOptimize({ from: rangeFrom, to: rangeTo });
      if (result.ok) {
        setPlan({ result: result.data, before: store.data.events });
      } else if ((result as { code?: string }).code === 'no-model') {
        Message.warning(t('manager.schedule.errorNoModel'));
      } else {
        Message.error(t('manager.schedule.import.errorGeneric'));
      }
    } catch {
      Message.error(t('manager.schedule.import.errorGeneric'));
    } finally {
      setOptimizing(false);
    }
  };

  const applyPlan = async () => {
    if (!plan) return;
    setApplying(true);
    try {
      const snapshot = store.data.events;
      const ok = await store.run(() => store.client.setEvents({ events: plan.result.proposed }));
      if (ok) {
        setUndoBuffer(snapshot);
        Message.success(t('manager.schedule.optimizeReview.applied'));
        setPlan(null);
      }
    } finally {
      setApplying(false);
    }
  };

  const handleUndo = async () => {
    if (!undoBuffer) {
      Message.info(t('manager.schedule.nothingToUndo'));
      return;
    }
    const ok = await store.run(() => store.client.setEvents({ events: undoBuffer }));
    if (ok) {
      setUndoBuffer(null);
      Message.success(t('manager.schedule.undone'));
    }
  };

  const rangeLabel = useMemo(() => {
    if (view === 'day')
      return new Date(days[0]).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    const start = startOfWeek(anchor);
    const end = start + 6 * DAY_MS;
    const fmt = (ts: number) => new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${fmt(start)} – ${fmt(end)}`;
  }, [view, days, anchor]);

  return (
    <div className='h-full overflow-y-auto px-24px pb-32px'>
      <div className='max-w-980px mx-auto flex flex-col gap-14px pt-4px'>
        {/* Toolbar */}
        <div className='flex items-center gap-8px flex-wrap'>
          <Radio.Group type='button' value={view} onChange={setView}>
            <Radio value='day'>{t('manager.schedule.viewDay')}</Radio>
            <Radio value='week'>{t('manager.schedule.viewWeek')}</Radio>
          </Radio.Group>
          <div className='flex items-center gap-2px'>
            <Button size='small' icon={<Left theme='outline' size='14' />} onClick={() => shift(-1)} />
            <Button size='small' icon={<Calendar theme='outline' size='14' />} onClick={() => setAnchor(Date.now())}>
              {t('manager.schedule.today')}
            </Button>
            <Button size='small' icon={<Right theme='outline' size='14' />} onClick={() => shift(1)} />
          </div>
          <span className='text-13px font-[600] text-t-primary'>{rangeLabel}</span>
          <div className='flex-1' />
          <Button size='small' icon={<Upload theme='outline' size='14' />} onClick={() => setImporting(true)}>
            {t('manager.schedule.importBtn')}
          </Button>
          <Button size='small' icon={<Setting theme='outline' size='14' />} onClick={() => setSettingsOpen(true)}>
            {t('manager.settings.action')}
          </Button>
          <Button
            size='small'
            icon={<Lightning theme='outline' size='14' />}
            loading={optimizing}
            onClick={() => void handleOptimize()}
          >
            {t('manager.schedule.optimize')}
          </Button>
          {undoBuffer && (
            <Button size='small' icon={<Return theme='outline' size='14' />} onClick={() => void handleUndo()}>
              {t('manager.schedule.undo')}
            </Button>
          )}
          <Button
            type='primary'
            size='small'
            icon={<Plus theme='outline' size='14' />}
            onClick={() => setEditing('new')}
          >
            {t('manager.schedule.create')}
          </Button>
        </div>

        {conflicts > 0 && (
          <div className='text-12px text-warning'>{t('manager.schedule.conflict', { count: conflicts })}</div>
        )}

        {visibleEvents.length === 0 && (
          <div className='text-center text-13px text-t-tertiary py-32px'>{t('manager.schedule.empty')}</div>
        )}

        <DayWeekGrid view={view} days={days} events={store.data.events} onEventClick={(event) => setEditing(event)} />
      </div>

      {editing !== null && (
        <EventEditor
          store={store}
          event={editing === 'new' ? null : editing}
          defaultStart={startOfDay(anchor) + 9 * 60 * 60_000}
          onClose={() => setEditing(null)}
        />
      )}
      {importing && <ImportFromImage store={store} onClose={() => setImporting(false)} />}
      {settingsOpen && <ManagerSettingsModal store={store} onClose={() => setSettingsOpen(false)} />}
      {plan && (
        <OptimizePanel
          result={plan.result}
          before={plan.before}
          applying={applying}
          onApply={() => void applyPlan()}
          onCancel={() => setPlan(null)}
        />
      )}
    </div>
  );
};

export default ScheduleView;
