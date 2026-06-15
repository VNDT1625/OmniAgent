/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NotePageEditor` — the single, full-page Notion-style editor used to create
 * AND edit notes across every category (daily / learn / data). It replaces the
 * old `NoteEditor` / `DataEntryEditor` modals so writing always feels like a
 * Notion page: a cover, an icon, a big title, an inline properties block, and a
 * drag-and-drop block body (slash commands, tables, media) via {@link NotePage}.
 *
 * Lifecycle:
 * - Edit: opens immediately on the given note; edits persist live (no Save).
 * - Create: lazily creates an empty note of `category` on first mount, then
 *   behaves exactly like edit. If the user closes a brand-new note without
 *   adding any title/body, it is discarded so empty drafts don't pile up.
 *
 * It renders as a full-surface overlay over the Manager workspace (not a modal),
 * with a sticky toolbar carrying a Back button and a Delete action.
 *
 * Renderer-only. Arco + `@icon-park/react` + i18n. No Node.js APIs.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Message, Popconfirm, Spin, Tooltip } from '@arco-design/web-react';
import { Delete, Left, ListAdd } from '@icon-park/react';
import type { Note, NoteCategory } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../../useManagerStore';
import NotePage from './NotePage';
import NoteProperties from './NoteProperties';
import LearnLinksFooter from './LearnLinksFooter';
import styles from './NotePageEditor.module.css';

type Props = {
  store: UseManagerStore;
  /** The note to edit, or `null` to create a new one of `category`. */
  note: Note | null;
  category: NoteCategory;
  onClose: () => void;
  /** Learn-only: open another note by id (wiki-link / backlink navigation). */
  onOpenNote?: (id: string) => void;
};

const NotePageEditor: React.FC<Props> = ({ store, note, category, onClose, onOpenNote }) => {
  const { t } = useTranslation();

  // The id of the note being edited. For "create", we make an empty note up
  // front so all edits use the normal update flow; we remember it was freshly
  // created so we can discard it if left empty.
  const [noteId, setNoteId] = useState<string | null>(note?.id ?? null);
  const [creating, setCreating] = useState(note == null);
  const createdEmptyRef = useRef(note == null);
  const [bodyVersion, setBodyVersion] = useState(0);

  // Create an empty note once when opening in "new" mode.
  useEffect(() => {
    if (note != null) return;
    let alive = true;
    void (async () => {
      const next = await store.mutate(() => store.client.addNote({ input: { category, title: '', body: '' } }));
      if (!alive) return;
      // The freshly-added note is the last one of this category in the doc.
      const created = next ? next.notes.toReversed().find((n) => n.category === category) : undefined;
      if (created) setNoteId(created.id);
      else Message.error(t('manager.notes.saveFailed'));
      setCreating(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The live note from the store (reflects agent edits + our own updates).
  const live = useMemo(() => store.data.notes.find((n) => n.id === noteId) ?? null, [store.data.notes, noteId]);

  // Once the user gives the note any content, it is no longer a throwaway draft.
  useEffect(() => {
    if (live && ((live.title ?? '').trim() || live.body.trim())) createdEmptyRef.current = false;
  }, [live]);

  const patch = (p: Partial<Note>) => {
    if (!noteId) return;
    void store.run(() => store.client.updateNote({ id: noteId, patch: p }));
  };

  const close = async () => {
    // Discard an untouched freshly-created note so empty drafts don't pile up.
    if (createdEmptyRef.current && noteId && live && !(live.title ?? '').trim() && !live.body.trim()) {
      await store.run(() => store.client.removeNote({ id: noteId }));
    }
    onClose();
  };

  const remove = async () => {
    if (!noteId) return;
    const ok = await store.run(() => store.client.removeNote({ id: noteId }));
    if (ok) onClose();
    else Message.error(t('manager.notes.saveFailed'));
  };

  const convertToTask = async () => {
    if (!live) return;
    const title =
      (live.title && live.title.trim()) || live.body.split('\n')[0].slice(0, 80) || t('manager.notes.untitled');
    const ok = await store.run(() => store.client.addTask({ input: { title, description: live.body } }));
    if (ok) Message.success(t('manager.notes.convertedToTask'));
    else Message.error(t('manager.notes.convertFailed'));
  };

  // Esc closes the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, live]);

  const sectionLabel = t(`manager.notes.cat.${category}`);

  return (
    <div className={styles.overlay} role='dialog' aria-modal='true' aria-label={sectionLabel}>
      {creating || !live ? (
        <div className={styles.loading}>
          <Spin tip={t('manager.loading')} />
        </div>
      ) : (
        <NotePage
          note={live}
          onPatch={patch}
          bodyVersion={bodyVersion}
          bodyPlaceholder={category === 'learn' ? t('manager.notes.learn.linkHint') : undefined}
          toolbar={
            <>
              <Button type='text' size='small' icon={<Left theme='outline' size='16' />} onClick={() => void close()}>
                {t('manager.notes.back')}
              </Button>
              <span className={styles.crumb}>{sectionLabel}</span>
              <div className={styles.spacer} />
              <Tooltip content={t('manager.notes.toTask')} mini>
                <Button
                  type='text'
                  size='small'
                  icon={<ListAdd theme='outline' size='15' />}
                  onClick={() => void convertToTask()}
                  aria-label={t('manager.notes.toTask')}
                />
              </Tooltip>
              <Popconfirm
                title={t('manager.notes.deleteConfirmTitle')}
                content={t('manager.notes.deleteConfirm', { title: live.title || t('manager.notes.untitled') })}
                onOk={() => void remove()}
              >
                <Button
                  type='text'
                  size='small'
                  status='danger'
                  icon={<Delete theme='outline' size='15' />}
                  aria-label={t('manager.notes.delete')}
                />
              </Popconfirm>
            </>
          }
          properties={
            <NoteProperties
              note={live}
              store={store}
              category={category}
              onBodyReplaced={() => setBodyVersion((v) => v + 1)}
            />
          }
          footer={
            category === 'learn' && onOpenNote ? (
              <LearnLinksFooter note={live} notes={store.data.notes} onOpen={onOpenNote} />
            ) : undefined
          }
        />
      )}
    </div>
  );
};

export default NotePageEditor;
