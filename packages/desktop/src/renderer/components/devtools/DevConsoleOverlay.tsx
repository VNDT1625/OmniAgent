/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Floating developer console overlay (renderer-only).
 *
 * Mounted app-wide from `main.tsx`. When the developer console preference
 * (`developer.consoleOverlay`) is enabled, this overlay installs the capture
 * hooks ({@link installDevConsole}) and renders a draggable, always-on-top panel
 * showing live `console.*` output and uncaught errors — so runtime issues are
 * visible without opening Chrome DevTools.
 *
 * The panel can be dragged by its header, collapsed to just the header, filtered
 * by level, cleared, copied to the clipboard, and switched off (which flips the
 * persisted preference). It is rendered into a portal on `document.body` so it
 * floats above all routes.
 *
 * Stack: Arco components + `@icon-park/react` icons + UnoCSS/CSS-module styling
 * with semantic tokens. No raw interactive HTML, no hardcoded colors. All
 * strings go through `t('settings.devConsole.*')`.
 */

import { Button, Message, Select, Tooltip } from '@arco-design/web-react';
import { Clear, Copy, Down, Power, Up } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { configService } from '@/common/config/configService';
import {
  clearDevConsole,
  getDevConsoleEntries,
  installDevConsole,
  subscribeDevConsole,
  uninstallDevConsole,
  type DevLogEntry,
  type DevLogLevel,
} from '@/renderer/utils/devtools/devConsoleStore';
import styles from './DevConsoleOverlay.module.css';

/** Level filter value: a concrete level or `all`. */
type LevelFilter = DevLogLevel | 'all';

/** Format a Unix-ms timestamp as HH:MM:SS for the log gutter. */
const formatTime = (at: number): string => {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const LEVEL_CLASS: Record<DevLogLevel, string> = {
  log: styles.levelLog,
  info: styles.levelInfo,
  debug: styles.levelDebug,
  warn: styles.levelWarn,
  error: styles.levelError,
};

/**
 * The overlay panel. Rendered unconditionally near the app root; it watches the
 * `developer.consoleOverlay` preference and shows/installs itself only when the
 * preference is on.
 */
const DevConsoleOverlay: React.FC = () => {
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState<boolean>(() => configService.get('developer.consoleOverlay') ?? false);
  const [entries, setEntries] = useState<DevLogEntry[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({ x: 16, y: 16 }));

  const bodyRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ dx: number; dy: number } | null>(null);

  // React to preference changes (toggled from Display settings) live.
  useEffect(() => {
    const unsubscribe = configService.subscribe('developer.consoleOverlay', (value) => {
      setEnabled(Boolean(value));
    });
    return unsubscribe;
  }, []);

  // Install / uninstall the capture hooks following the preference.
  useEffect(() => {
    if (!enabled) return;
    installDevConsole();
    setEntries(getDevConsoleEntries());
    const unsubscribe = subscribeDevConsole(setEntries);
    return () => {
      unsubscribe();
      uninstallDevConsole();
    };
  }, [enabled]);

  // Auto-scroll to the newest entry when not collapsed.
  useEffect(() => {
    if (collapsed) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, collapsed]);

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      dragState.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      const onMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const nextX = Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - dragState.current.dx));
        const nextY = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dragState.current.dy));
        setPos({ x: nextX, y: nextY });
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [pos.x, pos.y]
  );

  const filtered = useMemo(
    () => (filter === 'all' ? entries : entries.filter((entry) => entry.level === filter)),
    [entries, filter]
  );

  const handleCopy = useCallback(() => {
    const text = filtered
      .map((entry) => `[${formatTime(entry.at)}] ${entry.level.toUpperCase()} ${entry.text}`)
      .join('\n');
    navigator.clipboard
      .writeText(text)
      .then(() => Message.success(t('settings.devConsole.copied')))
      .catch(() => Message.error(t('common.failed')));
  }, [filtered, t]);

  const handleDisable = useCallback(() => {
    void configService.set('developer.consoleOverlay', false);
  }, []);

  if (!enabled) return null;

  const errorCount = entries.filter((entry) => entry.level === 'error').length;

  const overlay = (
    <div
      className={`${styles.overlay} ${collapsed ? styles.collapsed : ''}`}
      style={{ left: pos.x, top: pos.y }}
      role='log'
      aria-label={t('settings.devConsole.title')}
    >
      <div className={styles.header} onMouseDown={onDragStart}>
        <span className={styles.title}>
          {t('settings.devConsole.title')}
          <span className={styles.count}>
            {entries.length}
            {errorCount > 0 ? ` · ${errorCount} ${t('settings.devConsole.levelError')}` : ''}
          </span>
        </span>
        <span className={styles.spacer} />
        <div className={styles.actions} onMouseDown={(e) => e.stopPropagation()}>
          <Select
            size='mini'
            value={filter}
            onChange={(value: LevelFilter) => setFilter(value)}
            style={{ width: 96 }}
            triggerProps={{ autoAlignPopupWidth: false }}
          >
            <Select.Option value='all'>{t('settings.devConsole.levelAll')}</Select.Option>
            <Select.Option value='log'>{t('settings.devConsole.levelLog')}</Select.Option>
            <Select.Option value='info'>{t('settings.devConsole.levelInfo')}</Select.Option>
            <Select.Option value='warn'>{t('settings.devConsole.levelWarn')}</Select.Option>
            <Select.Option value='error'>{t('settings.devConsole.levelError')}</Select.Option>
          </Select>
          <Tooltip content={t('settings.devConsole.copy')}>
            <Button size='mini' type='text' icon={<Copy theme='outline' size='14' />} onClick={handleCopy} />
          </Tooltip>
          <Tooltip content={t('settings.devConsole.clear')}>
            <Button
              size='mini'
              type='text'
              icon={<Clear theme='outline' size='14' />}
              onClick={() => clearDevConsole()}
            />
          </Tooltip>
          <Tooltip content={collapsed ? t('settings.devConsole.expand') : t('settings.devConsole.collapse')}>
            <Button
              size='mini'
              type='text'
              icon={collapsed ? <Down theme='outline' size='14' /> : <Up theme='outline' size='14' />}
              onClick={() => setCollapsed((prev) => !prev)}
            />
          </Tooltip>
          <Tooltip content={t('settings.devConsole.disable')}>
            <Button
              size='mini'
              type='text'
              status='danger'
              icon={<Power theme='outline' size='14' />}
              onClick={handleDisable}
            />
          </Tooltip>
        </div>
      </div>

      {!collapsed && (
        <div className={styles.body} ref={bodyRef}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>{t('settings.devConsole.empty')}</div>
          ) : (
            filtered.map((entry) => (
              <div key={entry.id} className={`${styles.row} ${LEVEL_CLASS[entry.level]}`}>
                <span className={styles.time}>{formatTime(entry.at)}</span>
                <span className={styles.message}>{entry.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );

  return createPortal(overlay, document.body);
};

export default DevConsoleOverlay;
