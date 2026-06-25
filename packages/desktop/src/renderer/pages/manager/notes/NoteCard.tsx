/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A single note card: title, a snippet of the body, tags, a "linked" badge, and
 * hover actions (edit / convert-to-task / delete).
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Message, Popconfirm, Tooltip } from '@arco-design/web-react';
import { Delete, Edit, ListAdd } from '@icon-park/react';
import type { Note } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import styles from '../manager.module.css';

const NoteCard: React.FC<{ note: Note; store: UseManagerStore; onEdit: () => void }> = ({ note, store, onEdit }) => {
  const { t } = useTranslation();
  const linked = note.linkedTaskId || note.linkedEventId;

  const convertToTask = async () => {
    const title =
      (note.title && note.title.trim()) || note.body.split('\n')[0].slice(0, 80) || t('manager.notes.untitled');
    const ok = await store.run(() => store.client.addTask({ input: { title, description: note.body } }));
    if (ok) Message.success(t('manager.notes.convertedToTask'));
    else Message.error(t('manager.notes.convertFailed'));
  };

  return (
    <div className={`group ${styles.row} p-12px flex flex-col gap-6px min-h-100px`}>
      <div className='flex items-start justify-between gap-8px'>
        <div className='text-14px font-[600] text-t-primary truncate'>{note.title || t('manager.notes.untitled')}</div>
        <div className='flex items-center gap-2px opacity-0 group-hover:opacity-100 transition-opacity shrink-0'>
          <Tooltip content={t('manager.notes.edit')}>
            <span
              className='size-24px rd-6px flex items-center justify-center cursor-pointer text-t-secondary hover:bg-fill-2 hover:text-t-primary'
              onClick={onEdit}
            >
              <Edit theme='outline' size='13' />
            </span>
          </Tooltip>
          <Tooltip content={t('manager.notes.toTask')}>
            <span
              className='size-24px rd-6px flex items-center justify-center cursor-pointer text-t-secondary hover:bg-fill-2 hover:text-primary'
              onClick={() => void convertToTask()}
            >
              <ListAdd theme='outline' size='13' />
            </span>
          </Tooltip>
          <Popconfirm
            title={t('manager.notes.deleteConfirmTitle')}
            content={t('manager.notes.deleteConfirm', { title: note.title || t('manager.notes.untitled') })}
            onOk={() => void store.run(() => store.client.removeNote({ id: note.id }))}
          >
            <span className='size-24px rd-6px flex items-center justify-center cursor-pointer text-t-secondary hover:bg-danger-light-1 hover:text-danger'>
              <Delete theme='outline' size='13' />
            </span>
          </Popconfirm>
        </div>
      </div>

      <div className='text-12px text-t-secondary line-clamp-4 whitespace-pre-wrap flex-1'>{note.body}</div>

      <div className='flex items-center gap-6px flex-wrap'>
        {note.tags.map((tag) => (
          <span key={tag} className='px-6px py-1px rd-full bg-fill-2 text-t-secondary text-11px'>
            #{tag}
          </span>
        ))}
        {linked && (
          <span className='px-6px py-1px rd-full bg-primary-light-1 text-primary text-11px'>
            {t('manager.notes.linked')}
          </span>
        )}
      </div>
    </div>
  );
};

export default NoteCard;
