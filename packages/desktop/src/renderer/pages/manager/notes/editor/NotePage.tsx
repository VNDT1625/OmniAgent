/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NotePage` — the Notion-style reading/writing page for a single note: a full
 * width cover banner (image/gif/video URL), a page icon/emoji overlapping the
 * cover, a large editable title, then the block editor ({@link NoteBlockEditor})
 * for the body. Mirrors how a Notion page reads top-to-bottom.
 *
 * It is self-contained around one {@link Note}: title/cover/icon edits and body
 * edits are reported upward via `onPatch`, which the caller persists through the
 * existing `updateNote` flow (body stays Markdown). Everything decorative
 * (cover/icon) is optional and stored on the note.
 *
 * Renderer-only. Chrome (buttons, inputs, popovers) uses Arco; only the body
 * editor surface is BlockNote (documented exception).
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Popover, Trigger } from '@arco-design/web-react';
import { Pic, Communication, Delete } from '@icon-park/react';
import type { Note } from '@process/manager/managerTypes';
import NoteBlockEditor from './NoteBlockEditor';
import styles from './NotePage.module.css';

/** A small, friendly emoji set for the page-icon picker (no extra dependency). */
const EMOJIS = ['📝', '📘', '💡', '🧠', '🔧', '🎯', '📌', '🗂️', '🧩', '⭐', '🔥', '🌱', '🧪', '📊', '🗺️', '🎨'];

/** A few tasteful gradient covers (used when the user has no image URL). */
const GRADIENTS = [
  'linear-gradient(120deg,#4b6cb7,#182848)',
  'linear-gradient(120deg,#2b6fd6,#5645d4)',
  'linear-gradient(120deg,#11998e,#38ef7d)',
  'linear-gradient(120deg,#e8730c,#dd5b00)',
  'linear-gradient(120deg,#cc2b5e,#753a88)',
  'linear-gradient(120deg,#373b44,#4286f4)',
];

type Props = {
  note: Note;
  /** Persist partial changes (title/cover/icon/body) to the store. */
  onPatch: (patch: Partial<Pick<Note, 'title' | 'body' | 'cover' | 'icon'>>) => void;
  /** Right-aligned actions (e.g. an "edit in modal" / delete button) slot. */
  headerExtra?: React.ReactNode;
  /** Whether the body editor is editable (reading view passes false). */
  editable?: boolean;
  /** Optional content rendered below the body (e.g. links/backlinks bar). */
  footer?: React.ReactNode;
  /**
   * Optional sticky toolbar rendered above the cover (back button, breadcrumb,
   * page actions). Used by the full-page editor overlay.
   */
  toolbar?: React.ReactNode;
  /**
   * Optional Notion-style properties block rendered between the title and the
   * body (tags, linked task/event, Data source fields). Keeps metadata editing
   * inline on the page instead of in a separate modal.
   */
  properties?: React.ReactNode;
  /** Placeholder for the body block editor. Defaults to the slash-command hint. */
  bodyPlaceholder?: string;
  /**
   * Bump this to force the body block editor to re-parse `note.body` from
   * scratch (e.g. after an AI fill rewrote the content). The editor otherwise
   * only parses on mount (keyed by note id) to avoid clobbering live edits.
   */
  bodyVersion?: string | number;
};

const isUrlCover = (cover: string): boolean => cover.startsWith('http') || cover.startsWith('data:');

const NotePage: React.FC<Props> = ({
  note,
  onPatch,
  headerExtra,
  editable = true,
  footer,
  toolbar,
  properties,
  bodyPlaceholder,
  bodyVersion,
}) => {
  const { t } = useTranslation();
  const [coverInput, setCoverInput] = useState('');

  const cover = note.cover ?? null;
  const icon = note.icon ?? null;

  const setCover = (value: string | null) => onPatch({ cover: value });
  const setIcon = (value: string | null) => onPatch({ icon: value });

  return (
    <div className={styles.page}>
      {toolbar && <div className={styles.toolbar}>{toolbar}</div>}
      {/* Cover */}
      {cover ? (
        <div className={styles.cover} style={isUrlCover(cover) ? undefined : { background: cover }}>
          {isUrlCover(cover) &&
            (/\.(mp4|webm|ogg)(\?|$)/i.test(cover) ? (
              <video className={styles.coverMedia} src={cover} autoPlay muted loop playsInline />
            ) : (
              <img className={styles.coverMedia} src={cover} alt='' />
            ))}
          {editable && (
            <div className={styles.coverTools}>
              <Popover
                trigger='click'
                position='br'
                content={
                  <CoverPicker
                    coverInput={coverInput}
                    setCoverInput={setCoverInput}
                    onPick={setCover}
                    onApplyUrl={() => coverInput.trim() && setCover(coverInput.trim())}
                  />
                }
              >
                <Button size='mini'>{t('manager.notePage.changeCover')}</Button>
              </Popover>
              <Button size='mini' icon={<Delete theme='outline' size='12' />} onClick={() => setCover(null)} />
            </div>
          )}
        </div>
      ) : null}

      <div className={styles.body}>
        {/* Icon overlapping the cover */}
        <div className={styles.iconRow} style={{ marginTop: cover ? -34 : 8 }}>
          {icon ? (
            <Trigger
              trigger='click'
              disabled={!editable}
              popup={() => <EmojiPicker onPick={(e) => setIcon(e)} onClear={() => setIcon(null)} />}
            >
              <span className={styles.pageIcon}>{icon}</span>
            </Trigger>
          ) : (
            editable && (
              <div className={styles.addRow}>
                <Trigger
                  trigger='click'
                  popup={() => <EmojiPicker onPick={(e) => setIcon(e)} onClear={() => setIcon(null)} />}
                >
                  <span className={styles.addBtn}>
                    <Communication theme='outline' size='13' /> {t('manager.notePage.addIcon')}
                  </span>
                </Trigger>
                {!cover && (
                  <Popover
                    trigger='click'
                    position='bl'
                    content={
                      <CoverPicker
                        coverInput={coverInput}
                        setCoverInput={setCoverInput}
                        onPick={setCover}
                        onApplyUrl={() => coverInput.trim() && setCover(coverInput.trim())}
                      />
                    }
                  >
                    <span className={styles.addBtn}>
                      <Pic theme='outline' size='13' /> {t('manager.notePage.addCover')}
                    </span>
                  </Popover>
                )}
              </div>
            )
          )}
          <div className='flex-1' />
          {headerExtra}
        </div>

        {/* Title */}
        <Input.TextArea
          className={styles.title}
          value={note.title ?? ''}
          onChange={(v) => onPatch({ title: v })}
          placeholder={t('manager.notePage.titlePlaceholder')}
          autoSize
          disabled={!editable}
        />

        {/* Notion-style properties (tags, links, source fields). */}
        {properties && <div className={styles.properties}>{properties}</div>}

        {/* Body block editor — remount per note via key so initial parse is clean. */}
        <div className={styles.editorWrap}>
          <NoteBlockEditor
            key={bodyVersion === undefined ? note.id : `${note.id}:${bodyVersion}`}
            value={note.body}
            editable={editable}
            onChange={(md) => onPatch({ body: md })}
            placeholder={bodyPlaceholder ?? t('manager.notePage.bodyPlaceholder')}
          />
        </div>

        {footer}
      </div>
    </div>
  );
};

/** Emoji grid + clear, shown in a popover. */
const EmojiPicker: React.FC<{ onPick: (e: string) => void; onClear: () => void }> = ({ onPick, onClear }) => {
  const { t } = useTranslation();
  return (
    <div className={styles.emojiPop}>
      <div className={styles.emojiGrid}>
        {EMOJIS.map((e) => (
          <span key={e} className={styles.emojiCell} onClick={() => onPick(e)}>
            {e}
          </span>
        ))}
      </div>
      <div className={styles.emojiClear} onClick={onClear}>
        {t('manager.notePage.removeIcon')}
      </div>
    </div>
  );
};

/** Cover picker: gradient swatches + a URL field for image/gif/video. */
const CoverPicker: React.FC<{
  coverInput: string;
  setCoverInput: (v: string) => void;
  onPick: (v: string) => void;
  onApplyUrl: () => void;
}> = ({ coverInput, setCoverInput, onPick, onApplyUrl }) => {
  const { t } = useTranslation();
  return (
    <div className={styles.coverPop}>
      <div className={styles.coverGrid}>
        {GRADIENTS.map((g) => (
          <span key={g} className={styles.coverSwatch} style={{ background: g }} onClick={() => onPick(g)} />
        ))}
      </div>
      <div className={styles.coverUrlRow}>
        <Input
          size='small'
          value={coverInput}
          onChange={setCoverInput}
          placeholder={t('manager.notePage.coverUrlPlaceholder')}
          onPressEnter={onApplyUrl}
        />
        <Button size='small' type='primary' onClick={onApplyUrl}>
          {t('manager.notePage.apply')}
        </Button>
      </div>
    </div>
  );
};

export default NotePage;
