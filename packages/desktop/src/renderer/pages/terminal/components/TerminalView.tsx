/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `TerminalView` — a VS Code-grade interactive terminal pane for a single
 * session, rendered with **xterm.js** (the same emulator VS Code uses).
 *
 * Parity features with VS Code's integrated terminal:
 *  - **Full TTY emulation** (xterm.js): cursor addressing, erase, alt-screen →
 *    TUIs (vim/htop/lazygit) render correctly.
 *  - **Char-mode input**: each keystroke is forwarded to the pty via `onData`
 *    (arrows, Tab-complete, Ctrl-* all work).
 *  - **WebGL renderer + virtualization**: a flood of output never stutters.
 *  - **Exact resize** via {@link FitAddon} → reported back to the pty.
 *  - **Command decorations** (shell integration): OSC 633 markers emitted by the
 *    instrumented shell are turned into a success/error gutter dot next to each
 *    command, with exit code in the hover.
 *  - **Find with match count** (N/M) via the search addon's result event.
 *  - **Clickable `file:line:col` links** → open in the editor (when `onOpenPath`
 *    is provided), plus web URLs via the web-links addon.
 *
 * The component is fed the session's accumulated output as `buffer`. It writes
 * only the appended delta to xterm, tokenizing the OSC 633 sequences out of the
 * stream so command markers land at the right cursor row. The surrounding chrome
 * (title, search, clear, kill) stays Arco + UnoCSS tokens.
 *
 * Process boundary: Renderer component. No Node.js APIs.
 */

import { Button, Message, Tooltip } from '@arco-design/web-react';
import { ClearFormat, Close, PlayOne, Copy, Search, Terminal as TerminalIcon } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal, type IDisposable, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { TerminalSession } from '@process/terminal/terminalTypes';
import { buildXtermTheme } from './xtermTheme';
import { tokenizeShellIntegration } from '../shellIntegrationParser';
import { findMtuiStaleConfirmation, stripAnsi } from '../constants';
import { registerFileLinks } from './terminalFileLinks';
import type { PendingRemap } from '../useTerminalIntelligence';
import { buildAckLine, buildConfirmPrompt, interpretConfirmKey } from '@process/terminal/smartFix/smartFixPrompt';
import '@xterm/xterm/css/xterm.css';

/** True when a keystroke chunk is plain printable text (no control/escape). */
const isPrintableInput = (data: string): boolean => {
  if (data.length === 0) return false;
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
};

type TerminalViewProps = {
  session: TerminalSession | null;
  /** The session's accumulated output (replay buffer, then streamed). */
  buffer: string;
  /** Raw keystrokes from xterm (char-mode) → write to the pty's stdin. */
  onInput: (data: string) => void;
  /** Fired when the fitted terminal size changes → notify the pty to resize. */
  onResize?: (cols: number, rows: number) => void;
  /** Called when the user clicks Clear — parent should reset the display buffer. */
  onClear?: () => void;
  /** Called when the user clicks Kill — parent should call terminalClient.kill. */
  onKill?: () => void;
  /**
   * Called when the user activates a `file:line:col` link in the output. The
   * parent (IDE) opens the file in the editor at that position. When omitted,
   * file links are not registered (e.g. on the standalone Settings page).
   */
  onOpenPath?: (path: string, line?: number, column?: number) => void;
  /**
   * docTerminal ghost-text: given the line typed so far, return the faded
   * completion TAIL to show (text after the prefix), or null. Pure + local
   * (no IPC), so it runs on every keystroke without latency. When omitted,
   * ghost-text is disabled.
   */
  ghostFor?: (line: string) => string | null;
  /** Called when a command finishes (shell-integration command-end). */
  onCommandFinished?: (commandLine: string, exitCode: number, cwd?: string) => void;
  /** Smart Fix suggestion for a failed command (rendered as a notice). */
  pendingRemap?: PendingRemap | null;
  /** Dismiss the Smart Fix notice. */
  onDismissRemap?: () => void;
  /**
   * When true (auto-rerun enabled), a detected remap also prints an in-terminal
   * `(y/N)` prompt and arms keyboard confirmation, so an agent (or human) driving
   * the terminal can apply the fix by typing `y` — not just by clicking the button.
   */
  autoConfirm?: boolean;
  /**
   * Hint that the view is currently the active/visible one (e.g. IDE terminal tab vs console tab).
   * When it becomes true we aggressively fit so xterm paints if it was created while the
   * container was still settling.
   */
  visible?: boolean;
};

