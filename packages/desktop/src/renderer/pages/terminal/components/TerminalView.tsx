/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal xterm-backed terminal pane.
 *
 * The process owns shell lifecycle and scrollback; this renderer component only
 * mounts xterm, replays the provided buffer, forwards raw input, and reports
 * fitted dimensions back to the pty. Keep this path small so first paint and
 * input are predictable.
 *
 * Process boundary: Renderer component. No Node.js APIs.
 */

import { Button, Input, Message, Tooltip } from '@arco-design/web-react';
import { ClearFormat, Close, Copy, Search, Terminal as TerminalIcon } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { TerminalSession } from '@process/terminal/terminalTypes';
import { buildXtermTheme } from './xtermTheme';
import { findMtuiStaleConfirmation } from '../constants';
import { registerFileLinks } from './terminalFileLinks';
import type { PendingRemap } from '../useTerminalIntelligence';
import '@xterm/xterm/css/xterm.css';

type TerminalViewProps = {
  session: TerminalSession | null;
  buffer: string;
  onInput: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onClear?: () => void;
  onKill?: () => void;
  onOpenPath?: (path: string, line?: number, column?: number) => void;
  ghostFor?: (line: string) => string | null;
  onCommandFinished?: (commandLine: string, exitCode: number, cwd?: string) => void;
  pendingRemap?: PendingRemap | null;
  onDismissRemap?: () => void;
  autoConfirm?: boolean;
  visible?: boolean;
};

const fitTerminal = (term: Terminal | null, fit: FitAddon | null, host: HTMLElement | null): void => {
  if (!term || !fit || !host) return;
  if (host.clientWidth < 2 || host.clientHeight < 2) return;
  try {
    fit.fit();
    term.refresh(0, Math.max(0, term.rows - 1));
  } catch {
    /* xterm can throw while its renderer is attaching or while hidden. */
  }
};

const writeTerminalBuffer = (term: Terminal, text: string): void => {
  if (text.length === 0) return;
  term.write(text);
};

