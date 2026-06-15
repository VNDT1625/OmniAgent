/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `StudioDashboard` — the WPS-like landing of the Studio app. A left rail with
 * primary actions (Open file, Make Video) + section switch (Recent /
 * Starred), and a main column listing files. Picking a file calls `onOpenFile`,
 * which the parent uses to mount the Universal Editor. Presentational + state
 * via {@link useStudioFiles}. Renderer-only; all text via i18n.
 */

import { Button, Empty, Input } from '@arco-design/web-react';
import {
  FolderOpen,
  Search,
  Time,
  Star,
  FileAddition,
  Code,
  People,
  Lightning,
  VideoTwo,
  MusicOne,
} from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isStarred } from '../studioStorage';
import { formatRelativeTime } from '../relativeTime';
import { useStudioFiles } from '../hooks/useStudioFiles';
import StudioFileRow from './StudioFileRow';
import CollabModal from './CollabModal';
import CreateFileModal from './CreateFileModal';
import type { CollabJoinData } from '@renderer/pages/editor/adapters/collabClient';
import { MUSIC_STUDIO_ENABLED } from '@/common/config/constants';

type StudioSection = 'recent' | 'starred';

type StudioDashboardProps = {
  /** Called with an absolute path when the user opens a file. */
  onOpenFile: (filePath: string) => void;
  /** Called when the user clicks the "IDE" entry. */
  onOpenIde: () => void;
  /** Called when the user joins a shared session as a peer. */
  onJoinSession: (join: CollabJoinData, joinCode: string) => void;
  /** Called when the user opens the Automation (workflow) app. */
  onAutomation: () => void;
  /** Called when the user opens the Make Video (AI movie/anime) app. */
  onMakeVideo: () => void;
  /** Called when the user opens the Music Studio app. */
  onMusic: () => void;
};

