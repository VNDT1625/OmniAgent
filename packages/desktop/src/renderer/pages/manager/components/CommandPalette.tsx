/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `CommandPalette` — a Ctrl/Cmd+K quick-switcher across the whole Manager
 * workspace (the feature every top productivity app converges on in 2026). One
 * fuzzy search box lists matching tasks, notes and events; picking one jumps to
 * its tab and (for notes) selects it. Keyboard-first: ↑/↓ move, Enter opens,
 * Esc closes.
 *
 * It is presentational + self-contained: the parent passes the data and a
 * `onNavigate(tab, id?)` callback, so the palette never reaches into stores.
 *
 * Renderer-only. Arco + UnoCSS + i18n.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Modal } from '@arco-design/web-react';
import { Calendar, NotebookOne, Search, Schedule } from '@icon-park/react';
import type { CalendarEvent, Note, Task } from '@process/manager/managerTypes';

export type ManagerTab = 'tasks' | 'notes' | 'schedule';

/** A flattened, searchable entry. */
type Entry = { kind: ManagerTab; id: string; title: string; sub?: string };

type Props = {
  visible: boolean;
  tasks: Task[];
  notes: Note[];
  events: CalendarEvent[];
  onClose: () => void;
  onNavigate: (tab: ManagerTab, id?: string) => void;
};

const MAX_RESULTS = 12;

const CommandPalette: React.FC<Props> = ({ visible, tasks, notes, events, onClose, onNavigate }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<{ focus: () => void } | null>(null);

  useEffect(() => {
    if (visible) {
      setQuery('');
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [visible]);

  const entries = useMemo<Entry[]>(() => {
    const all: Entry[] = [
      ...tasks.map((x) => ({ kind: 'tasks' as const, id: x.id, title: x.title, sub: t('manager.tabs.tasks') })),
      ...notes.map((x) => ({
        kind: 'notes' as const,
        id: x.id,
        title: x.title || x.body.slice(0, 40) || t('manager.notes.untitled'),
        sub: t(`manager.notes.cat.${x.category}`),
      })),
      ...events.map((x) => ({ kind: 'schedule' as const, id: x.id, title: x.title, sub: t('manager.tabs.schedule') })),
    ];
    const q = query.trim().toLowerCase();
    if (q.length === 0) return all.slice(0, MAX_RESULTS);
    return all.filter((e) => e.title.toLowerCase().includes(q)).slice(0, MAX_RESULTS);
  }, [tasks, notes, events, query, t]);

  const choose = (entry: Entry) => {
    onNavigate(entry.kind, entry.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (entries.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % entries.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + entries.length) % entries.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(entries[Math.min(active, entries.length - 1)]);
    }
  };

  const iconOf = (kind: ManagerTab) =>
    kind === 'tasks' ? (
      <Calendar theme='outline' size='14' />
    ) : kind === 'notes' ? (
      <NotebookOne theme='outline' size='14' />
    ) : (
      <Schedule theme='outline' size='14' />
    );

  return (
    <Modal
      visible={visible}
      footer={null}
      closable={false}
      onCancel={onClose}
      style={{ width: 560, top: 90 }}
      className='manager-command-palette'
      focusLock
    >
      <div onKeyDown={onKeyDown}>
        <Input
          ref={inputRef as never}
          value={query}
          onChange={(v) => {
            setQuery(v);
            setActive(0);
          }}
          size='large'
          prefix={<Search theme='outline' size='16' />}
          placeholder={t('manager.palette.placeholder')}
          allowClear
        />
        <div className='mt-10px flex flex-col gap-2px max-h-380px overflow-y-auto'>
          {entries.length === 0 ? (
            <div className='text-center text-13px text-t-tertiary py-24px'>{t('manager.palette.empty')}</div>
          ) : (
            entries.map((entry, i) => (
              <div
                key={`${entry.kind}-${entry.id}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(entry)}
                className={[
                  'flex items-center gap-10px px-10px py-8px rd-8px cursor-pointer',
                  i === active ? 'bg-primary-light-1 text-primary' : 'text-t-primary hover:bg-fill-2',
                ].join(' ')}
              >
                <span className='text-t-tertiary shrink-0'>{iconOf(entry.kind)}</span>
                <span className='flex-1 min-w-0 text-14px truncate'>{entry.title}</span>
                <span className='text-11px text-t-tertiary shrink-0'>{entry.sub}</span>
              </div>
            ))
          )}
        </div>
        <div className='mt-8px text-11px text-t-tertiary flex items-center gap-12px'>
          <span>↑ ↓ {t('manager.palette.move')}</span>
          <span>↵ {t('manager.palette.open')}</span>
          <span>esc {t('manager.palette.close')}</span>
        </div>
      </div>
    </Modal>
  );
};

export default CommandPalette;
