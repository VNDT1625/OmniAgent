/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multi-platform Testing page (Yêu cầu 2b, criteria 2.3 / 2.5 / 2.6). Lists test
 * sessions, lets the user pick one, and renders its report IDE-style via
 * {@link ReportViewer}. Session control (run/show-hide, viewport) is driven by
 * the agent through the Testing MCP today; this page surfaces results.
 *
 * Desktop-only (the testing services are Main-process native), degrading to a
 * notice in WebUI mode — mirrors the Company/Browser/Resource pages.
 */

import { isElectronDesktop } from '@/renderer/utils/platform';
import { Button, Empty } from '@arco-design/web-react';
import { ExperimentOne, Refresh } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import NewSessionPanel from './components/NewSessionPanel';
import ReportViewer from './components/ReportViewer';
import { useTestingState } from './useTestingState';

/** Status dot colour per session status. */
const STATUS_COLOR: Record<string, string> = {
  passed: 'text-success',
  failed: 'text-danger',
  error: 'text-warning',
  running: 'text-primary',
  queued: 'text-t-tertiary',
};

/**
 * The Testing page: a session list on the left, the selected report on the right.
 */
const TestingPage: React.FC = () => {
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();
  const {
    sessions,
    sessionsStatus,
    selectedId,
    report,
    running,
    select,
    refresh,
    run,
    generate,
    detectApp,
    detectProgress,
    generateProgress,
  } = useTestingState();

  if (!isDesktop) {
    return (
      <div className='flex flex-col items-center gap-12px py-56px text-center'>
        <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
          <ExperimentOne theme='outline' size='24' />
        </span>
        <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('testing.desktopOnly')}</p>
      </div>
    );
  }

  return (
    <div className='flex flex-col h-full w-full'>
      <header className='mb-16px flex items-center justify-between'>
        <div>
          <h2 className='m-0 text-20px font-700 text-t-primary'>{t('testing.title')}</h2>
          <p className='m-0 mt-4px text-13px text-t-secondary'>{t('testing.subtitle')}</p>
        </div>
        <Button size='small' icon={<Refresh theme='outline' size='14' />} onClick={refresh}>
          {t('testing.refresh')}
        </Button>
      </header>

      <div className='flex-1 min-h-0 flex gap-16px'>
        <div className='w-360px shrink-0 flex flex-col gap-12px min-h-0'>
          <div className='shrink-0 max-h-[60%] overflow-auto pr-4px border border-border-base rd-8px p-14px'>
            <NewSessionPanel
              onRun={run}
              onGenerate={generate}
              onDetectApp={detectApp}
              running={running}
              detectProgress={detectProgress}
              generateProgress={generateProgress}
            />
          </div>
          <div className='flex-1 min-h-0 flex flex-col gap-6px'>
            <span className='shrink-0 px-2px text-11px font-600 uppercase tracking-wide text-t-tertiary'>
              {t('testing.sessionsLabel')}
            </span>
            <div className='flex-1 min-h-0 overflow-auto'>
              {sessionsStatus === 'unavailable' ? (
                <div className='px-4px py-8px text-12px text-t-tertiary'>{t('testing.unavailable')}</div>
              ) : sessions.length === 0 ? (
                <Empty className='mt-24px' description={t('testing.noSessions')} />
              ) : (
                <div className='flex flex-col gap-2px'>
                  {sessions.map((s) => (
                    <button
                      key={s.sessionId}
                      type='button'
                      className={`text-left px-10px py-8px rd-6px transition-colors ${s.sessionId === selectedId ? 'bg-fill-2' : 'hover:bg-fill-1'}`}
                      onClick={() => select(s.sessionId)}
                      data-testid='session-item'
                    >
                      <div className='flex items-center justify-between gap-8px'>
                        <span className='text-13px text-t-primary truncate'>{s.name}</span>
                        <span className={`shrink-0 text-11px font-500 ${STATUS_COLOR[s.status] ?? 'text-t-tertiary'}`}>
                          {s.status}
                        </span>
                      </div>
                      <span className='text-11px text-t-tertiary'>{s.platform}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className='flex-1 min-h-0 border border-border-base rd-8px p-12px'>
          <ReportViewer report={report} />
        </div>
      </div>
    </div>
  );
};

export default TestingPage;