const TerminalView: React.FC<TerminalViewProps> = ({
  session,
  buffer,
  onInput,
  onResize,
  onClear,
  onKill,
  onOpenPath,
  ghostFor,
  onCommandFinished,
  pendingRemap,
  onDismissRemap,
  autoConfirm,
  visible = true,
}) => {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  /** How much of `buffer` xterm has already been shown (for delta writes). */
  const writtenLenRef = useRef(0);
  /** Latest buffer value, so the (possibly delayed) xterm boot can repaint it. */
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;
  /** Pending command-start marker awaiting its command-end (for decorations). */
  const pendingCmdRef = useRef<IMarker | null>(null);
  /** The most recent command line (OSC 633 ; E) seen, paired to the next command. */
  const lastCmdLineRef = useRef<string>('');
  /** Live command decorations + markers, disposed on reset/unmount. */
  const decorationsRef = useRef<IDisposable[]>([]);
  /** Latest callbacks so the once-bound xterm listeners stay current. */
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onOpenPathRef = useRef(onOpenPath);
  onInputRef.current = onInput;
  onResizeRef.current = onResize;
  onOpenPathRef.current = onOpenPath;
  /** docTerminal: latest ghost source + command-finished callback. */
  const ghostForRef = useRef(ghostFor);
  const onCommandFinishedRef = useRef(onCommandFinished);
  ghostForRef.current = ghostFor;
  onCommandFinishedRef.current = onCommandFinished;
  /** Smart Fix auto-confirm: the remap awaiting a y/N keypress (auto-rerun mode), or null. */
  const awaitingConfirmRef = useRef<PendingRemap | null>(null);
  const onDismissRemapRef = useRef(onDismissRemap);
  onDismissRemapRef.current = onDismissRemap;
  /** Latest `t` so the once-bound input handler localizes the confirm prompt correctly. */
  const tRef = useRef(t);
  tRef.current = t;
  /** Current working directory reported by shell integration (for capture). */
  const cwdRef = useRef<string | undefined>(undefined);
  /** The line the user has typed since the last prompt (for ghost-text). */
  const lineBufferRef = useRef('');
  /** Whether we can reliably track the current line (false after escape/control). */
  const trackingRef = useRef(true);
  /** The currently-shown ghost tail (what Tab would accept). */
  const ghostTailRef = useRef('');
  /** Ghost overlay render state: tail + pixel position within the container. */
  const [ghost, setGhost] = useState<{ tail: string; left: number; top: number; height: number } | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [matchInfo, setMatchInfo] = useState<{ current: number; total: number } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /** Floating command actions (rerun/copy) anchored to a decoration dot. */
  const [cmdMenu, setCmdMenu] = useState<{ x: number; y: number; commandLine: string } | null>(null);
  /** Set when xterm fails to initialize, so we show a notice instead of a blank pane. */
  const [initError, setInitError] = useState<string | null>(null);
  const [mirrorVisible, setMirrorVisible] = useState(false);
  /** Bumped once xterm is actually open, so the buffer-stream effect re-runs. */
  const [booted, setBooted] = useState(0);

  const isRunning = session?.status === 'running';
  const staleNotice = useMemo(() => findMtuiStaleConfirmation(buffer), [buffer]);
  const mirrorText = useMemo(() => stripAnsi(buffer), [buffer]);

  const forceRepaint = useCallback((): void => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      /* xterm can throw while its renderer is being attached/detached. */
    }
  }, []);

  const fitAndRepaint = useCallback((): void => {
    try {
      fitRef.current?.fit();
      forceRepaint();
    } catch {
      /* The host may still be hidden or 0px during IDE dock transitions. */
    }
  }, [forceRepaint]);

  /** Drop all command decorations + markers (on session switch / clear). */
  const clearDecorations = useCallback((): void => {
    for (const d of decorationsRef.current) d.dispose();
    decorationsRef.current = [];
    pendingCmdRef.current = null;
    lastCmdLineRef.current = '';
    lineBufferRef.current = '';
    trackingRef.current = true;
    ghostTailRef.current = '';
    setGhost(null);
    setCmdMenu(null);
  }, []);

  /**
   * Apply a shell-integration event to the terminal: a command-line records the
   * text for rerun; a command-start records a marker at the current row; a
   * command-end attaches a colored gutter dot to that marker reflecting the exit
   * code (green ok / red failed). Clicking the dot opens rerun/copy actions.
   */
  const applyShellEvent = useCallback(
    (term: Terminal, event: ReturnType<typeof tokenizeShellIntegration>[number]): void => {
      if (event.type !== 'event') return;
      const ev = event.event;
      if (ev.kind === 'command-line') {
        lastCmdLineRef.current = ev.commandLine;
      } else if (ev.kind === 'cwd') {
        cwdRef.current = ev.cwd;
      } else if (ev.kind === 'prompt-end') {
        // A fresh prompt — reset the typed-line tracker so ghost-text anchors cleanly.
        lineBufferRef.current = '';
        trackingRef.current = true;
        ghostTailRef.current = '';
        setGhost(null);
      } else if (ev.kind === 'command-start') {
        pendingCmdRef.current = term.registerMarker(0) ?? null;
        // A command is running — hide any ghost.
        ghostTailRef.current = '';
        setGhost(null);
      } else if (ev.kind === 'command-end') {
        const marker = pendingCmdRef.current;
        pendingCmdRef.current = null;
        // Learn the command + (on failure) offer a Smart Fix — independent of decoration.
        const finishedLine = lastCmdLineRef.current;
        if (finishedLine) onCommandFinishedRef.current?.(finishedLine, ev.exitCode, cwdRef.current);
        if (!marker) return;
        const ok = ev.exitCode === 0;
        const commandLine = lastCmdLineRef.current;
        const decoration = term.registerDecoration({ marker, overviewRulerOptions: undefined });
        if (!decoration) {
          decorationsRef.current.push(marker);
          return;
        }
        decoration.onRender((el) => {
          el.classList.add('aionui-cmd-dot');
          el.classList.toggle('aionui-cmd-ok', ok);
          el.classList.toggle('aionui-cmd-fail', !ok);
          el.style.cursor = commandLine ? 'pointer' : 'default';
          el.title = ok ? 'exit 0' : `exit ${ev.exitCode}`;
          // Click the gutter dot → show rerun/copy actions for this command.
          el.onclick = commandLine
            ? (e: MouseEvent) => {
                e.stopPropagation();
                setCmdMenu({ x: e.clientX, y: e.clientY, commandLine });
              }
            : null;
        });
        decorationsRef.current.push(decoration, marker);
      }
    },
    []
  );

  /** Write a buffer slice to xterm, splitting out OSC 633 markers in order. */
  const writeWithMarkers = useCallback(
    (term: Terminal, slice: string): void => {
      const tokens = tokenizeShellIntegration(slice);
      for (const token of tokens) {
        if (token.type === 'text') {
          if (token.text.length > 0) term.write(token.text);
        } else {
          // Apply the marker after the preceding text is flushed so it lands on
          // the right row. xterm.write is async-buffered, so schedule it.
          term.write('', () => applyShellEvent(term, token));
        }
      }
    },
    [applyShellEvent]
  );

  // ── docTerminal ghost-text: recompute + position at the cursor ────────────
  /** Recompute the ghost tail for the current line and anchor it to the cursor. */
  const recomputeGhost = useCallback((): void => {
    const fn = ghostForRef.current;
    const host = hostRef.current;
    if (!fn || !host || !trackingRef.current) {
      ghostTailRef.current = '';
      setGhost(null);
      return;
    }
    const line = lineBufferRef.current;
    const tail = line.length > 0 ? fn(line) : null;
    if (!tail) {
      ghostTailRef.current = '';
      setGhost(null);
      return;
    }
    ghostTailRef.current = tail;
    // Anchor to the actual cursor DOM node so the ghost never misaligns,
    // regardless of font metrics / renderer. If we cannot find it, hide it.
    const cursorEl = host.querySelector('.xterm-cursor, .xterm-cursor-block, .xterm-cursor-bar, .xterm-cursor-outline');
    const containerRect = host.getBoundingClientRect();
    if (!cursorEl) {
      setGhost(null);
      return;
    }
    const r = cursorEl.getBoundingClientRect();
    setGhost({ tail, left: r.right - containerRect.left, top: r.top - containerRect.top, height: r.height });
  }, []);

  /**
   * Handle a raw keystroke chunk: maintain the typed-line buffer for ghost-text,
   * accept the ghost on Tab, and forward everything to the pty. Tracking is
   * conservative — any escape/control sequence (arrows, history, ctrl) stops
   * tracking until the next prompt, so the ghost is never shown from a stale line.
   */
  const handleInputData = useCallback(
    (data: string): void => {
      // Tab accepts a shown ghost (and is swallowed, not sent to the shell).
      if (data === '\t' && ghostTailRef.current) {
        const tail = ghostTailRef.current;
        lineBufferRef.current += tail;
        ghostTailRef.current = '';
        setGhost(null);
        onInputRef.current(tail);
        return;
      }
      if (data === '\r' || data === '\n') {
        lineBufferRef.current = '';
        trackingRef.current = true;
        ghostTailRef.current = '';
        setGhost(null);
      } else if (data === '\x7f' || data === '\b') {
        lineBufferRef.current = lineBufferRef.current.slice(0, -1);
      } else if (isPrintableInput(data)) {
        lineBufferRef.current += data;
      } else {
        // Escape/control sequence — we can no longer track the line reliably.
        trackingRef.current = false;
        lineBufferRef.current = '';
        ghostTailRef.current = '';
        setGhost(null);
      }
      onInputRef.current(data);
      if (trackingRef.current) requestAnimationFrame(recomputeGhost);
    },
    [recomputeGhost]
  );
  /** Stable ref so the once-bound xterm onData listener calls the latest handler. */
  const handleInputDataRef = useRef(handleInputData);
  handleInputDataRef.current = handleInputData;

  // ── Create xterm as soon as host exists, then keep fitting as layout settles ──
  // The previous strict "wait until client size >2 before new Terminal" could fail
  // on first mount in the IDE bottom dock because the flex height allocation for
  // the new TerminalView children happens in a later paint cycle than the effect.
  // Switching tabs caused a remount after layout had stabilized → "magic fix".
  //
  // New approach:
  // - Create + open the Terminal immediately when the host div is mounted.
  // - Give it a default size first so the renderer is initialized in a sane state.
  // - Write any existing buffer.
  // - Then rely on:
  //   • immediate + repeated scheduleFits (rAF + timeouts)
  //   • ResizeObserver that calls fit on any size change
  //   • fit after every buffer update
  //   • the `visible` effect that forces fits when the tab becomes active
  // This ensures that as soon as the parent (dock footer, flex-col, chips, etc.)
  // gives the host real dimensions, fit() will be called and the content appears.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let search: SearchAddon | null = null;
    const disposers: Array<() => void> = [];

    const scheduleFits = () => {
      const doOne = () => {
        fitAndRepaint();
      };
      doOne();
      const r1 = requestAnimationFrame(doOne);
      const t1 = setTimeout(doOne, 0);
      const t2 = setTimeout(doOne, 16);
      const t3 = setTimeout(doOne, 50);
      const t4 = setTimeout(doOne, 120);
      const t5 = setTimeout(doOne, 300);
      disposers.push(
        () => cancelAnimationFrame(r1),
        () => clearTimeout(t1),
        () => clearTimeout(t2),
        () => clearTimeout(t3),
        () => clearTimeout(t4),
        () => clearTimeout(t5)
      );
    };

    try {
      term = new Terminal({
        fontFamily: 'Consolas, "Cascadia Mono", "Cascadia Code", Menlo, "DejaVu Sans Mono", "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.0,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: 'bar',
        scrollback: 5000,
        allowProposedApi: true,
        theme: buildXtermTheme(),
      });
      fit = new FitAddon();
      search = new SearchAddon();
      term.loadAddon(fit);
      term.loadAddon(search);
      term.loadAddon(new WebLinksAddon());

      term.open(host);

      // Seed with a reasonable size so the internal buffers/canvas are initialized.
      // Subsequent fits will correct to the real container size. The first fit may
      // run before the IDE dock has a real height, so do not fail initialization on it.
      term.resize(80, 24);
      try {
        fit.fit();
      } catch {
        /* The scheduled fits below will retry after layout settles. */
      }

    } catch (error) {
      console.error('[TerminalView] xterm init failed:', error);
      setInitError(error instanceof Error ? error.message : String(error));
      return;
    }

    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // Write whatever we have right now
    writtenLenRef.current = 0;
    const initialBuffer = bufferRef.current;
    if (initialBuffer.length > 0) {
      writeWithMarkers(term, initialBuffer);
    }
    writtenLenRef.current = initialBuffer.length;
    term.focus();
    setBooted((n) => n + 1);

    // Extra fits after initial write
    scheduleFits();

    const resultsSub = search!.onDidChangeResults((result) => {
      if (!result || result.resultCount === 0) {
        setMatchInfo(result ? { current: 0, total: 0 } : null);
      } else {
        setMatchInfo({ current: result.resultIndex + 1, total: result.resultCount });
      }
    });

    const fileLinks = registerFileLinks(term, (p: string, line?: number, col?: number) =>
      onOpenPathRef.current?.(p, line, col)
    );
    const dataSub = term.onData((data) => handleInputDataRef.current(data));
    const resizeSub = term.onResize(({ cols, rows }) => onResizeRef.current?.(cols, rows));
    const scrollSub = term.onScroll(() => setGhost(null));

    // Observe the host for any size changes (dock resize, tab switch, outer layout, etc.)
    // and fit aggressively.
    let didFirstRealFit = false;
    const doFit = (): void => {
      const node = hostRef.current;
      if (!node || node.clientWidth < 1 || node.clientHeight < 1) return;
      try {
        fit?.fit();
        const tt = termRef.current;
        if (tt) tt.refresh(0, tt.rows);

        // First time we see real size after creation: re-feed the full buffer.
        // This fixes cases where initial writes happened while the terminal had 0 rows.
        if (!didFirstRealFit && bufferRef.current.length > 0) {
          didFirstRealFit = true;
          const t = termRef.current;
          if (t) {
            t.reset();
            writeWithMarkers(t, bufferRef.current);
            writtenLenRef.current = bufferRef.current.length;
            // one more fit after rewrite
            requestAnimationFrame(() => {
              try {
                fitAndRepaint();
              } catch {}
            });
          }
        }
      } catch {
        /* */
      }
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(host);

    // Also try fitting a few more times shortly after mount (belt and suspenders)
    const mountTimeouts: any[] = [];
    mountTimeouts.push(setTimeout(doFit, 0));
    mountTimeouts.push(setTimeout(doFit, 30));
    mountTimeouts.push(setTimeout(doFit, 100));

    disposers.push(
      () => ro.disconnect(),
      () => resultsSub.dispose(),
      () => fileLinks.dispose(),
      () => dataSub.dispose(),
      () => resizeSub.dispose(),
      () => scrollSub.dispose(),
      ...mountTimeouts.map((t) => () => clearTimeout(t))
    );

    return () => {
      for (const d of disposers) {
        try {
          d();
        } catch {}
      }
      for (const d of decorationsRef.current) d.dispose();
      decorationsRef.current = [];
      pendingCmdRef.current = null;
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
      writtenLenRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Reset xterm when the bound session changes (switch tabs / new pane) ───
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    clearDecorations();
    const currentBuffer = bufferRef.current;
    if (currentBuffer.length > 0) writeWithMarkers(term, currentBuffer);
    writtenLenRef.current = currentBuffer.length;
    requestAnimationFrame(fitAndRepaint);
    const t1 = setTimeout(fitAndRepaint, 16);
    const t2 = setTimeout(fitAndRepaint, 80);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [session?.id, clearDecorations, fitAndRepaint, writeWithMarkers]);

  // ── Stream `buffer` into xterm as deltas (append), or repaint on shrink ───
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const shown = writtenLenRef.current;
    if (buffer.length === shown) return;

    if (buffer.length > shown && buffer.startsWith(buffer.slice(0, shown))) {
      writeWithMarkers(term, buffer.slice(shown));
    } else {
      term.reset();
      clearDecorations();
      if (buffer.length > 0) writeWithMarkers(term, buffer);
    }
    writtenLenRef.current = buffer.length;

    // After we push content (especially the very first payload or after a tab switch remount),
    // force a fit + refresh. This is the "switch to output and back" that used to unblock rendering.
    // Doing it here guarantees the viewport knows its real rows after data is present.
    requestAnimationFrame(fitAndRepaint);
  }, [buffer, booted, writeWithMarkers, clearDecorations, fitAndRepaint]);

  // ── Keep the xterm theme in sync with the app's light/dark scheme ─────────
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const apply = (): void => {
      const term = termRef.current;
      if (term) term.options.theme = buildXtermTheme();
    };
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    let mq: MediaQueryList | null = null;
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
    }
    return () => {
      mo.disconnect();
      mq?.removeEventListener('change', apply);
    };
  }, []);

  // Focus the terminal when it becomes runnable so typing goes straight in.
  useEffect(() => {
    if (isRunning) termRef.current?.focus();
  }, [isRunning, session?.id]);

  // When the view becomes the active visible pane (IDE terminal tab selected,
  // or the settings sessions tab), force fits. This catches cases where the
  // terminal instance was created while its flex ancestor still had transient 0 height.
  // When using display toggle (instead of unmount), becoming visible again triggers
  // this and we re-feed the buffer + refresh to guarantee the content appears.
  useEffect(() => {
    if (!visible) return;
    fitAndRepaint();
    const r1 = requestAnimationFrame(fitAndRepaint);
    const t1 = setTimeout(fitAndRepaint, 16);
    const t2 = setTimeout(fitAndRepaint, 80);

    // When becoming visible, re-feed full buffer to be sure (in case previous
    // writes were done while hidden or 0-size).
    const t = termRef.current;
    if (t && bufferRef.current.length > 0) {
      // Use a microtask + raf to let the display:flex take effect first
      requestAnimationFrame(() => {
        try {
          t.reset();
          writeWithMarkers(t, bufferRef.current);
          writtenLenRef.current = bufferRef.current.length;
          fitAndRepaint();
        } catch {}
      });
    }

    return () => {
      cancelAnimationFrame(r1);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [visible, session?.id, fitAndRepaint, writeWithMarkers]);

  useEffect(() => {
    if (!buffer || mirrorText.trim().length === 0) {
      setMirrorVisible(false);
      return;
    }
    const updateMirrorVisibility = (): void => {
      const rowsText = hostRef.current?.querySelector('.xterm-rows')?.textContent ?? '';
      setMirrorVisible(rowsText.trim().length === 0);
    };
    const raf = requestAnimationFrame(updateMirrorVisibility);
    const timeout = setTimeout(updateMirrorVisibility, 120);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timeout);
    };
  }, [buffer, booted, mirrorText, session?.id]);

  // Focus the search box when the search bar opens.
  useEffect(() => {
    if (searchOpen) setTimeout(() => searchInputRef.current?.focus(), 50);
  }, [searchOpen]);

  const runSearch = useCallback((term: string, dir: 1 | -1): void => {
    const addon = searchRef.current;
    if (!addon || !term) return;
    if (dir === 1) addon.findNext(term);
    else addon.findPrevious(term);
  }, []);

  /** Rerun the command behind a decoration: type it into the pty + submit. */
  const rerunCommand = useCallback((commandLine: string): void => {
    if (commandLine) onInputRef.current(`${commandLine}\r`);
    setCmdMenu(null);
  }, []);

  /** Copy a command line to the clipboard. */
  const copyCommand = useCallback(
    (commandLine: string): void => {
      void navigator.clipboard.writeText(commandLine).then(
        () => Message.success(t('ide.terminal.commandCopied')),
        () => Message.error(t('ide.terminal.commandCopyFailed'))
      );
      setCmdMenu(null);
    },
    [t]
  );

  const copyStaleAcceptCommand = useCallback((): void => {
    if (!staleNotice) return;
    void navigator.clipboard.writeText(staleNotice.acceptCommand).then(
      () => Message.success(t('terminal.view.mtuiConflictCopied')),
      () => Message.error(t('ide.terminal.commandCopyFailed'))
    );
  }, [staleNotice, t]);

  // Dismiss the command-action menu on any outside click / Escape.
  useEffect(() => {
    if (!cmdMenu) return;
    const close = (): void => setCmdMenu(null);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCmdMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [cmdMenu]);

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
      {/* Header: title + cwd + status + toolbar */}
      <div className='flex items-center justify-between gap-8px px-12px h-36px shrink-0 b-b-1 b-b-solid border-b-1 bg-fill-2'>
        <div className='flex items-center gap-8px min-w-0'>
          <TerminalIcon theme='outline' size='14' className='text-t-secondary shrink-0' />
          <span className='text-13px font-600 text-t-primary truncate'>{session.title}</span>
          <span className='text-11px text-t-tertiary truncate'>{session.cwd}</span>
        </div>
        <div className='flex items-center gap-4px shrink-0'>
          <span className='text-11px text-t-tertiary'>
            {isRunning
              ? t('terminal.view.running', { pid: session.pid ?? '—' })
              : t('terminal.view.exitedWithCode', { code: session.exitCode ?? '—' })}
          </span>
          <Tooltip content={t('terminal.view.search')} mini>
            <Button
              type='text'
              size='mini'
              icon={<Search theme='outline' size={13} />}
              className={`!text-t-secondary ${searchOpen ? '!text-primary !bg-primary-light-1' : ''}`}
              onClick={() => setSearchOpen((v) => !v)}
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

      {/* Search bar — find with match count (N/M) */}
      {searchOpen ? (
        <div className='shrink-0 flex items-center gap-8px px-12px py-6px b-b-1 b-b-solid border-b-1 bg-fill-2'>
          <Search theme='outline' size={13} className='text-t-tertiary shrink-0' />
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              runSearch(e.target.value, 1);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchOpen(false);
                setSearchTerm('');
              }
              if (e.key === 'Enter') runSearch(searchTerm, e.shiftKey ? -1 : 1);
            }}
            placeholder={t('ide.terminal.searchPlaceholder')}
            className='flex-1 min-w-0 bg-transparent border-none outline-none text-12px text-t-primary font-mono placeholder:text-t-tertiary'
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
            }}
          />
        </div>
      ) : null}

      {/* xterm.js mount point. The emulator owns everything below this node. */}
      <div className='relative flex-1 min-h-0 min-w-0 overflow-hidden'>
        {mirrorVisible ? (
          <pre
            aria-hidden
            className='absolute inset-0 z-0 m-0 overflow-hidden px-8px py-6px whitespace-pre-wrap break-words text-t-primary font-mono text-13px leading-13px'
          >
            {mirrorText}
          </pre>
        ) : null}
        <div ref={hostRef} className='terminal-xterm-host relative z-10 h-full w-full px-8px py-6px' />
      </div>

      {/* docTerminal ghost-text: faded completion anchored at the cursor + Tab hint. */}
      {ghost ? (
        <span
          aria-hidden
          className='pointer-events-none absolute z-10 flex items-center whitespace-pre text-t-tertiary opacity-55 font-mono'
          style={{
            left: ghost.left,
            top: ghost.top,
            height: ghost.height,
            lineHeight: `${ghost.height}px`,
            fontSize: 13,
          }}
        >
          {ghost.tail}
          <span
            className='ml-8px px-5px rd-4px bg-fill-3 text-t-tertiary opacity-90'
            style={{ fontSize: 10, lineHeight: '16px' }}
          >
            Tab
          </span>
        </span>
      ) : null}

      {/* Smart Fix: a failed command's deprecated program → its replacement. */}
      {pendingRemap ? (
        <div className='absolute left-12px right-12px bottom-12px z-30 rd-8px bg-popup b-1 b-solid border-b-1 shadow-md p-10px flex flex-col gap-8px'>
          <div className='flex items-start justify-between gap-12px'>
            <div className='min-w-0 flex flex-col gap-2px'>
              <span className='text-12px font-600 text-danger'>
                {t('smartTerminal.smartFix.errorLine', { command: pendingRemap.from, code: pendingRemap.exitCode })}
              </span>
              <span className='text-12px text-t-primary'>
                <span className='font-mono'>{pendingRemap.from}</span> {t('smartTerminal.smartFix.updatedTo')}{' '}
                <span className='font-mono font-600'>{pendingRemap.to}</span>
                {pendingRemap.updateUrl ? (
                  <Button
                    type='text'
                    size='mini'
                    className='!px-4px !h-auto align-baseline'
                    onClick={() => pendingRemap.updateUrl && window.open(pendingRemap.updateUrl, '_blank', 'noopener')}
                  >
                    {t('smartTerminal.smartFix.updateLink')}
                  </Button>
                ) : null}
              </span>
            </div>
            <div className='shrink-0 flex items-center gap-6px'>
              <Tooltip content={pendingRemap.replacementCommand} mini>
                <Button
                  size='mini'
                  type='primary'
                  disabled={!isRunning}
                  icon={<PlayOne theme='outline' size={12} />}
                  onClick={() => {
                    onInput(`${pendingRemap.replacementCommand}\r`);
                    onDismissRemap?.();
                  }}
                >
                  {t('smartTerminal.smartFix.run', { program: pendingRemap.to })}
                </Button>
              </Tooltip>
              <Button
                size='mini'
                type='text'
                icon={<Close theme='outline' size={12} />}
                onClick={() => onDismissRemap?.()}
              >
                {t('smartTerminal.smartFix.dismiss')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

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

      {/* If xterm failed to initialize, surface a notice instead of a blank pane. */}
      {initError ? (
        <div className='absolute inset-0 flex-center flex-col gap-8px bg-fill-1 text-center px-16px'>
          <span className='size-40px flex-center rd-full bg-fill-2 text-danger'>
            <TerminalIcon theme='outline' size={20} />
          </span>
          <p className='m-0 max-w-360px text-12px text-t-secondary'>{t('terminal.view.initError')}</p>
          <p className='m-0 max-w-360px text-11px text-t-tertiary font-mono break-all'>{initError}</p>
        </div>
      ) : null}

      {/* Floating command actions (rerun / copy) anchored to a clicked gutter dot. */}
      {cmdMenu ? (
        <div
          role='menu'
          className='fixed z-1000 min-w-160px max-w-360px rd-8px bg-popup b-1 b-solid border-b-1 shadow-md py-4px'
          style={{ left: cmdMenu.x, top: cmdMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className='px-10px py-4px text-11px text-t-tertiary font-mono truncate' title={cmdMenu.commandLine}>
            {cmdMenu.commandLine}
          </div>
          <Button
            type='text'
            size='small'
            disabled={!isRunning}
            onClick={() => rerunCommand(cmdMenu.commandLine)}
            className='!w-full !justify-start !px-10px !h-28px !text-12px'
          >
            <PlayOne theme='outline' size={13} className='text-success' />
            {t('ide.terminal.rerunCommand')}
          </Button>
          <Button
            type='text'
            size='small'
            onClick={() => copyCommand(cmdMenu.commandLine)}
            className='!w-full !justify-start !px-10px !h-28px !text-12px'
          >
            <Copy theme='outline' size={13} className='text-t-secondary' />
            {t('ide.terminal.copyCommand')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

export default TerminalView;
