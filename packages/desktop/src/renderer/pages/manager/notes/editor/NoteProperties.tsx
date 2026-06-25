/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NoteProperties` — a Notion-style inline "properties" block shown under the
 * page title (in {@link NotePage}'s `properties` slot). It replaces the old
 * create/edit modals: every note's metadata is edited directly on the page,
 * just like Notion.
 *
 * Fields adapt to the note's category:
 * - all     → Tags
 * - daily   → + linked Task / Event
 * - learn   → + linked Task / Event (wiki links live in the body + footer)
 * - data    → + URL, File path, an "Open source" action, and "AI summarize"
 *
 * Each change is persisted immediately through the existing `updateNote` flow
 * (selects/tags on change; free-text fields on blur), so there is no separate
 * "Save" step — edits are live, matching the block-editor body.
 *
 * Renderer-only. Arco + `@icon-park/react` + i18n. No Node.js APIs (file/URL
 * opening goes through the `ipcBridge.shell` surface).
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, InputTag, Message, Select, Tooltip } from '@arco-design/web-react';
import { Calendar, FileText, FolderOpen, Link, MagicWand, Tag as TagIcon, World } from '@icon-park/react';
import { ipcBridge } from '@/common';
import { openExternalUrl } from '@/renderer/utils/platform';
import type { Note, NoteCategory } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../../useManagerStore';
import styles from './NoteProperties.module.css';

const Option = Select.Option;

type Props = {
  note: Note;
  store: UseManagerStore;
  category: NoteCategory;
  /** Called after an AI summary rewrites the body, so the page can re-seed the editor. */
  onBodyReplaced?: (body: string) => void;
};

/** A single Notion-style property row: a quiet icon+label gutter and a control. */
const Row: React.FC<{ icon: React.ReactNode; label: string; children: React.ReactNode }> = ({
  icon,
  label,
  children,
}) => (
  <div className={styles.row}>
    <div className={styles.key}>
      <span className={styles.keyIcon}>{icon}</span>
      <span className={styles.keyLabel}>{label}</span>
    </div>
    <div className={styles.value}>{children}</div>
  </div>
);

const NoteProperties: React.FC<Props> = ({ note, store, category, onBodyReplaced }) => {
  const { t } = useTranslation();
  const { tasks, events } = store.data;

  // Local mirrors for free-text fields (persist on blur). Selects/tags persist
  // immediately so the change feels instant.
  const [url, setUrl] = useState(note.url ?? '');
  const [filePath, setFilePath] = useState(note.filePath ?? '');
  const [summarizing, setSummarizing] = useState(false);

  // Keep local text fields in sync when the note identity changes (or an agent
  // edit arrives via the live `dataChanged` push).
  useEffect(() => {
    setUrl(note.url ?? '');
    setFilePath(note.filePath ?? '');
  }, [note.id, note.url, note.filePath]);

  const patch = (p: Partial<Note>): void => void store.run(() => store.client.updateNote({ id: note.id, patch: p }));

  const openSource = async () => {
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

  const summarize = async () => {
    if (!(note.title ?? '').trim()) {
      Message.warning(t('manager.notes.data.titleRequired'));
      return;
    }
    setSummarizing(true);
    try {
      const res = await store.client.aiSummarizeDoc({
        title: (note.title ?? '').trim(),
        url: note.url || null,
        filePath: note.filePath || null,
        description: note.body,
      });
      if (res.ok) {
        const mergedTags = Array.from(new Set([...note.tags, ...res.data.tags]));
        const nextBody = res.data.summary || note.body;
        await store.run(() => store.client.updateNote({ id: note.id, patch: { body: nextBody, tags: mergedTags } }));
        onBodyReplaced?.(nextBody);
        Message.success(t('manager.notes.data.summarized'));
      } else if ((res as { code?: string }).code === 'no-model') {
        Message.warning(t('manager.notes.data.noModel'));
      } else {
        Message.error(t('manager.notes.data.summarizeFailed'));
      }
    } catch {
      Message.error(t('manager.notes.data.summarizeFailed'));
    } finally {
      setSummarizing(false);
    }
  };

  const hasSource = Boolean(note.url || note.filePath);

  return (
    <>
      <Row icon={<TagIcon theme='outline' size='14' />} label={t('manager.notes.tagsLabel')}>
        <InputTag
          value={note.tags}
          onChange={(tags) => patch({ tags })}
          placeholder={t('manager.notes.tagsPlaceholder')}
          className={styles.tagInput}
          size='small'
        />
      </Row>

      {category === 'data' && (
        <>
          <Row icon={<World theme='outline' size='14' />} label={t('manager.notes.data.fieldUrl')}>
            <div className={styles.sourceRow}>
              <Input
                value={url}
                onChange={setUrl}
                onBlur={() => url !== (note.url ?? '') && patch({ url: url || null })}
                placeholder='https://…'
                size='small'
              />
              {hasSource && (
                <Tooltip content={t('manager.notes.data.open')} mini>
                  <Button
                    size='small'
                    type='text'
                    icon={note.url ? <World theme='outline' size='14' /> : <FolderOpen theme='outline' size='14' />}
                    onClick={() => void openSource()}
                    aria-label={t('manager.notes.data.open')}
                  />
                </Tooltip>
              )}
            </div>
          </Row>
          <Row icon={<FileText theme='outline' size='14' />} label={t('manager.notes.data.fieldFile')}>
            <Input
              value={filePath}
              onChange={setFilePath}
              onBlur={() => filePath !== (note.filePath ?? '') && patch({ filePath: filePath || null })}
              placeholder='C:\…'
              size='small'
            />
          </Row>
        </>
      )}

      <Row icon={<Link theme='outline' size='14' />} label={t('manager.notes.linkTask')}>
        <Select
          allowClear
          value={note.linkedTaskId ?? undefined}
          onChange={(v) => patch({ linkedTaskId: v ?? null })}
          placeholder={t('manager.notes.linkTaskPlaceholder')}
          size='small'
          className={styles.select}
        >
          {tasks.length === 0 && (
            <Option disabled value='__none'>
              {t('manager.notes.noTasks')}
            </Option>
          )}
          {tasks.map((task) => (
            <Option key={task.id} value={task.id}>
              {task.title}
            </Option>
          ))}
        </Select>
      </Row>

      <Row icon={<Calendar theme='outline' size='14' />} label={t('manager.notes.linkEvent')}>
        <Select
          allowClear
          value={note.linkedEventId ?? undefined}
          onChange={(v) => patch({ linkedEventId: v ?? null })}
          placeholder={t('manager.notes.linkEventPlaceholder')}
          size='small'
          className={styles.select}
        >
          {events.length === 0 && (
            <Option disabled value='__none'>
              {t('manager.notes.noEvents')}
            </Option>
          )}
          {events.map((event) => (
            <Option key={event.id} value={event.id}>
              {event.title}
            </Option>
          ))}
        </Select>
      </Row>

      {category === 'data' && (
        <div className={styles.actions}>
          <Button
            size='small'
            loading={summarizing}
            icon={<MagicWand theme='outline' size='13' />}
            onClick={() => void summarize()}
          >
            {t('manager.notes.data.summarize')}
          </Button>
        </div>
      )}
    </>
  );
};

export default NoteProperties;