const StudioDashboard: React.FC<StudioDashboardProps> = ({
  onOpenFile,
  onOpenIde,
  onJoinSession,
  onAutomation,
  onMakeVideo,
  onMusic,
}) => {
  const { t, i18n } = useTranslation();
  const { recent, starred, pickFile, markOpened, forget, star } = useStudioFiles();
  const [section, setSection] = useState<StudioSection>('recent');
  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  const handleOpenDialog = async (): Promise<void> => {
    const picked = await pickFile();
    if (!picked) return;
    markOpened(picked);
    onOpenFile(picked);
  };

  const handleOpenExisting = (filePath: string): void => {
    markOpened(filePath);
    onOpenFile(filePath);
  };

  /** A new file (empty or AI-generated) has been written: track + open it. */
  const handleCreated = (filePath: string): void => {
    setCreateOpen(false);
    markOpened(filePath);
    onOpenFile(filePath);
  };

  const list = section === 'recent' ? recent : starred;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((entry) => entry.name.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q));
  }, [list, query]);

  return (
    <div className='size-full flex min-h-0 bg-1'>
      {/* Left rail */}
      <aside className='w-220px shrink-0 flex flex-col gap-6px p-16px border-r border-b-1'>
        <Button
          type='primary'
          long
          size='large'
          icon={<FolderOpen theme='outline' size={16} />}
          className='!rd-10px !h-44px !font-[500]'
          onClick={() => void handleOpenDialog()}
        >
          {t('studio.open')}
        </Button>
        <Button
          long
          size='large'
          icon={<FileAddition theme='outline' size={16} />}
          className='!rd-10px !h-44px !font-[500] mt-4px'
          onClick={() => setCreateOpen(true)}
        >
          {t('studio.create.action')}
        </Button>
        <button
          type='button'
          onClick={onMakeVideo}
          className='group mt-4px h-44px w-full rd-10px flex items-center gap-10px px-14px cursor-pointer border-none bg-primary-light-1 hover:bg-primary-light-2 transition-colors'
        >
          <VideoTwo theme='outline' size={18} fill='currentColor' className='text-primary' />
          <span className='text-14px font-[500] text-primary'>{t('studio.makeVideo')}</span>
        </button>
        <button
          type='button'
          onClick={onAutomation}
          className='group h-44px w-full rd-10px flex items-center gap-10px px-14px cursor-pointer border-none bg-fill-2 hover:bg-fill-3 transition-colors'
        >
          <Lightning theme='outline' size={18} fill='currentColor' className='text-warning' />
          <span className='text-14px font-[500] text-t-primary'>{t('studio.automation')}</span>
        </button>
        <button
          type='button'
          onClick={onOpenIde}
          className='group h-44px w-full rd-10px flex items-center gap-10px px-14px cursor-pointer border-none bg-fill-2 hover:bg-fill-3 transition-colors'
        >
          <Code theme='outline' size={18} fill='currentColor' className='text-t-secondary' />
          <span className='text-14px font-[500] text-t-primary'>{t('studio.ide')}</span>
        </button>
        {MUSIC_STUDIO_ENABLED ? (
          <Button
            long
            size='large'
            icon={<MusicOne theme='outline' size={16} />}
            className='!rd-10px !h-44px !font-[500] !justify-start'
            onClick={onMusic}
          >
            {t('music.title')}
          </Button>
        ) : null}
        <button
          type='button'
          onClick={() => setJoinOpen(true)}
          className='group h-44px w-full rd-10px flex items-center gap-10px px-14px cursor-pointer border-none bg-fill-2 hover:bg-fill-3 transition-colors'
        >
          <People theme='outline' size={18} fill='currentColor' className='text-t-secondary' />
          <span className='text-14px font-[500] text-t-primary'>{t('studio.collab.joinTab')}</span>
        </button>
        <div className='h-1px bg-2 my-10px' />
        <RailItem
          active={section === 'recent'}
          icon={<Time theme='outline' size={16} fill='currentColor' />}
          label={t('studio.section.recent')}
          onClick={() => setSection('recent')}
        />
        <RailItem
          active={section === 'starred'}
          icon={<Star theme='outline' size={16} fill='currentColor' />}
          label={t('studio.section.starred')}
          onClick={() => setSection('starred')}
        />
      </aside>

      {/* Main column */}
      <main className='flex-1 min-w-0 flex flex-col min-h-0'>
        <header className='shrink-0 flex items-center gap-16px px-24px pt-20px pb-12px'>
          <h1 className='text-20px font-semibold text-t-primary m-0'>{t('studio.title')}</h1>
          <div className='flex-1' />
          <Input
            allowClear
            prefix={<Search theme='outline' size={15} />}
            placeholder={t('studio.searchPlaceholder')}
            value={query}
            onChange={setQuery}
            className='!w-280px !rd-10px'
          />
        </header>
        <div className='px-24px pb-8px shrink-0'>
          <span className='text-13px text-t-tertiary font-[500]'>
            {section === 'recent' ? t('studio.section.recent') : t('studio.section.starred')}
          </span>
        </div>
        <div className='flex-1 min-h-0 overflow-y-auto px-16px pb-20px'>
          {filtered.length === 0 ? (
            <div className='h-full flex-center'>
              <Empty
                description={
                  query
                    ? t('studio.empty.noMatch')
                    : section === 'recent'
                      ? t('studio.empty.noRecent')
                      : t('studio.empty.noStarred')
                }
              />
            </div>
          ) : (
            <div className='flex flex-col gap-2px'>
              {filtered.map((entry) => (
                <StudioFileRow
                  key={entry.path}
                  entry={entry}
                  starred={isStarred(entry.path)}
                  relativeTime={formatRelativeTime(entry.openedAt, i18n.language)}
                  onOpen={handleOpenExisting}
                  onStar={star}
                  onRemove={section === 'recent' ? forget : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <CreateFileModal visible={createOpen} onCancel={() => setCreateOpen(false)} onCreated={handleCreated} />

      <CollabModal
        visible={joinOpen}
        filePath=''
        defaultTab='join'
        onClose={() => setJoinOpen(false)}
        onPublished={() => undefined}
        onJoined={(join, code) => {
          setJoinOpen(false);
          onJoinSession(join, code);
        }}
      />
    </div>
  );
};

/** A single left-rail section toggle. */
const RailItem: React.FC<{ active: boolean; icon: React.ReactNode; label: string; onClick: () => void }> = ({
  active,
  icon,
  label,
  onClick,
}) => (
  <button
    type='button'
    onClick={onClick}
    className={`h-38px w-full rd-8px flex items-center gap-10px px-12px cursor-pointer border-none transition-colors ${active ? 'bg-fill-2 text-t-primary' : 'bg-transparent text-t-secondary hover:bg-fill-1'}`}
  >
    <span className='flex-center shrink-0'>{icon}</span>
    <span className='text-14px font-[500]'>{label}</span>
  </button>
);

export default StudioDashboard;
