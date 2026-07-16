/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `LearnLinksFooter` — the outgoing `[[wiki]]` links + backlinks panel shown
 * below a Learn note's body. Extracted so both the read pane and the full-page
 * editor share one implementation. Each link is keyboard-operable (role+tabIndex
 * + Enter/Space) for accessibility.
 *
 * Renderer-only. Arco icons + i18n. No Node.js APIs.
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { LinkOne } from '@icon-park/react';
import type { Note } from '@process/manager/managerTypes';
import { extractWikiTargets, findBacklinks, resolveWikiTarget } from '../linking/wikiLinks';

type Props = {
  note: Note;
  notes: Note[];
  /** Open a note by id (selecting it in the list / pane). */
  onOpen: (id: string) => void;
};

/** A keyboard-operable link row. */
const LinkRow: React.FC<{ label: string; muted?: boolean; onClick: () => void }> = ({ label, muted, onClick }) => (
  <div
    role='button'
    tabIndex={0}
    onClick={onClick}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    }}
    className={[
      'text-12px cursor-pointer truncate outline-none rd-4px px-2px',
      'focus-visible:ring-2 focus-visible:ring-primary',
      muted ? 'text-t-tertiary' : 'text-primary hover:underline',
    ].join(' ')}
  >
    {label}
  </div>
);

const LearnLinksFooter: React.FC<Props> = ({ note, notes, onOpen }) => {
  const { t } = useTranslation();
  const outgoing = useMemo(() => extractWikiTargets(note.body), [note.body]);
  const backlinks = useMemo(() => findBacklinks(note, notes), [note, notes]);

  const openTarget = (target: string) => {
    const found = resolveWikiTarget(target, notes);
    if (found) onOpen(found.id);
  };

  return (
    <div className='grid grid-cols-2 gap-12px mt-16px'>
      <div className='rd-8px border border-solid border-arco-2 p-10px'>
        <div className='flex items-center gap-4px text-12px font-[600] text-t-secondary mb-6px'>
          <LinkOne theme='outline' size='13' /> {t('manager.notes.learn.outgoing')}
        </div>
        {outgoing.length === 0 ? (
          <div className='text-12px text-t-tertiary'>{t('manager.notes.learn.none')}</div>
        ) : (
          outgoing.map((target) => {
            const exists = Boolean(resolveWikiTarget(target, notes));
            return (
              <LinkRow
                key={target}
                label={`[[${target}]]${exists ? '' : ` · ${t('manager.notes.learn.missing')}`}`}
                muted={!exists}
                onClick={() => openTarget(target)}
              />
            );
          })
        )}
      </div>
      <div className='rd-8px border border-solid border-arco-2 p-10px'>
        <div className='flex items-center gap-4px text-12px font-[600] text-t-secondary mb-6px'>
          <LinkOne theme='outline' size='13' /> {t('manager.notes.learn.backlinks')}
        </div>
        {backlinks.length === 0 ? (
          <div className='text-12px text-t-tertiary'>{t('manager.notes.learn.none')}</div>
        ) : (
          backlinks.map((b) => (
            <LinkRow key={b.id} label={b.title || t('manager.notes.untitled')} onClick={() => onOpen(b.id)} />
          ))
        )}
      </div>
    </div>
  );
};

export default LearnLinksFooter;
