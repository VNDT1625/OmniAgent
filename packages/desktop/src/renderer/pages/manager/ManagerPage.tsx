/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ManagerPage` — top-level view for the Personal Manager app (`/manager`).
 *
 * The 2026 layout (Notion / Obsidian style): the workspace is dominated by a
 * single full-width content column, while navigation and tools live in a
 * right-edge auto-hide panel ({@link RightAutoHidePanel}). The panel reveals
 * itself when the cursor enters a 14px hot zone next to the right edge or the
 * panel itself; clicking the pin keeps it open. Reading the current note,
 * task list, or schedule never has to share screen real estate with chrome.
 *
 * Sections are flat — no nested tabs:
 * tasks · daily · learn · data · schedule. The legacy "Notes" group is
 * preserved as a panel section header above its three sub-sections.
 *
 * Visual layer (paper canvas, hairline borders, accent-aware buttons) is
 * driven by `manager.module.css` + the user's `appearance` settings, so accent /
 * font / density / size are all live-themeable. Ctrl/Cmd+K opens the workspace
 * command palette.
 *
 * Renderer-only: Arco + UnoCSS semantic tokens + i18n. No Node.js APIs.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Spin, Tooltip } from '@arco-design/web-react';
import { Book, Calendar, FolderClose, Schedule, Search, Theme } from '@icon-park/react';
import { defaultManagerAppearance } from '@process/manager/managerTypes';
import { useManagerStore } from './useManagerStore';
import TasksView from './tasks/TasksView';
import DailyView from './notes/DailyView';
import LearnView from './notes/LearnView';
import DataView from './notes/DataView';
import ScheduleView from './schedule/ScheduleView';
import { appearanceStyle } from './components/appearance';
import AppearanceModal from './components/AppearanceModal';
import CommandPalette, { type ManagerTab } from './components/CommandPalette';
import RightAutoHidePanel, { type PanelNavItem } from './components/RightAutoHidePanel';
import styles from './manager.module.css';

/** Flat section identifier — what the main column shows right now. */
type Section = 'tasks' | 'daily' | 'learn' | 'data' | 'schedule';

/** A friendly "service not ready" panel shown when the bridge is unavailable. */
const BridgeNotice: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col items-center justify-center gap-12px h-full text-center px-24px'>
      <Schedule theme='outline' size='40' className='text-t-tertiary' />
      <div className='text-14px text-t-secondary max-w-420px leading-relaxed'>{t('manager.bridgeUnavailable')}</div>
      <Button type='primary' onClick={onRetry}>
        {t('manager.retry')}
      </Button>
    </div>
  );
};

const ManagerPage: React.FC = () => {
  const { t } = useTranslation();
  const store = useManagerStore();
  const [section, setSection] = useState<Section>('tasks');
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);

  const appearance = store.data.settings.appearance ?? defaultManagerAppearance();

  // Ctrl/Cmd+K opens the command palette anywhere in the workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Resolve a {@link CommandPalette} navigation request (which speaks the
   * legacy `tasks|notes|schedule` API) into our flat sections. For notes, look
   * the entry up in the store so we can land on the right sub-section.
   */
  const navigate = (tab: ManagerTab, id?: string) => {
    if (tab === 'tasks') setSection('tasks');
    else if (tab === 'schedule') setSection('schedule');
    else {
      // tab === 'notes' — pick the sub-section based on the note's category.
      const note = id ? store.data.notes.find((n) => n.id === id) : undefined;
      const cat = note?.category ?? 'daily';
      setSection(cat === 'learn' ? 'learn' : cat === 'data' ? 'data' : 'daily');
      if (id) setFocusNoteId(id);
    }
  };

  /** Localised label for the current section — used in the breadcrumb. */
  const sectionLabel = useMemo(() => {
    if (section === 'tasks') return t('manager.tabs.tasks');
    if (section === 'schedule') return t('manager.tabs.schedule');
    return t(`manager.notes.cat.${section}`);
  }, [section, t]);

  /** Workspace nav (top of panel) — the four main destinations. */
  const primaryNav: PanelNavItem[] = [
    {
      key: 'tasks',
      label: t('manager.tabs.tasks'),
      icon: <Calendar theme='outline' size='15' />,
      active: section === 'tasks',
      onClick: () => setSection('tasks'),
    },
    {
      key: 'schedule',
      label: t('manager.tabs.schedule'),
      icon: <Schedule theme='outline' size='15' />,
      active: section === 'schedule',
      onClick: () => setSection('schedule'),
    },
  ];

  /** Notes group rendered as a section in the panel. */
  const notesSection = {
    key: 'notes',
    label: t('manager.tabs.notes'),
    items: [
      {
        key: 'daily',
        label: t('manager.notes.cat.daily'),
        icon: <Calendar theme='outline' size='14' />,
        child: true,
        active: section === 'daily',
        onClick: () => setSection('daily'),
      },
      {
        key: 'learn',
        label: t('manager.notes.cat.learn'),
        icon: <Book theme='outline' size='14' />,
        child: true,
        active: section === 'learn',
        onClick: () => setSection('learn'),
      },
      {
        key: 'data',
        label: t('manager.notes.cat.data'),
        icon: <FolderClose theme='outline' size='14' />,
        child: true,
        active: section === 'data',
        onClick: () => setSection('data'),
      },
    ] satisfies PanelNavItem[],
  };

  /** Quick-action tools rendered above the nav inside the panel. */
  const tools = (
    <>
      <Tooltip content={t('manager.palette.tooltip')} mini>
        <Button
          type='text'
          size='small'
          className={styles.toolBtn}
          icon={<Search theme='outline' size='15' />}
          onClick={() => setPaletteOpen(true)}
          long
        >
          <span className='flex-1 text-left'>{t('manager.palette.button')}</span>
          <span className='text-11px text-t-tertiary'>⌘K</span>
        </Button>
      </Tooltip>
      <Tooltip content={t('manager.appearance.title')} mini>
        <Button
          type='text'
          size='small'
          className={styles.toolBtn}
          icon={<Theme theme='outline' size='15' />}
          onClick={() => setAppearanceOpen(true)}
          aria-label={t('manager.appearance.title')}
        />
      </Tooltip>
    </>
  );

  // Reset focusNoteId once the target sub-section consumes it, so subsequent
  // re-navigations to the same note still reveal it.
  const onLearnFocusConsumed = () => setFocusNoteId(null);

  return (
    <div className={`flex flex-col h-full w-full ${styles.root}`} style={appearanceStyle(appearance)}>
      {/* The workspace area — main content + edge-docked panel. */}
      <div className={styles.workspace}>
        <div className={styles.workspaceMain}>
          {store.status === 'loading' && (
            <div className='flex-1 flex items-center justify-center'>
              <Spin tip={t('manager.loading')} />
            </div>
          )}
          {store.status === 'unavailable' && (
            <div className='flex-1 min-h-0'>
              <BridgeNotice onRetry={store.reload} />
            </div>
          )}
          {store.status === 'ready' && (
            <>
              {/* Breadcrumb — quiet and out of the way. */}
              <div className={styles.crumbBar}>
                <span>{t('manager.title')}</span>
                <span className={styles.crumbSep}>/</span>
                <span className={styles.crumbActive}>{sectionLabel}</span>
              </div>
              <div className={styles.sectionBody}>
                {section === 'tasks' && <TasksView store={store} />}
                {section === 'daily' && <DailyView store={store} />}
                {section === 'learn' && (
                  <LearnView store={store} focusId={focusNoteId} onFocusConsumed={onLearnFocusConsumed} />
                )}
                {section === 'data' && <DataView store={store} />}
                {section === 'schedule' && <ScheduleView store={store} />}
              </div>
            </>
          )}
        </div>

        {/* Edge-docked nav — only meaningful when the workspace is ready. */}
        {store.status === 'ready' && (
          <RightAutoHidePanel primary={primaryNav} sections={[notesSection]} tools={tools} title={t('manager.title')} />
        )}
      </div>

      {appearanceOpen && <AppearanceModal store={store} onClose={() => setAppearanceOpen(false)} />}
      <CommandPalette
        visible={paletteOpen}
        tasks={store.data.tasks}
        notes={store.data.notes}
        events={store.data.events}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
      />
    </div>
  );
};

export default ManagerPage;
