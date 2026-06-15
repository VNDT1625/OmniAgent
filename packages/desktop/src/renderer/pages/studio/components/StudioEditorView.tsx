/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `StudioEditorView` — the open-file view of Studio. A slim header (back to
 * dashboard + file name + type label + AI toggle + star) over a split body: the
 * {@link UniversalEditor} on the right and the {@link DocAssistantPanel} on the
 * left. Both share ONE file buffer via {@link useUniversalEditor} so the AI
 * panel can read the current text and apply rewrites straight into the editor.
 *
 * Two space-reclaiming affordances give the (often cramped) document more room:
 * - **Collapse header** (a chevron): hides the header bar so only the editor
 *   shows; a tiny floating chevron brings it back.
 * - **Fullscreen**: the view breaks out of the Studio chrome to cover the whole
 *   window (`position: fixed`). It stays MOUNTED (no remount) so the live
 *   ONLYOFFICE editor + AI run keep going. Esc exits.
 *
 * Renderer-only.
 */

import { Button, Tooltip } from '@arco-design/web-react';
import { Left, Robot, Star, StarOne, CloseSmall, Share, FullScreen, OffScreen, Up, Down } from '@icon-park/react';
import React, { Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveAdapterKind } from '@renderer/pages/editor/editorRegistry';
import { useUniversalEditor } from '@renderer/pages/editor/hooks/useUniversalEditor';
import {
  fetchParticipants,
  unpublishCollab,
  type CollabParticipant,
  type PublishInfo,
} from '@renderer/pages/editor/adapters/collabClient';
import { FILE_KIND_META } from '../fileKindMeta';
import { baseName } from '../studioStorage';
import DocAssistantPanel from './DocAssistantPanel';
import CollabModal from './CollabModal';

const UniversalEditor = React.lazy(() => import('@renderer/pages/editor/UniversalEditor'));

type StudioEditorViewProps = {
  filePath: string;
  starred: boolean;
  onBack: () => void;
  onClose: () => void;
  onStar: (path: string) => void;
};

