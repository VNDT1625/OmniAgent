/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Data library (criterion 5.12–5.14) — a smart-managed list of study documents
 * (file path or URL) with AI summary + tags. Search/filter by keyword, tag, and
 * source kind; open the original file/URL.
 *
 * Creating/editing an entry opens the full-page Notion-style editor
 * ({@link NotePageEditor}), where the URL/file/summary/tags live in the inline
 * properties block and the long-form notes use the drag-and-drop block body.
 * Opening a source goes through the `ipcBridge.shell` surface (URLs via the
 * system browser, file paths via the OS default app) — never `window.open`.
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Message, Popconfirm, Select, Tag, Tooltip } from '@arco-design/web-react';
import { Delete, Edit, FileText, Plus, Search, World } from '@icon-park/react';
import { ipcBridge } from '@/common';
import { openExternalUrl } from '@/renderer/utils/platform';
import type { Note } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import NotePageEditor from './editor/NotePageEditor';
import styles from '../manager.module.css';

const Option = Select.Option;

type SourceFilter = 'all' | 'file' | 'url';

const DataView: React.FC<{ store: UseManagerStore }> = ({ store }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState<string | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [editing, setEditing] = useState<Note | 'new' | null>(null);

  const dataNotes = useMemo(() => store.data.notes.filter((n) => n.category === 'data'), [store.data.notes]);
  const allTags = useMemo(() => Array.from(new Set(dataNotes.flatMap((n) => n.tags))), [dataNotes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return dataNotes
      .filter((n) => {
        if (tagFilter !== 'all' && !n.tags.includes(tagFilter)) return false;
        if (sourceFilter === 'file' && !n.filePath) return false;
        if (sourceFilter === 'url' && !n.url) return false;
        if (q.length === 0) return true;
        return (n.title ?? '').toLowerCase().includes(q) || n.body.toLowerCase().includes(q);
      })
      .toSorted((a, b) => b.updatedAt - a.updatedAt);
  }, [dataNotes, query, tagFilter, sourceFilter]);

  // Open a document's source: URLs through the system browser, file paths
  // through the OS default app. Both go via the shell bridge (renderer-safe).
  const openSource = async (note: Note) => {
    try {
      if (note.url) {
        await openExternalUrl(note.url);
      } else if (note.filePath) {
        await ipcBridge.shell.openFile.invoke(note.filePath);
      }
    } catch {
      Message.error(t('manager.notes.data.openFailed'));
    }
  };

  return (
    <div className='h-full overflow-y-auto px-24px pb-32px'>
      <div className='max-w-880px mx-auto flex flex-col gap-14px pt-12px'>
        <div className='flex items-center gap-8px flex-wrap'>
          <Input
            allowClear
            value={query}
            onChange={setQuery}
            prefix={<Search theme='outline' size='14' />}
            placeholder={t('manager.notes.search')}
            style={{ maxWidth: 240 }}
          />
          <Select
            value={tagFilter}
            onChange={setTagFilter}
            style={{ width: 150 }}
            placeholder={t('manager.notes.filterTag')}
          >
            <Option value='all'>{t('manager.notes.filterTag')}</Option>
            {allTags.map((tag) => (
              <Option key={tag} value={tag}>
                #{tag}
              </Option>
            ))}
          </Select>
          <Select value={sourceFilter} onChange={setSourceFilter} style={{ width: 140 }}>
            <Option value='all'>{t('manager.notes.data.sourceAll')}</Option>
            <Option value='file'>{t('manager.notes.data.sourceFile')}</Option>
            <Option value='url'>{t('manager.notes.data.sourceUrl')}</Option>
          </Select>
          <div className='flex-1' />
          <Button type='primary' icon={<Plus theme='outline' size='14' />} onClick={() => setEditing('new')}>
            {t('manager.notes.data.create')}
          </Button>
        </div>

        {dataNotes.length === 0 ? (
          <div className='text-center text-13px text-t-tertiary py-40px'>{t('manager.notes.data.empty')}</div>
        ) : filtered.length === 0 ? (
          <div className='text-center text-13px text-t-tertiary py-12px'>{t('manager.notes.noResults')}</div>
        ) : (
          <div className='grid grid-cols-1 md:grid-cols-2 gap-12px'>
            {filtered.map((note) => (
              <div key={note.id} className={`group ${styles.row} p-12px flex flex-col gap-6px`}>
                <div className='flex items-start justify-between gap-8px'>
                  <div className='flex items-center gap-6px min-w-0'>
                    {note.url ? (
                      <World theme='outline' size='14' className='text-primary shrink-0' />
                    ) : (
                      <FileText theme='outline' size='14' className='text-t-secondary shrink-0' />
                    )}
                    <span className='text-14px font-[600] text-t-primary truncate'>
                      {note.title || t('manager.notes.untitled')}
                    </span>
                  </div>
                  <div className='flex items-center gap-2px opacity-0 group-hover:opacity-100 transition-opacity shrink-0'>
                    <Tooltip content={t('manager.notes.edit')}>
                      <span
                        role='button'
                        tabIndex={0}
                        aria-label={t('manager.notes.edit')}
                        className='size-24px rd-6px flex items-center justify-center cursor-pointer text-t-secondary hover:bg-fill-2 hover:text-t-primary outline-none focus-visible:ring-2 focus-visible:ring-primary'
                        onClick={() => setEditing(note)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setEditing(note);
                          }
                        }}
                      >
                        <Edit theme='outline' size='13' />
                      </span>
                    </Tooltip>
                    <Popconfirm
                      title={t('manager.notes.deleteConfirmTitle')}
                      content={t('manager.notes.deleteConfirm', { title: note.title || t('manager.notes.untitled') })}
                      onOk={() => void store.run(() => store.client.removeNote({ id: note.id }))}
                    >
                      <span
                        role='button'
                        tabIndex={0}
                        aria-label={t('manager.notes.delete')}
                        className='size-24px rd-6px flex items-center justify-center cursor-pointer text-t-secondary hover:bg-danger-light-1 hover:text-danger outline-none focus-visible:ring-2 focus-visible:ring-primary'
                      >
                        <Delete theme='outline' size='13' />
                      </span>
                    </Popconfirm>
                  </div>
                </div>
                {note.body && (
                  <div className='text-12px text-t-secondary line-clamp-3 whitespace-pre-wrap'>{note.body}</div>
                )}
                {(note.url || note.filePath) && (
                  <div
                    role='button'
                    tabIndex={0}
                    aria-label={t('manager.notes.data.open')}
                    className='text-11px text-t-tertiary truncate cursor-pointer hover:text-primary outline-none focus-visible:ring-2 focus-visible:ring-primary rd-4px'
                    onClick={() => void openSource(note)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        void openSource(note);
                      }
                    }}
                  >
                    {note.url || note.filePath}
                  </div>
                )}
                <div className='flex items-center gap-6px flex-wrap'>
                  {note.tags.map((tag) => (
                    <Tag key={tag} size='small' bordered>
                      #{tag}
                    </Tag>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing !== null && (
        <NotePageEditor
          store={store}
          note={editing === 'new' ? null : editing}
          category='data'
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
};

export default DataView;
