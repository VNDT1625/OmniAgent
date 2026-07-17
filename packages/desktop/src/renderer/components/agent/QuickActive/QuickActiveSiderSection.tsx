/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Quick Active — a collapsible left-sidebar section that sits alongside
 * Conversations / Team / Company and lists the surfaces running right now:
 * open browser tabs (e.g. Youtube.com) and active test sessions. Clicking a row
 * jumps straight to that page and focuses the chosen tab / session.
 *
 * Mirrors {@link TeamSiderSection} / {@link CompanySiderSection} in shape
 * (collapsed vs expanded modes, `localStorage`-backed expand state,
 * navigate-on-click) and reuses {@link useActiveSurfaces} for the read-only data
 * aggregation (which degrades gracefully when a bridge is not wired yet).
 *
 * Desktop-only: the surfaces it lists (embedded browser + testing) are gated to
 * the Electron app, so the section renders nothing on WebUI / mobile web.
 *
 * Process boundary: Renderer component. No Node.js APIs.
 */

import { requestActiveTab } from '@/renderer/pages/browser/constants';
import { requestActiveSession } from '@/renderer/pages/testing/constants';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { cleanupSiderTooltips } from '@renderer/utils/ui/siderTooltip';
import { blurActiveElement } from '@renderer/utils/ui/focus';
import { Tooltip } from '@arco-design/web-react';
import { Compass, ExperimentOne, Lightning, Right } from '@icon-park/react';
import classNames from 'classnames';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useActiveSurfaces, type ActiveBrowserTab, type ActiveTestSession } from './useActiveSurfaces';

type SiderTooltipProps = React.ComponentProps<typeof Tooltip>;

interface QuickActiveSiderSectionProps {
  collapsed: boolean;
  pathname: string;
  siderTooltipProps: Partial<SiderTooltipProps>;
  onSessionClick?: () => void;
}

const SECTION_EXPANDED_KEY = 'quick-active-section-expanded';

/** Status dot colour per test-session status. */
const STATUS_COLOR: Record<string, string> = {
  passed: 'text-success',
  failed: 'text-danger',
  error: 'text-warning',
  running: 'text-primary',
  queued: 'text-t-tertiary',
};

/** Derive a short, human label for a browser tab (title → host → fallback). */
const tabLabel = (tab: ActiveBrowserTab, fallback: string): string => {
  if (tab.title && tab.title.trim().length > 0) return tab.title.trim();
  if (tab.url && tab.url.trim().length > 0) {
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  }
  return fallback;
};