const StudioEditorView: React.FC<StudioEditorViewProps> = ({ filePath, starred, onBack, onClose, onStar }) => {
  const { t } = useTranslation();
  const name = baseName(filePath);
  const kind = resolveAdapterKind({ fileName: name });
  const meta = FILE_KIND_META[kind];
  const Icon = meta.Icon;

  // One shared file controller for the editor.
  const controller = useUniversalEditor({ filePath });
  const [showAssistant, setShowAssistant] = useState(true);
  // Space-reclaiming affordances for the cramped document area.
  const [fullscreen, setFullscreen] = useState(false);
  const [headerCollapsed, setHeaderCollapsed] = useState(false);

  // Esc exits fullscreen (matches the Browser page behavior).
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // Collaboration: when published, this host's session is live; poll presence.
  const [collabOpen, setCollabOpen] = useState(false);
  const [share, setShare] = useState<PublishInfo | null>(null);
  const [participants, setParticipants] = useState<CollabParticipant[]>([]);

  useEffect(() => {
    if (!share) return;
    let alive = true;
    const poll = async (): Promise<void> => {
      const list = await fetchParticipants(share.shareId);
      if (alive) setParticipants(list);
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [share]);

  // Stop sharing when the editor view is torn down (file closed).
  useEffect(
    () => () => {
      if (share) void unpublishCollab(share.shareId);
    },
    [share]
  );

  return (
    <div
      className={
        fullscreen ? 'fixed inset-0 z-1000 flex flex-col min-h-0 bg-1' : 'relative size-full flex flex-col min-h-0 bg-1'
      }
    >
      {headerCollapsed ? (
        // Collapsed: a tiny floating chevron re-opens the header without
        // stealing vertical space from the document.
        <Tooltip content={t('studio.editor.showHeader')} mini position='right'>
          <Button
            type='primary'
            size='mini'
            className='!absolute left-12px top-12px z-20 !rd-full shadow'
            aria-label={t('studio.editor.showHeader')}
            icon={<Down theme='outline' size={14} />}
            onClick={() => setHeaderCollapsed(false)}
          />
        </Tooltip>
      ) : (
        <header className='shrink-0 flex items-center gap-12px px-16px h-52px border-b border-b-1'>
          <Button type='text' icon={<Left theme='outline' size={18} />} className='!text-t-secondary' onClick={onBack}>
            {t('studio.action.back')}
          </Button>
          <span className={`flex-center shrink-0 ${meta.accentClass}`}>
            <Icon theme='outline' size={18} fill='currentColor' />
          </span>
          <span className='text-14px font-[500] text-t-primary truncate'>{name}</span>
          <span className='text-12px text-t-tertiary'>· {t(meta.labelKey)}</span>
          <div className='flex-1' />
          {share ? <PresenceStrip participants={participants} /> : null}
          <Tooltip content={share ? t('studio.collab.live') : t('studio.collab.title')} mini>
            <Button
              type={share ? 'primary' : 'text'}
              status={share ? 'success' : undefined}
              className={share ? '' : '!text-t-secondary'}
              icon={<Share theme='outline' size={16} />}
              onClick={() => setCollabOpen(true)}
            >
              {share ? t('studio.collab.live') : t('studio.collab.share')}
            </Button>
          </Tooltip>
          <Tooltip content={showAssistant ? t('studio.assistant.hide') : t('studio.assistant.show')} mini>
            <Button
              type={showAssistant ? 'primary' : 'text'}
              className={showAssistant ? '' : '!text-t-secondary'}
              icon={<Robot theme='outline' size={16} />}
              onClick={() => setShowAssistant((v) => !v)}
            >
              {t('studio.assistant.title')}
            </Button>
          </Tooltip>
          <Tooltip content={fullscreen ? t('studio.editor.exitFullscreen') : t('studio.editor.fullscreen')} mini>
            <Button
              type='text'
              className={fullscreen ? '!text-primary' : '!text-t-tertiary'}
              aria-label={fullscreen ? t('studio.editor.exitFullscreen') : t('studio.editor.fullscreen')}
              icon={fullscreen ? <OffScreen theme='outline' size={16} /> : <FullScreen theme='outline' size={16} />}
              onClick={() => setFullscreen((v) => !v)}
            />
          </Tooltip>
          <Tooltip content={t('studio.editor.hideHeader')} mini>
            <Button
              type='text'
              className='!text-t-tertiary'
              aria-label={t('studio.editor.hideHeader')}
              icon={<Up theme='outline' size={16} />}
              onClick={() => setHeaderCollapsed(true)}
            />
          </Tooltip>
          <Tooltip content={starred ? t('studio.action.unstar') : t('studio.action.star')} mini>
            <Button
              type='text'
              className={starred ? '!text-warning' : '!text-t-tertiary'}
              icon={starred ? <Star theme='filled' size={16} /> : <StarOne theme='outline' size={16} />}
              onClick={() => onStar(filePath)}
            />
          </Tooltip>
          <Tooltip content={t('studio.action.closeFile')} mini>
            <Button
              type='text'
              className='!text-t-tertiary'
              icon={<CloseSmall theme='outline' size={18} />}
              onClick={onClose}
            />
          </Tooltip>
        </header>
      )}
      <div className='flex-1 min-h-0 flex gap-12px p-16px'>
        {showAssistant ? (
          <div className='w-340px shrink-0 min-h-0'>
            <DocAssistantPanel filePath={filePath} fileName={name} onClose={() => setShowAssistant(false)} />
          </div>
        ) : null}
        <div className='flex-1 min-w-0 min-h-0'>
          <Suspense fallback={null}>
            <UniversalEditor filePath={filePath} controller={controller} />
          </Suspense>
        </div>
      </div>
      <CollabModal
        visible={collabOpen}
        filePath={filePath}
        onClose={() => setCollabOpen(false)}
        onPublished={(info) => setShare(info)}
        onJoined={() => setCollabOpen(false)}
        defaultTab='publish'
      />
    </div>
  );
};

/** A row of participant avatars (cursor colors) for the live session. */
const PresenceStrip: React.FC<{ participants: CollabParticipant[] }> = ({ participants }) => {
  if (participants.length === 0) return null;
  return (
    <div className='flex items-center -space-x-6px mr-4px'>
      {participants.slice(0, 5).map((p) => (
        <span
          key={p.id}
          title={p.name}
          className='size-24px rd-full flex-center text-11px font-600 text-white border-2 border-solid border-bg-2'
          style={{ backgroundColor: p.color }}
        >
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {participants.length > 5 ? (
        <span className='text-11px text-t-tertiary pl-8px'>+{participants.length - 5}</span>
      ) : null}
    </div>
  );
};

export default StudioEditorView;
