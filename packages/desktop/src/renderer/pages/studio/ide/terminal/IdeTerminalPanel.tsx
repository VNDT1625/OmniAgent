/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `IdeTerminalPanel` — the IDE's collapsible bottom dock, now with IDE-grade
 * terminal features:
 *
 *  - **Terminal tab** — interactive shells. New terminals open with the IDE's
 *    open folder as their `cwd`. A horizontal chip strip switches/closes sessions.
 *    Double-click a chip to rename the session (local title override).
 *  - **Console tab** — read-only output viewer for any session.
 *  - **Split view** — split the terminal area into two panes side-by-side, each
 *    showing a different session.
 *  - **xterm.js rendering** — each pane embeds a full {@link TerminalView}
 *    (xterm.js): real TTY emulation (TUIs, cursor, alt-screen), char-mode input,
 *    a WebGL renderer, and exact resize via the FitAddon.
 *  - **Search in output** — Ctrl+F or toolbar button inside each TerminalView.
 *  - **Clear output** — per-session renderer-side buffer slice.
 *  - **Kill session** — sends SIGTERM via the terminal bridge.
 *  - **Resize TTY** — estimates rows/cols from the panel height and notifies the
 *    Main-process backend on every resize so line-wrapping stays accurate.
 *  - **Drag-to-resize** — drag the top handle to set panel height (160–600px).
 *  - **Collapsible** — collapses to a 38px status bar showing the running count.
 *
 * Desktop-only: the terminal bridge is a native Main-process service.
 *
 * Process boundary: Renderer component. No Node.js APIs.
 */

import { Button, Dropdown, Empty, Input, Menu, Select, Tooltip } from '@arco-design/web-react';
import { Close, Column, Down, Plus, Terminal, Up } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { useTerminalState } from '@renderer/pages/terminal/useTerminalState';
import { normalizeOutputRich } from '@renderer/pages/terminal/constants';
import TerminalView from '@renderer/pages/terminal/components/TerminalView';
import { useAddEventListener } from '@renderer/utils/emitter';

type IdeTerminalPanelProps = {
  /** The IDE's open folder. New terminals start here so commands target the project. */
  defaultCwd: string | null;
  /**
   * Open a file in the IDE editor when the user clicks a `file:line:col` link in
   * terminal output. The path may be relative to the open folder.
   */
  onOpenPath?: (path: string, line?: number, column?: number) => void;
};

type PanelTab = 'terminal' | 'console';

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 600;
const DEFAULT_HEIGHT = 300;
const COLLAPSED_HEIGHT = 38;

