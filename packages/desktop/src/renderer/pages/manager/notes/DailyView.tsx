/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daily notes — day-to-day notes / journal grouped by date (criterion 5.6, 5.7).
 *
 * Writing/editing happens in the full-page Notion-style editor
 * ({@link NotePageEditor}), so a journal entry gets the same cover/icon/title +
 * drag-and-drop block body as every other note. The list groups entries by
 * local day with a quiet date header.
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '@arco-design/web-react';
import { Plus, Search } from '@icon-park/react';
import type { Note } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import NoteCard from './NoteCard';
import NotePageEditor from './editor/NotePageEditor';

/** Local-day key (YYYY-MM-DD) for grouping. */
const dayKey = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const DailyView: React.FC<{ store: UseManagerStore }> = ({ store }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Note | 'new' | null>(null);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const daily = store.data.notes
      .filter((n) => n.category === 'daily')
      .filter((n) => q.length === 0 || (n.title ?? '').toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
      .toSorted((a, b) => (b.dayAt ?? b.createdAt) - (a.dayAt ?? a.createdAt));
    const map = new Map<string, Note[]>();
    for (const note of daily) {
      const key = dayKey(note.dayAt ?? note.createdAt);
      const list = map.get(key) ?? [];
      list.push(note);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [store.data.notes, query]);

  return (
    <div className='h-full overflow-y-auto px-24px pb-32px'>
      <div className='max-w-820px mx-auto flex flex-col gap-14px pt-12px'>
        <div className='flex items-center gap-8px'>
          <Input
            allowClear
            value={query}
            onChange={setQuery}
            prefix={<Search theme='outline' size='14' />}
            placeholder={t('manager.notes.search')}
            style={{ maxWidth: 280 }}
          />
          <div className='flex-1' />
          <Button type='primary' icon={<Plus theme='outline' size='14' />} onClick={() => setEditing('new')}>
            {t('manager.notes.daily.create')}
          </Button>
        </div>

        {groups.length === 0 ? (
          <div className='text-center text-13px text-t-tertiary py-40px'>{t('manager.notes.daily.empty')}</div>
        ) : (
          groups.map(([key, notes]) => (
            <div key={key} className='flex flex-col gap-8px'>
              <div className='text-12px font-[600] text-t-tertiary uppercase tracking-wide'>
                {new Date(notes[0].dayAt ?? notes[0].createdAt).toLocaleDateString([], {
                  weekday: 'long',
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </div>
              <div className='grid grid-cols-1 md:grid-cols-2 gap-12px'>
                {notes.map((note) => (
                  <NoteCard key={note.id} note={note} store={store} onEdit={() => setEditing(note)} />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {editing !== null && (
        <NotePageEditor
          store={store}
          note={editing === 'new' ? null : editing}
          category='daily'
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
};

export default DailyView;