/** A single clickable row, indented and styled like the company sider tree. */
const TreeRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  depth: number;
  chevron?: 'none' | 'collapsed' | 'expanded';
  guide?: boolean;
  active?: boolean;
  suffix?: React.ReactNode;
  onClick: () => void;
}> = ({ icon, label, depth, chevron = 'none', guide = false, active = false, suffix, onClick }) => (
  <div className='relative' style={{ paddingLeft: depth * 14 }}>
    {guide && (
      <span aria-hidden className='absolute top-0 bottom-0 w-1px bg-border-2' style={{ left: depth * 14 - 7 }} />
    )}
    <div
      role='button'
      tabIndex={0}
      className={classNames(
        'h-32px rd-8px flex items-center gap-8px pl-10px pr-8px cursor-pointer relative overflow-hidden shrink-0 group min-w-0 transition-colors',
        active ? '!bg-active' : 'hover:bg-fill-3'
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {chevron !== 'none' && (
        <Right
          theme='outline'
          size={12}
          className={classNames('shrink-0 text-t-tertiary transition-transform duration-150', {
            'rotate-90': chevron === 'expanded',
          })}
        />
      )}
      <span className='size-18px flex items-center justify-center shrink-0 line-height-0 text-t-secondary'>{icon}</span>
      <span className='flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-13px font-[500] text-t-primary'>
        {label}
      </span>
      {suffix}
    </div>
  </div>
);

const QuickActiveSiderSection: React.FC<QuickActiveSiderSectionProps> = ({
  collapsed,
  pathname,
  siderTooltipProps,
  onSessionClick,
}) => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  const navigateWithFeedback = layout?.navigateWithFeedback;
  const navigate = useNavigate();
  const isDesktop = isElectronDesktop();

  const [sectionExpanded, setSectionExpanded] = useState<boolean>(
    () => localStorage.getItem(SECTION_EXPANDED_KEY) !== 'false'
  );
  useEffect(() => {
    localStorage.setItem(SECTION_EXPANDED_KEY, String(sectionExpanded));
  }, [sectionExpanded]);

  const { browserTabs, testSessions, total } = useActiveSurfaces(isDesktop);

  const goBrowserTab = useCallback(
    (id?: string) => {
      cleanupSiderTooltips();
      blurActiveElement();
      if (id) requestActiveTab(id);
      if (navigateWithFeedback) navigateWithFeedback('/settings/browser');
      else Promise.resolve(navigate('/settings/browser')).catch(console.error);
      if (onSessionClick) onSessionClick();
    },
    [navigate, navigateWithFeedback, onSessionClick]
  );

  const goTesting = useCallback(
    (id?: string) => {
      cleanupSiderTooltips();
      blurActiveElement();
      if (id) requestActiveSession(id);
      if (navigateWithFeedback) navigateWithFeedback('/settings/testing');
      else Promise.resolve(navigate('/settings/testing')).catch(console.error);
      if (onSessionClick) onSessionClick();
    },
    [navigate, navigateWithFeedback, onSessionClick]
  );

  const onBrowserPage = pathname.startsWith('/settings/browser');
  const onTestingPage = pathname.startsWith('/settings/testing');

  const hasBrowser = browserTabs.length > 0;
  const hasTesting = testSessions.length > 0;

  // Build a flat icon list for the collapsed rail (browser tabs first).
  const collapsedItems = useMemo(
    () => [
      ...browserTabs.map((tab) => ({
        key: `tab-${tab.id}`,
        label: tabLabel(tab, t('quickActive.browser.untitled')),
        icon: <Compass theme='outline' size='16' fill='currentColor' />,
        onClick: () => goBrowserTab(tab.id),
      })),
      ...testSessions.map((session) => ({
        key: `test-${session.id}`,
        label: session.name,
        icon: <ExperimentOne theme='outline' size='16' fill='currentColor' />,
        onClick: () => goTesting(session.id),
      })),
    ],
    [browserTabs, testSessions, goBrowserTab, goTesting, t]
  );

  // Nothing active and not on desktop → hide entirely (no empty noise).
  if (!isDesktop || total === 0) return null;

  if (collapsed) {
    return (
      <div className='shrink-0 flex flex-col gap-2px'>
        {collapsedItems.map((item) => (
          <Tooltip key={item.key} {...siderTooltipProps} content={item.label} position='right'>
            <div
              className='relative w-full h-40px flex items-center justify-center cursor-pointer transition-colors rd-8px hover:bg-fill-3 active:bg-fill-4 text-t-secondary'
              onClick={item.onClick}
            >
              {item.icon}
            </div>
          </Tooltip>
        ))}
      </div>
    );
  }

  return (
    <div className='shrink-0 flex flex-col gap-2px'>
      <div
        className='group/label sider-section-label flex items-center px-12px h-28px select-none sticky top-0 z-10 mt-8px cursor-pointer'
        onClick={() => setSectionExpanded((v) => !v)}
      >
        <span className='flex items-center gap-6px'>
          <span className='inline-flex items-center justify-center text-t-tertiary group-hover/label:text-t-primary transition-colors line-height-0'>
            <Lightning theme='filled' size={13} fill='currentColor' />
          </span>
          <span className='text-14px text-t-tertiary sider-section-title group-hover/label:text-t-primary transition-colors font-[500] leading-none'>
            {t('quickActive.title')}
          </span>
        </span>
        <span className='ml-auto flex items-center gap-4px shrink-0'>
          <span className='text-12px text-t-tertiary leading-none'>{total}</span>
          <span className='flex items-center justify-center opacity-0 group-hover/label:opacity-100 transition-opacity text-t-tertiary'>
            <Right
              theme='outline'
              size={12}
              className={classNames('transition-transform duration-150', { 'rotate-90': sectionExpanded })}
            />
          </span>
        </span>
      </div>

      {sectionExpanded && (
        <>
          {hasBrowser && (
            <>
              <TreeRow
                icon={<Compass theme='outline' size='16' fill='currentColor' />}
                label={t('quickActive.group.browser')}
                depth={0}
                active={onBrowserPage}
                onClick={() => goBrowserTab()}
              />
              {browserTabs.map((tab) => (
                <TreeRow
                  key={tab.id}
                  icon={<Compass theme='outline' size='14' fill='currentColor' />}
                  label={tabLabel(tab, t('quickActive.browser.untitled'))}
                  depth={1}
                  guide
                  onClick={() => goBrowserTab(tab.id)}
                />
              ))}
            </>
          )}

          {hasTesting && (
            <>
              <TreeRow
                icon={<ExperimentOne theme='outline' size='16' fill='currentColor' />}
                label={t('quickActive.group.testing')}
                depth={0}
                active={onTestingPage}
                onClick={() => goTesting()}
              />
              {testSessions.map((session) => (
                <TestSessionRow key={session.id} session={session} onClick={() => goTesting(session.id)} />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
};

/** A test-session leaf row with a status-coloured dot suffix. */
const TestSessionRow: React.FC<{ session: ActiveTestSession; onClick: () => void }> = ({ session, onClick }) => (
  <TreeRow
    icon={<ExperimentOne theme='outline' size='14' fill='currentColor' />}
    label={session.name}
    depth={1}
    guide
    suffix={
      <span
        className={classNames(
          'shrink-0 text-10px font-[500] leading-none',
          STATUS_COLOR[session.status] ?? 'text-t-tertiary'
        )}
      >
        {session.status}
      </span>
    }
    onClick={onClick}
  />
);

export default QuickActiveSiderSection;