const IdeTerminalPanel: React.FC<IdeTerminalPanelProps> = ({ defaultCwd, onOpenPath }) => {
  const { t } = useTranslation();
  const term = useTerminalState();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>('terminal');
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [consoleId, setConsoleId] = useState<string | null>(null);
  const [splitMode, setSplitMode] = useState(false);
  const [splitSessionId, setSplitSessionId] = useState<string | null>(null);
  /** Renderer-side clear offsets: key = session id, value = buffer length at clear time. */
  const [clearOffsets, setClearOffsets] = useState<Record<string, number>>({});
  /** Local title overrides (double-click rename). */
  const [localTitles, setLocalTitles] = useState<Record<string, string>>({});
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const dragState = useRef<{ startY: number; startH: number } | null>(null);

  const activeSession = useMemo(
    () => term.sessions.find((s) => s.id === term.activeId) ?? null,
    [term.sessions, term.activeId]
  );

  const consoleSession = useMemo(
    () => term.sessions.find((s) => s.id === consoleId) ?? activeSession,
    [term.sessions, consoleId, activeSession]
  );

  const splitSession = useMemo(
    () => term.sessions.find((s) => s.id === splitSessionId) ?? null,
    [term.sessions, splitSessionId]
  );

  /** Get the display buffer for a session, sliced from the clear offset. */
  const displayBuffer = useCallback(
    (id: string): string => {
      const raw = term.buffers[id] ?? '';
      const offset = clearOffsets[id] ?? 0;
      return raw.slice(offset);
    },
    [term.buffers, clearOffsets]
  );

  // Drag-to-resize
  useEffect(() => {
    if (!open) return;
    const onMove = (e: MouseEvent): void => {
      const drag = dragState.current;
      if (!drag) return;
      const next = drag.startH + (drag.startY - e.clientY);
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, next)));
    };
    const onUp = (): void => {
      dragState.current = null;
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [open]);

  // Notify TTY resize when panel height changes — handled by xterm's FitAddon
  // (which measures the real grid and calls onResize → terminalClient.resize),
  // so no manual estimate is needed here.

  const startResize = useCallback(
    (e: React.MouseEvent): void => {
      dragState.current = { startY: e.clientY, startH: height };
      document.body.style.userSelect = 'none';
    },
    [height]
  );

  const openNewTerminal = useCallback(
    async (profile?: { shell?: string; args?: string[] }): Promise<void> => {
      setOpen(true);
      setTab('terminal');
      const options = {
        ...(defaultCwd ? { cwd: defaultCwd } : {}),
        ...(profile?.shell ? { shell: profile.shell, args: profile.args } : {}),
      };
      const session = await term.createSession(Object.keys(options).length > 0 ? options : undefined);
      if (session && splitMode && !splitSessionId) {
        setSplitSessionId(session.id);
      }
    },
    [term, defaultCwd, splitMode, splitSessionId]
  );

  // Run a quick command from the file tree: open the dock, spawn a session at
  // the requested cwd, and (when a command is given) type it in. An empty
  // command means "just open a terminal here".
  useAddEventListener(
    'ide.terminal.run',
    (payload) => {
      void (async () => {
        setOpen(true);
        setTab('terminal');
        const session = await term.createSession(payload.cwd ? { cwd: payload.cwd } : undefined);
        if (!session) return;
        term.setActiveId(session.id);
        if (payload.command) {
          // Small delay so the freshly-spawned shell is ready for stdin.
          setTimeout(() => term.writeSession(session.id, `${payload.command}\r`), 150);
        }
      })();
    },
    [term]
  );

  // Quick Run spawns its own terminal session (so it can read the dev URL from
  // the output); this event just brings that session into view in the dock so
  // the user sees the live output without hunting for the tab.
  useAddEventListener(
    'ide.terminal.focus',
    (payload) => {
      setOpen(true);
      setTab('terminal');
      term.setActiveId(payload.id);
    },
    [term]
  );

  const clearSession = useCallback(
    (id: string): void => {
      setClearOffsets((prev) => ({ ...prev, [id]: (term.buffers[id] ?? '').length }));
    },
    [term.buffers]
  );

  const killSession = useCallback(
    (id: string): void => {
      term.killSession(id);
    },
    [term]
  );

  const commitRename = useCallback((): void => {
    if (!editingSessionId) return;
    const trimmed = editTitle.trim();
    if (trimmed) setLocalTitles((prev) => ({ ...prev, [editingSessionId]: trimmed }));
    setEditingSessionId(null);
    setEditTitle('');
  }, [editingSessionId, editTitle]);

  const sessionTitle = useCallback(
    (id: string, fallback: string, idx: number): string =>
      localTitles[id] ?? (fallback || t('ide.terminal.session', { n: idx + 1 })),
    [localTitles, t]
  );

  if (!isElectronDesktop()) return null;

  const runningCount = term.runningCount;

  // Collapsed bar
  if (!open) {
    return (
      <footer
        className='shrink-0 flex items-center gap-10px px-12px border-t border-b-1 bg-fill-1'
        style={{ height: COLLAPSED_HEIGHT }}
      >
        <button
          type='button'
          onClick={() => setOpen(true)}
          aria-label={t('ide.terminal.show')}
          className='flex items-center gap-8px h-26px px-10px rd-7px cursor-pointer border-none bg-transparent text-t-secondary hover:bg-fill-2 hover:text-t-primary transition-colors'
        >
          <Terminal theme='outline' size={15} />
          <span className='text-12px font-[500]'>{t('ide.terminal.title')}</span>
          {runningCount > 0 ? (
            <span className='min-w-18px h-18px px-5px flex-center rd-full bg-success text-white text-10px font-600'>
              {runningCount}
            </span>
          ) : null}
        </button>
        <div className='flex-1' />
        <Tooltip content={t('ide.terminal.newTerminal')} position='top'>
          <Button
            type='text'
            size='mini'
            icon={<Plus theme='outline' size={14} />}
            onClick={() => void openNewTerminal()}
            className='!text-t-secondary'
          />
        </Tooltip>
        <Tooltip content={t('ide.terminal.show')} position='tl'>
          <Button
            type='text'
            size='mini'
            icon={<Up theme='outline' size={14} />}
            onClick={() => setOpen(true)}
            className='!text-t-secondary'
          />
        </Tooltip>
      </footer>
    );
  }

  return (
    <footer className='shrink-0 flex flex-col min-h-0 border-t border-b-1 bg-1' style={{ height }}>
      {/* Resize handle */}
      <div
        role='separator'
        aria-label={t('ide.terminal.resizeHandle')}
        aria-orientation='horizontal'
        onMouseDown={startResize}
        className='h-4px shrink-0 cursor-row-resize bg-transparent hover:bg-primary-light-2 transition-colors'
      />

      {/* Tab bar + actions */}
      <div className='shrink-0 flex items-center gap-4px px-10px h-34px border-b border-b-1 bg-fill-1'>
        <DockTab
          icon={<Terminal theme='outline' size={13} />}
          label={t('ide.terminal.title')}
          active={tab === 'terminal'}
          onClick={() => setTab('terminal')}
        />
        <DockTab label={t('ide.terminal.console')} active={tab === 'console'} onClick={() => setTab('console')} />
        <div className='flex-1' />
        {tab === 'terminal' ? (
          <>
            <Tooltip content={t('ide.terminal.newTerminal')} position='top'>
              <Button
                type='text'
                size='mini'
                icon={<Plus theme='outline' size={14} />}
                onClick={() => void openNewTerminal()}
                className='!text-t-secondary'
              />
            </Tooltip>
            {term.shellProfiles.length > 1 ? (
              <Dropdown
                position='br'
                droplist={
                  <Menu
                    onClickMenuItem={(key) => {
                      const profile = term.shellProfiles.find((p) => p.id === key);
                      if (profile) void openNewTerminal({ shell: profile.path, args: profile.args });
                    }}
                  >
                    <Menu.Item key='__label' disabled className='!text-11px !text-t-tertiary !cursor-default'>
                      {t('ide.terminal.selectShell')}
                    </Menu.Item>
                    {term.shellProfiles.map((p) => (
                      <Menu.Item key={p.id}>
                        <span className='flex items-center gap-8px'>
                          <Terminal theme='outline' size={13} />
                          {p.label}
                          {p.isDefault ? (
                            <span className='text-10px text-t-tertiary'>{t('ide.terminal.shellDefault')}</span>
                          ) : null}
                        </span>
                      </Menu.Item>
                    ))}
                  </Menu>
                }
              >
                <Button
                  type='text'
                  size='mini'
                  aria-label={t('ide.terminal.selectShell')}
                  icon={<Down theme='outline' size={12} />}
                  className='!text-t-secondary !px-2px'
                />
              </Dropdown>
            ) : null}
            {term.sessions.length >= 2 ? (
              <Tooltip content={splitMode ? t('ide.terminal.unsplit') : t('ide.terminal.split')} position='top'>
                <Button
                  type='text'
                  size='mini'
                  icon={<Column theme='outline' size={14} />}
                  className={`!text-t-secondary ${splitMode ? '!text-primary !bg-primary-light-1' : ''}`}
                  onClick={() => {
                    if (splitMode) {
                      setSplitMode(false);
                      setSplitSessionId(null);
                    } else {
                      setSplitMode(true);
                      // Pick the second session as the split pane
                      const other = term.sessions.find((s) => s.id !== term.activeId);
                      if (other) setSplitSessionId(other.id);
                    }
                  }}
                />
              </Tooltip>
            ) : null}
          </>
        ) : null}
        <Tooltip content={t('ide.terminal.hide')} position='tl'>
          <Button
            type='text'
            size='mini'
            icon={<Down theme='outline' size={14} />}
            onClick={() => setOpen(false)}
            className='!text-t-secondary'
          />
        </Tooltip>
      </div>

      {/* Body */}
      <div className='flex-1 min-h-0 flex flex-col p-8px'>
        {term.status === 'unavailable' ? (
          <div className='flex-1 flex-center flex-col gap-10px text-center'>
            <span className='size-40px flex-center rd-full bg-fill-2 text-t-tertiary'>
              <Terminal theme='outline' size={20} />
            </span>
            <p className='m-0 max-w-320px text-12px text-t-secondary'>{t('ide.terminal.unavailable')}</p>
            <Button size='small' onClick={term.retry}>
              {t('ide.terminal.retry')}
            </Button>
          </div>
        ) : tab === 'terminal' ? (
          <TerminalTab
            term={term}
            activeSession={activeSession}
            splitMode={splitMode}
            splitSession={splitSession}
            splitSessionId={splitSessionId}
            setSplitSessionId={setSplitSessionId}
            editingSessionId={editingSessionId}
            editTitle={editTitle}
            setEditTitle={setEditTitle}
            onStartEdit={(id, title) => {
              setEditingSessionId(id);
              setEditTitle(title);
            }}
            onCommitEdit={commitRename}
            onCancelEdit={() => {
              setEditingSessionId(null);
              setEditTitle('');
            }}
            sessionTitle={sessionTitle}
            displayBuffer={displayBuffer}
            onNew={() => void openNewTerminal()}
            onClear={clearSession}
            onKill={killSession}
            onOpenPath={onOpenPath}
          />
        ) : (
          <ConsoleTab term={term} session={consoleSession} onPick={setConsoleId} displayBuffer={displayBuffer} />
        )}
      </div>
    </footer>
  );
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const DockTab: React.FC<{ icon?: React.ReactNode; label: string; active: boolean; onClick: () => void }> = ({
  icon,
  label,
  active,
  onClick,
}) => (
  <button
    type='button'
    onClick={onClick}
    aria-pressed={active}
    className={`flex items-center gap-6px h-24px px-10px rd-6px cursor-pointer border-none text-12px font-[500] transition-colors ${
      active
        ? 'bg-primary-light-1 text-primary'
        : 'bg-transparent text-t-secondary hover:bg-fill-2 hover:text-t-primary'
    }`}
  >
    {icon}
    <span>{label}</span>
  </button>
);

