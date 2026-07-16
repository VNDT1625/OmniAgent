/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isElectronDesktop } from '@/renderer/utils/platform';
import { Message, Tabs } from '@arco-design/web-react';
import { Terminal } from '@icon-park/react';
import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TerminalSchedule } from '@process/terminal/terminalTypes';
import BridgeNotice from './components/BridgeNotice';
import ScheduleEditor from './components/ScheduleEditor';
import SchedulePanel from './components/SchedulePanel';
import SessionList from './components/SessionList';
import SystemProcessPanel from './components/SystemProcessPanel';
import TerminalView from './components/TerminalView';
import { draftFromSchedule, type ScheduleDraft } from './constants';
import { useTerminalState } from './useTerminalState';
import { useTerminalIntelligence } from './useTerminalIntelligence';

/**
 * Terminal manager surface (Settings › Terminal).
 *
 * Three tabs:
 *  - **Sessions**: app-managed interactive shells — create, type commands, see
 *    output, kill, remove. The live running-count is shown on the tab + rail.
 *  - **System**: read-only count + list of shell/terminal processes running
 *    anywhere on the machine (not interactive — only discovered via the OS).
 *  - **Schedules**: saved scripts that launch tools (e.g. 9router) on a cron
 *    expression, fired into fresh sessions while the app runs.
 *
 * The page depends on the native IPC terminal bridge (child_process shells), so
 * it is gated to the desktop app — in WebUI mode it shows a short notice.
 */
const TerminalPage: React.FC = () => {
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();
  const state = useTerminalState();

  const intelligence = useTerminalIntelligence();

  const [editorVisible, setEditorVisible] = useState(false);
  const [editorDraft, setEditorDraft] = useState<ScheduleDraft | null>(null);

  const activeSession = useMemo(
    () => state.sessions.find((s) => s.id === state.activeId) ?? null,
    [state.sessions, state.activeId]
  );

  const handleCreate = useCallback(() => {
    void state.createSession().then((session) => {
      if (!session) Message.error(t('terminal.sessions.createError'));
    });
  }, [state, t]);

  const openNewSchedule = useCallback(() => {
    setEditorDraft(null);
    setEditorVisible(true);
  }, []);

  const openEditSchedule = useCallback((schedule: TerminalSchedule) => {
    setEditorDraft(draftFromSchedule(schedule));
    setEditorVisible(true);
  }, []);

  const handleSaveSchedule = useCallback(
    async (draft: ScheduleDraft): Promise<void> => {
      const ok = await state.saveSchedule({
        schedule: {
          id: draft.id,
          name: draft.name.trim(),
          shell: draft.shell.trim() || undefined,
          cwd: draft.cwd.trim() || undefined,
          script: draft.script,
          kind: draft.kind,
          cron: draft.kind === 'cron' ? draft.cron.trim() : undefined,
          enabled: draft.enabled,
        },
      });
      if (ok) {
        Message.success(t('terminal.schedule.saved'));
        setEditorVisible(false);
      } else {
        Message.error(t('terminal.schedule.saveError'));
      }
    },
    [state, t]
  );

  const handleRunNow = useCallback(
    (id: string) => {
      void state.runScheduleNow(id).then(() => Message.success(t('terminal.schedule.ranNow')));
    },
    [state, t]
  );

  if (!isDesktop) {
    return (
      <div className='flex flex-col h-full w-full'>
        <PageHeader />
        <div className='flex flex-col items-center gap-12px py-56px text-center'>
          <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
            <Terminal theme='outline' size='24' />
          </span>
          <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('terminal.desktopOnly')}</p>
        </div>
      </div>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <div className='flex flex-col h-full w-full'>
        <PageHeader />
        <BridgeNotice onRetry={state.retry} />
      </div>
    );
  }

  return (
    <div className='flex flex-col h-full w-full min-h-0'>
      <PageHeader runningCount={state.runningCount} />
      <Tabs defaultActiveTab='sessions' className='terminal-tabs flex-1 min-h-0' lazyload={false}>
        <Tabs.TabPane key='sessions' title={t('terminal.tabs.sessions')}>
          <div className='flex gap-12px h-full min-h-0 pt-4px'>
            <SessionList
              sessions={state.sessions}
              runningCount={state.runningCount}
              activeId={state.activeId}
              onSelect={state.setActiveId}
              onCreate={handleCreate}
              onKill={state.killSession}
              onRemove={state.removeSession}
            />
            <TerminalView
              session={activeSession}
              buffer={activeSession ? (state.buffers[activeSession.id] ?? '') : ''}
              onInput={(data) => activeSession && state.writeSession(activeSession.id, data)}
              onResize={(cols, rows) => activeSession && state.resizeSession(activeSession.id, cols, rows)}
              visible
              ghostFor={intelligence.ghostFor}
              onCommandFinished={intelligence.onCommandFinished}
              pendingRemap={intelligence.pendingRemap}
              onDismissRemap={intelligence.dismissRemap}
            />
          </div>
        </Tabs.TabPane>

        <Tabs.TabPane key='system' title={t('terminal.tabs.system')}>
          <div className='pt-8px'>
            <SystemProcessPanel processes={state.systemProcesses} onRefresh={state.refreshSystem} />
          </div>
        </Tabs.TabPane>

        <Tabs.TabPane key='schedules' title={t('terminal.tabs.schedules')}>
          <div className='pt-8px'>
            <SchedulePanel
              schedules={state.schedules}
              onNew={openNewSchedule}
              onEdit={openEditSchedule}
              onRunNow={handleRunNow}
              onRemove={(id) => void state.removeSchedule(id)}
            />
          </div>
        </Tabs.TabPane>
      </Tabs>

      <ScheduleEditor
        visible={editorVisible}
        initial={editorDraft}
        onCancel={() => setEditorVisible(false)}
        onSave={handleSaveSchedule}
      />
    </div>
  );
};

/** Compact page heading (title + one-line subtitle + running count). */
const PageHeader: React.FC<{ runningCount?: number }> = ({ runningCount }) => {
  const { t } = useTranslation();
  return (
    <header className='mb-12px'>
      <div className='flex items-center gap-10px'>
        <h2 className='m-0 text-20px font-700 text-t-primary'>{t('terminal.title')}</h2>
        {typeof runningCount === 'number' && (
          <span className='flex items-center gap-6px px-8px h-22px rd-full bg-success-light-1 text-success text-12px font-600'>
            <span className='size-6px rd-full bg-success' aria-hidden />
            {t('terminal.runningCount', { count: runningCount })}
          </span>
        )}
      </div>
      <p className='m-0 mt-2px text-13px text-t-secondary'>{t('terminal.subtitle')}</p>
    </header>
  );
};

export default TerminalPage;
