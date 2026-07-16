/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RightAutoHidePanel` — a Notion/Obsidian-style edge-docked navigation panel.
 *
 * Behaviour (matches the user spec): the panel sits collapsed against the
 * right edge of the workspace. Moving the cursor into a 14px hot zone, or
 * onto the panel itself, slides it in over the content (`position: absolute`,
 * `transform: translateX(...)`) — it does NOT push the document. Clicking the
 * pin button locks it open across reloads. A tiny hint bar makes the trigger
 * discoverable without adding chrome.
 *
 * Stack-correct: Arco buttons + `@icon-park/react` + UnoCSS semantic tokens +
 * i18n. No raw interactive HTML, no hardcoded colours. Renderer-only.
 *
 * The panel is presentational: parents own the section state and pass `items`
 * (plus a `tools` slot rendered above the nav list). Persistence of the pinned
 * state is the panel's own concern, keyed under `aionui.manager.panelPinned`.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@arco-design/web-react';
import { Pushpin, Schedule } from '@icon-park/react';
import styles from '../manager.module.css';

const PIN_STORAGE_KEY = 'aionui.manager.panelPinned';

/** A single navigation row; child rows are visually indented by the panel. */
export type PanelNavItem = {
  key: string;
  label: string;
  icon: React.ReactNode;
  /** Indented child row (for the Notes group: Daily / Learn / Data). */
  child?: boolean;
  /** Currently selected. */
  active?: boolean;
  /** Optional badge text shown right-aligned (e.g. unread count). */
  badge?: string | number;
  onClick: () => void;
};

/** A non-clickable section header above a group of items. */
export type PanelNavSection = {
  key: string;
  /** Section title; rendered as a quiet uppercase eyebrow. */
  label: string;
  /** Items belonging to this section. */
  items: PanelNavItem[];
};

type Props = {
  /** Top-level "Workspace" items rendered before the first section. */
  primary: PanelNavItem[];
  /** Grouped sections (e.g. "Notes" with Daily / Learn / Data). */
  sections?: PanelNavSection[];
  /**
   * Optional tools strip rendered just below the panel header, above the nav.
   * Use it for quick actions (search, appearance, settings).
   */
  tools?: React.ReactNode;
  /** Workspace title shown in the panel header (defaults to `manager.title`). */
  title?: string;
};

const RightAutoHidePanel: React.FC<Props> = ({ primary, sections = [], tools, title }) => {
  const { t } = useTranslation();
  const [pinned, setPinned] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(PIN_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  // Persist the pin state so the workspace remembers it across sessions.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(PIN_STORAGE_KEY, pinned ? '1' : '0');
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [pinned]);

  const renderItem = (item: PanelNavItem) => (
    <div
      key={item.key}
      role='button'
      tabIndex={0}
      onClick={item.onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.onClick();
        }
      }}
      className={[styles.navItem, item.child ? styles.navChild : '', item.active ? styles.navItemActive : ''].join(' ')}
    >
      <span className={styles.navIcon}>{item.icon}</span>
      <span className={styles.navLabel}>{item.label}</span>
      {item.badge !== undefined && item.badge !== '' && <span className={styles.navBadge}>{item.badge}</span>}
    </div>
  );

  return (
    <>
      {/* Faint vertical bar that hints the panel is there.
       * pointer-events-none so it never blocks the trigger zone. */}
      <div className={styles.edgeHint} aria-hidden />
      {/* Invisible 14px hot zone — entering it reveals the panel via :hover-sibling. */}
      <div className={styles.edgeTrigger} aria-hidden />
      <aside
        className={[styles.rightPanel, pinned ? styles.rightPanelPinned : ''].join(' ')}
        role='complementary'
        aria-label={title ?? t('manager.title')}
      >
        <div className={styles.panelHeader}>
          <span className={styles.panelChip}>
            <Schedule theme='outline' size='16' fill='currentColor' />
          </span>
          <div className={styles.panelTitle}>{title ?? t('manager.title')}</div>
          <Tooltip content={pinned ? t('manager.panel.unpin') : t('manager.panel.pin')} mini>
            <Button
              type='text'
              size='mini'
              shape='circle'
              className={styles.pinBtn}
              onClick={() => setPinned((v) => !v)}
              icon={pinned ? <Pushpin theme='filled' size='14' /> : <Pushpin theme='outline' size='14' />}
              aria-pressed={pinned}
            />
          </Tooltip>
        </div>

        {tools && <div className={styles.panelTools}>{tools}</div>}

        <nav className={styles.panelNav}>
          {primary.map(renderItem)}
          {sections.map((section) => (
            <div key={section.key} className={styles.navSection}>
              <div className={styles.navSectionLabel}>{section.label}</div>
              {section.items.map(renderItem)}
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
};

export default RightAutoHidePanel;