const TerminalTab: React.FC<{
  term: ReturnType<typeof useTerminalState>;
  activeSession: ReturnType<typeof useTerminalState>['sessions'][number] | null;
  splitMode: boolean;
  splitSession: ReturnType<typeof useTerminalState>['sessions'][number] | null;
  splitSessionId: string | null;
  setSplitSessionId: (id: string | null) => void;
  editingSessionId: string | null;
  editTitle: string;
  setEditTitle: (v: string) => void;
  onStartEdit: (id: string, title: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  sessionTitle: (id: string, fallback: string, idx: number) => string;
  displayBuffer: (id: string) => string;
  onNew: () => void;
  onClear: (id: string) => void;
  onKill: (id: string) => void;
  onOpenPath?: (path: string, line?: number, column?: number) => void;
}> = ({
  term,
  activeSession,
  splitMode,
  splitSession,
  splitSessionId,
  setSplitSessionId,
  editingSessionId,
  editTitle,
  setEditTitle,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  sessionTitle,
  displayBuffer,
  onNew,
  onClear,
  onKill,
  onOpenPath,
}) => {
  const { t } = useTranslation();

  if (term.sessions.length === 0) {
    return (
      <div className='flex-1 flex-center flex-col gap-12px text-center'>
        <span className='size-40px flex-center rd-full bg-fill-2 text-t-tertiary'>
          <Terminal theme='outline' size={20} />
        </span>
        <p className='m-0 max-w-320px text-12px text-t-secondary'>{t('ide.terminal.empty')}</p>
        <Button type='primary' size='small' icon={<Plus theme='outline' size={14} />} onClick={onNew}>
          {t('ide.terminal.newTerminal')}
        </Button>
      </div>
    );
  }

  return (
    <div className='flex-1 min-h-0 flex flex-col gap-6px'>
      {/* Session chips */}
      <div className='shrink-0 flex items-center gap-4px overflow-x-auto pb-2px'>
        {term.sessions.map((session, idx) => {
          const active = session.id === activeSession?.id;
          const running = session.status === 'running';
          const title = sessionTitle(session.id, session.title, idx);
          const isEditing = editingSessionId === session.id;

          return (
            <div
              key={session.id}
              role='tab'
              aria-selected={active}
              title={session.cwd}
              onClick={() => !isEditing && term.setActiveId(session.id)}
              className={`group flex items-center gap-6px shrink-0 h-26px pl-9px pr-6px rd-7px cursor-pointer border b-solid transition-colors ${
                active
                  ? 'bg-1 border-arco-2 text-t-primary'
                  : 'bg-fill-1 border-transparent text-t-secondary hover:bg-fill-2'
              }`}
            >
              <span className={`size-6px rd-full shrink-0 ${running ? 'bg-success' : 'bg-fill-4'}`} />
              {isEditing ? (
                <Input
                  size='mini'
                  value={editTitle}
                  onChange={setEditTitle}
                  onPressEnter={onCommitEdit}
                  onBlur={onCommitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') onCancelEdit();
                  }}
                  className='!w-100px !text-12px font-mono'
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className='text-12px max-w-120px truncate'
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    onStartEdit(session.id, title);
                  }}
                  title={t('ide.terminal.renameSession')}
                >
                  {title}
                </span>
              )}
              {/* Split pane selector */}
              {splitMode && !isEditing ? (
                <span
                  role='button'
                  aria-label='Set as split pane'
                  onClick={(e) => {
                    e.stopPropagation();
                    setSplitSessionId(session.id);
                  }}
                  className={`shrink-0 size-15px flex-center rd-4px text-10px font-600 ${
                    splitSessionId === session.id ? 'bg-primary text-white' : 'text-t-tertiary hover:bg-fill-3'
                  }`}
                  title='Show in split pane'
                >
                  2
                </span>
              ) : null}
              <span
                role='button'
                aria-label={t('ide.terminal.closeSession')}
                onClick={(e) => {
                  e.stopPropagation();
                  term.removeSession(session.id);
                }}
                className='shrink-0 size-15px flex-center rd-4px text-t-tertiary hover:bg-fill-3 hover:text-t-primary'
              >
                <Close theme='outline' size={10} />
              </span>
            </div>
          );
        })}
      </div>

      {/* Terminal view(s) */}
      {splitMode && splitSession && splitSession.id !== activeSession?.id ? (
        <div className='flex-1 min-h-0 flex gap-6px'>
          <div className='flex-1 min-w-0 min-h-0 flex flex-col'>
            <TerminalView
              session={activeSession}
              buffer={activeSession ? displayBuffer(activeSession.id) : ''}
              onInput={(data) => activeSession && term.writeSession(activeSession.id, data)}
              onResize={(cols, rows) => activeSession && term.resizeSession(activeSession.id, cols, rows)}
              onClear={() => activeSession && onClear(activeSession.id)}
              onKill={() => activeSession && onKill(activeSession.id)}
              onOpenPath={onOpenPath}
            />
          </div>
          <div className='w-1px shrink-0 bg-fill-3' />
          <div className='flex-1 min-w-0 min-h-0 flex flex-col'>
            <TerminalView
              session={splitSession}
              buffer={displayBuffer(splitSession.id)}
              onInput={(data) => term.writeSession(splitSession.id, data)}
              onResize={(cols, rows) => term.resizeSession(splitSession.id, cols, rows)}
              onClear={() => onClear(splitSession.id)}
              onKill={() => onKill(splitSession.id)}
              onOpenPath={onOpenPath}
            />
          </div>
        </div>
      ) : (
        <TerminalView
          session={activeSession}
          buffer={activeSession ? displayBuffer(activeSession.id) : ''}
          onInput={(data) => activeSession && term.writeSession(activeSession.id, data)}
          onResize={(cols, rows) => activeSession && term.resizeSession(activeSession.id, cols, rows)}
          onClear={() => activeSession && onClear(activeSession.id)}
          onKill={() => activeSession && onKill(activeSession.id)}
          onOpenPath={onOpenPath}
        />
      )}
    </div>
  );
};

