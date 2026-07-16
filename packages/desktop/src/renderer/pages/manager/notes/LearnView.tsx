/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Learn notes (criterion 5.8–5.11) — Obsidian-style study notes. A two-pane
 * layout: the note list on the left, the selected note's body + its outgoing
 * `[[wiki]]` links and backlinks on the right (rendered inline via the shared
 * {@link NotePage}). Creating or opening a note for focused writing launches the
 * full-page Notion-style editor ({@link NotePageEditor}); an "AI research"
 * action searches the web and synthesizes a new study note. A graph mode shows
 * the link network.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Radio } from '@arco-design/web-react';
import { LinkOne, Plus, Search, Share } from '@icon-park/react';
import type { Note } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import NotePageEditor from './editor/NotePageEditor';
import ResearchModal from './ResearchModal';
import LinkGraphView from './linking/LinkGraphView';
import LearnLinksFooter from './editor/LearnLinksFooter';
import NotePage from './editor/NotePage';
import styles from '../manager.module.css';

const LearnView: React.FC<{ store: UseManagerStore; focusId?: string | null; onFocusConsumed?: () => void }> = ({
  store,
  focusId,
  onFocusConsumed,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  const [researching, setResearching] = useState(false);
  const [mode, setMode] = useState<'read' | 'graph'>('read');

  // Reveal a note requested from the command palette: select it + read mode.
  useEffect(() => {
    if (!focusId) return;
    setSelectedId(focusId);
    setMode('read');
    onFocusConsumed?.();
  }, [focusId, onFocusConsumed]);

  const learnNotes = useMemo(() => store.data.notes.filter((n) => n.category === 'learn'), [store.data.notes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return learnNotes
      .filter((n) => q.length === 0 || (n.title ?? '').toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
      .toSorted((a, b) => b.updatedAt - a.updatedAt);
  }, [learnNotes, query]);

  const selected = useMemo(() => learnNotes.find((n) => n.id === selectedId) ?? null, [learnNotes, selectedId]);

  return (
    <div className='h-full flex'>
      {/* List pane */}
      <div className='w-300px shrink-0 border-r border-solid border-arco-2 flex flex-col'>
        <div className='p-12px flex flex-col gap-8px'>
          <Input
            allowClear
            value={query}
            onChange={setQuery}
            prefix={<Search theme='outline' size='14' />}
            placeholder={t('manager.notes.search')}
          />
          <div className='flex gap-6px'>
            <Button
              size='small'
              type='primary'
              icon={<Plus theme='outline' size='13' />}
              onClick={() => setEditing('new')}
              className='flex-1'
            >
              {t('manager.notes.learn.create')}
            </Button>
            <Button
              size='small'
              icon={<Search theme='outline' size='13' />}
              onClick={() => setResearching(true)}
              className='flex-1'
            >
              {t('manager.notes.learn.research')}
            </Button>
          </div>
          <Radio.Group type='button' size='small' value={mode} onChange={setMode} style={{ display: 'flex' }}>
            <Radio value='read' style={{ flex: 1, textAlign: 'center' }}>
              <span className='flex items-center justify-center gap-4px'>
                <LinkOne theme='outline' size='13' /> {t('manager.notes.learn.modeRead')}
              </span>
            </Radio>
            <Radio value='graph' style={{ flex: 1, textAlign: 'center' }}>
              <span className='flex items-center justify-center gap-4px'>
                <Share theme='outline' size='13' /> {t('manager.notes.learn.modeGraph')}
              </span>
            </Radio>
          </Radio.Group>
        </div>
        <div className='flex-1 overflow-y-auto px-8px pb-12px flex flex-col gap-4px'>
          {filtered.length === 0 ? (
            <div className='text-center text-12px text-t-tertiary py-24px'>{t('manager.notes.learn.empty')}</div>
          ) : (
            filtered.map((note) => (
              <div
                key={note.id}
                role='button'
                tabIndex={0}
                aria-pressed={note.id === selectedId}
                onClick={() => setSelectedId(note.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedId(note.id);
                  }
                }}
                className={[
                  styles.listItem,
                  'outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  note.id === selectedId ? styles.listItemActive : '',
                ].join(' ')}
              >
                <div className='text-13px font-[500] truncate'>{note.title || t('manager.notes.untitled')}</div>
                <div className='text-11px text-t-tertiary truncate'>
                  {note.body.replace(/[#*[\]]/g, '').slice(0, 60)}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Detail / graph pane */}
      {mode === 'graph' ? (
        <div className='flex-1 min-w-0 p-16px'>
          <LinkGraphView
            notes={learnNotes}
            selectedId={selectedId}
            onSelect={(id) => {
              setSelectedId(id);
              setMode('read');
            }}
          />
        </div>
      ) : (
        <div className='flex-1 min-w-0 overflow-y-auto'>
          {!selected ? (
            <div className='h-full flex items-center justify-center text-13px text-t-tertiary'>
              {t('manager.notes.learn.selectHint')}
            </div>
          ) : (
            <NotePage
              key={selected.id}
              note={selected}
              onPatch={(patch) => void store.run(() => store.client.updateNote({ id: selected.id, patch }))}
              bodyPlaceholder={t('manager.notes.learn.linkHint')}
              footer={<LearnLinksFooter note={selected} notes={learnNotes} onOpen={(id) => setSelectedId(id)} />}
            />
          )}
        </div>
      )}

      {editing !== null && (
        <NotePageEditor
          store={store}
          note={editing === 'new' ? null : editing}
          category='learn'
          onClose={() => setEditing(null)}
          onOpenNote={(id) => {
            setEditing(null);
            setSelectedId(id);
            setMode('read');
          }}
        />
      )}
      {researching && <ResearchModal store={store} onClose={() => setResearching(false)} />}
    </div>
  );
};

export default LearnView;