const TerminalView: React.FC<TerminalViewProps> = ({
  session,
  buffer,
  onInput,
  onResize,
  onClear,
  onKill,
  onOpenPath,
  pendingRemap: _pendingRemap,
  onDismissRemap: _onDismissRemap,
  visible = true,
}) => {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const bufferRef = useRef(buffer);
  const writtenBufferRef = useRef('');
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onOpenPathRef = useRef(onOpenPath);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [matchInfo, setMatchInfo] = useState<{ current: number; total: number } | null>(null);
  const [initError, setInitError] = useState<string | null>(null);

  bufferRef.current = buffer;
  onInputRef.current = onInput;
  onResizeRef.current = onResize;
  onOpenPathRef.current = onOpenPath;

  const isRunning = session?.status === 'running';
  const staleNotice = useMemo(() => findMtuiStaleConfirmation(buffer), [buffer]);

  const runFit = useCallback((): void => {
    fitTerminal(termRef.current, fitRef.current, hostRef.current);
  }, []);

  useEffect(() => {
    if (!session || !hostRef.current) return;

    const host = hostRef.current;
    host.replaceChildren();
    setInitError(null);
    setMatchInfo(null);
    writtenBufferRef.current = '';
    lastSizeRef.current = null;

    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let search: SearchAddon | null = null;
    const disposables: Array<() => void> = [];

    const fitNow = (): void => fitTerminal(term, fit, host);

    try {
      term = new Terminal({
        fontFamily: 'Consolas, "Cascadia Mono", "Cascadia Code", Menlo, "DejaVu Sans Mono", "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        theme: buildXtermTheme(),
      });
      fit = new FitAddon();
      search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new WebLinksAddon());
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;
      searchRef.current = search;
    } catch (error) {
      setInitError(error instanceof Error ? error.message : String(error));
      return;
    }

    const resizeSub = term.onResize(({ cols, rows }) => {
      const last = lastSizeRef.current;
      if (last?.cols === cols && last.rows === rows) return;
      lastSizeRef.current = { cols, rows };
      onResizeRef.current?.(cols, rows);
    });
    const inputSub = term.onData((data) => onInputRef.current(data));
    const searchSub = search.onDidChangeResults((result) => {
      if (!result || result.resultCount === 0) {
        setMatchInfo(result ? { current: 0, total: 0 } : null);
        return;
      }
      setMatchInfo({ current: result.resultIndex + 1, total: result.resultCount });
    });
    const fileLinks = onOpenPathRef.current
      ? registerFileLinks(term, (path, line, column) => onOpenPathRef.current?.(path, line, column))
      : null;

    const ro = new ResizeObserver(fitNow);
    ro.observe(host);
    const raf = requestAnimationFrame(() => {
      fitNow();
      writeTerminalBuffer(term!, bufferRef.current);
      writtenBufferRef.current = bufferRef.current;
      term!.focus();
    });
    const timers = [0, 16, 80, 200].map((delay) => setTimeout(fitNow, delay));

    disposables.push(
      () => resizeSub.dispose(),
      () => inputSub.dispose(),
      () => searchSub.dispose(),
      () => fileLinks?.dispose(),
      () => ro.disconnect(),
      () => cancelAnimationFrame(raf),
      ...timers.map((timer) => () => clearTimeout(timer))
    );

    return () => {
      for (const dispose of disposables) {
        try {
          dispose();
        } catch {}
      }
      term?.dispose();
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      if (searchRef.current === search) searchRef.current = null;
      writtenBufferRef.current = '';
      host.replaceChildren();
    };
  }, [session?.id]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const written = writtenBufferRef.current;
    if (buffer === written) return;

    if (buffer.startsWith(written)) {
      writeTerminalBuffer(term, buffer.slice(written.length));
    } else {
      term.reset();
      writeTerminalBuffer(term, buffer);
    }
    writtenBufferRef.current = buffer;
    requestAnimationFrame(runFit);
  }, [buffer, runFit]);

  useEffect(() => {
    const applyTheme = (): void => {
      const term = termRef.current;
      if (term) term.options.theme = buildXtermTheme();
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    runFit();
    const raf = requestAnimationFrame(runFit);
    const timer = setTimeout(runFit, 80);
    termRef.current?.focus();
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [visible, session?.id, runFit]);

  const updateSearch = useCallback((value: string): void => {
    setSearchTerm(value);
    const search = searchRef.current;
    if (!search || value.length === 0) {
      setMatchInfo(null);
      return;
    }
    search.findNext(value);
  }, []);

  const searchNext = useCallback(
    (direction: 1 | -1): void => {
      const search = searchRef.current;
      if (!search || searchTerm.length === 0) return;
      if (direction === 1) search.findNext(searchTerm);
      else search.findPrevious(searchTerm);
    },
    [searchTerm]
  );

  const copyStaleAcceptCommand = useCallback((): void => {
    if (!staleNotice) return;
    void navigator.clipboard.writeText(staleNotice.acceptCommand).then(
      () => Message.success(t('terminal.view.mtuiConflictCopied')),
      () => Message.error(t('ide.terminal.commandCopyFailed'))
    );
  }, [staleNotice, t]);

  if (!session) {
    return (
      <div className='flex flex-col items-center justify-center gap-12px flex-1 min-h-0 rd-12px bg-fill-1 text-center'>
        <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
          <TerminalIcon theme='outline' size='24' />
        </span>
        <p className='m-0 max-w-360px text-13px text-t-secondary'>{t('terminal.view.noSession')}</p>
      </div>
    );
  }

  return (
    <div className='relative flex flex-col flex-1 min-h-0 min-w-0 rd-12px overflow-hidden bg-fill-1 b-1 b-solid border-b-1'>
      <div className='flex items-center justify-between gap-8px px-12px h-36px shrink-0 b-b-1 b-b-solid border-b-1 bg-fill-2'>
        <div className='flex items-center gap-8px min-w-0'>
          <TerminalIcon theme='outline' size='14' className='text-t-secondary shrink-0' />
          <span className='text-13px font-600 text-t-primary truncate'>{session.title}</span>
          <span className='text-11px text-t-tertiary truncate'>{session.cwd}</span>
        </div>
        <div className='flex items-center gap-4px shrink-0'>
          <span className='text-11px text-t-tertiary'>
            {isRunning
              ? t('terminal.view.running', { pid: session.pid ?? '-' })
              : t('terminal.view.exitedWithCode', { code: session.exitCode ?? '-' })}
          </span>
          <Tooltip content={t('terminal.view.search')} mini>
            <Button
              type='text'
              size='mini'
              icon={<Search theme='outline' size={13} />}
              className={`!text-t-secondary ${searchOpen ? '!text-primary !bg-primary-light-1' : ''}`}
              onClick={() => setSearchOpen((value) => !value)}
            />
          </Tooltip>
          {onClear ? (
            <Tooltip content={t('terminal.view.clear')} mini>
              <Button
                type='text'
                size='mini'
                icon={<ClearFormat theme='outline' size={13} />}
                className='!text-t-secondary'
                onClick={onClear}
              />
            </Tooltip>
          ) : null}
          {onKill && isRunning ? (
            <Tooltip content={t('terminal.view.kill')} mini>
              <Button
                type='text'
                size='mini'
                status='danger'
                icon={<Close theme='outline' size={13} />}
                onClick={onKill}
              />
            </Tooltip>
          ) : null}
        </div>
      </div>

      {searchOpen ? (
        <div className='shrink-0 flex items-center gap-8px px-12px py-6px b-b-1 b-b-solid border-b-1 bg-fill-2'>
          <Search theme='outline' size={13} className='text-t-tertiary shrink-0' />
          <Input
            size='mini'
            value={searchTerm}
            onChange={updateSearch}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setSearchOpen(false);
                setSearchTerm('');
                setMatchInfo(null);
              } else if (event.key === 'Enter') {
                searchNext(event.shiftKey ? -1 : 1);
              }
            }}
            placeholder={t('ide.terminal.searchPlaceholder')}
            aria-label={t('ide.terminal.searchOutput')}
          />
          {searchTerm ? (
            <span className='text-11px text-t-tertiary shrink-0 tabular-nums'>
              {!matchInfo || matchInfo.total === 0
                ? t('ide.terminal.searchNoMatch')
                : t('ide.terminal.searchMatch', { current: matchInfo.current, total: matchInfo.total })}
            </span>
          ) : null}
          <Button
            type='text'
            size='mini'
            icon={<Close theme='outline' size={12} />}
            className='!text-t-tertiary'
            onClick={() => {
              setSearchOpen(false);
              setSearchTerm('');
              setMatchInfo(null);
            }}
          />
        </div>
      ) : null}

      <div
        className='flex-1 min-h-0 min-w-0 overflow-hidden px-8px py-6px'
        onMouseDown={() => termRef.current?.focus()}
      >
        <div ref={hostRef} className='terminal-xterm-host h-full w-full' />
      </div>

      {staleNotice ? (
        <div className='absolute left-12px right-12px bottom-12px z-20 rd-8px bg-popup b-1 b-solid border-b-1 shadow-md p-10px flex flex-col gap-8px'>
          <div className='flex items-start justify-between gap-12px'>
            <div className='min-w-0 flex flex-col gap-2px'>
              <span className='text-12px font-600 text-t-primary'>{t('terminal.view.mtuiConflictTitle')}</span>
              <span className='text-11px text-t-tertiary truncate'>
                {t('terminal.view.mtuiConflictBody', { token: staleNotice.token })}
              </span>
            </div>
            <div className='shrink-0 flex items-center gap-6px'>
              <Tooltip content={staleNotice.acceptCommand} mini>
                <Button
                  size='mini'
                  type='primary'
                  icon={<Copy theme='outline' size={12} />}
                  onClick={copyStaleAcceptCommand}
                >
                  {t('terminal.view.mtuiConflictAccept')}
                </Button>
              </Tooltip>
            </div>
          </div>
          {staleNotice.diffExcerpt ? (
            <pre className='m-0 max-h-96px overflow-auto rd-6px bg-fill-2 px-8px py-6px text-11px text-t-secondary whitespace-pre-wrap break-words'>
              {staleNotice.diffExcerpt}
            </pre>
          ) : null}
        </div>
      ) : null}

      {initError ? (
        <div className='absolute inset-0 flex-center flex-col gap-8px bg-fill-1 text-center px-16px'>
          <span className='size-40px flex-center rd-full bg-fill-2 text-danger'>
            <TerminalIcon theme='outline' size={20} />
          </span>
          <p className='m-0 max-w-360px text-12px text-t-secondary'>{t('terminal.view.initError')}</p>
          <p className='m-0 max-w-360px text-11px text-t-tertiary font-mono break-all'>{initError}</p>
        </div>
      ) : null}
    </div>
  );
};

export default TerminalView;