const ConsoleTab: React.FC<{
  term: ReturnType<typeof useTerminalState>;
  session: ReturnType<typeof useTerminalState>['sessions'][number] | null;
  onPick: (id: string | null) => void;
  displayBuffer: (id: string) => string;
}> = ({ term, session, onPick, displayBuffer }) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const spans = useMemo(
    () => (session ? normalizeOutputRich(displayBuffer(session.id)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, term.buffers]
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [spans]);

  if (term.sessions.length === 0) {
    return (
      <div className='flex-1 flex-center text-center'>
        <Empty description={t('ide.terminal.consoleEmpty')} />
      </div>
    );
  }

  return (
    <div className='flex-1 min-h-0 flex flex-col gap-8px'>
      <div className='shrink-0 flex items-center gap-8px'>
        <span className='text-12px text-t-tertiary shrink-0'>{t('ide.terminal.consolePick')}</span>
        <Select size='small' value={session?.id} onChange={(value) => onPick(value as string)} className='!w-220px'>
          {term.sessions.map((s) => (
            <Select.Option key={s.id} value={s.id}>
              {s.title || s.id}
            </Select.Option>
          ))}
        </Select>
      </div>
      <div
        ref={scrollRef}
        className='flex-1 min-h-0 overflow-y-auto rd-10px bg-fill-1 b-1 b-solid border-b-1 px-12px py-8px font-mono text-12px leading-relaxed whitespace-pre-wrap break-words select-text'
      >
        {spans.length === 0 ? (
          <span className='text-t-tertiary'>{t('ide.terminal.consoleWaiting')}</span>
        ) : (
          spans.map((span, i) => {
            const style: React.CSSProperties = {};
            if (span.color) style.color = span.color;
            if (span.bgColor) style.backgroundColor = span.bgColor;
            if (span.bold) style.fontWeight = 'bold';
            if (span.dim) style.opacity = 0.6;
            if (span.italic) style.fontStyle = 'italic';
            if (span.underline) style.textDecoration = 'underline';
            return (
              <span key={i} style={style}>
                {span.text}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
};

export default IdeTerminalPanel;
