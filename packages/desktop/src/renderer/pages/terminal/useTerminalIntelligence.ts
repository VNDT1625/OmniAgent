/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal intelligence hook — powers ghost-text suggestions (docTerminal) and
 * Smart Fix for the in-app terminal.
 *
 * Performance is the priority: the learned-command snapshot is pulled ONCE and
 * kept in a ref, so `ghostFor` (called on every keystroke) is a pure in-memory
 * computation with zero IPC. Captures are fire-and-forget and update the local
 * snapshot optimistically so suggestions improve immediately. The Smart Fix
 * remap is consulted only when a command fails (a rare event).
 *
 * The pure scoring/classification helpers imported from `@process/.../commandDoc`
 * have no Node dependencies, so they bundle safely into the renderer.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { bestGhost } from '@process/terminal/commandDoc/commandScore';
import { classifyCommand, replaceProgram } from '@process/terminal/commandDoc/commandClassify';
import type { CommandRecord } from '@process/terminal/commandDoc/commandTypes';
import { captureCommand, fetchCommandSnapshot, resolveRemap } from './commandDocClient';

/** A pending Smart Fix suggestion for a failed command. */
export type PendingRemap = {
  /** The command that just failed. */
  failedCommand: string;
  /** The non-zero exit code. */
  exitCode: number;
  /** The deprecated program. */
  from: string;
  /** The replacement program. */
  to: string;
  /** Optional update/migration link. */
  updateUrl?: string;
  /** The full command rebuilt with the replacement program. */
  replacementCommand: string;
};

/** Public surface of the hook. */
export type TerminalIntelligence = {
  /** Ghost-text tail (text AFTER the typed line) for the current input, or null. */
  ghostFor: (line: string) => string | null;
  /** Call when a command finishes (from shell-integration command-end). */
  onCommandFinished: (commandLine: string, exitCode: number, cwd?: string) => void;
  /** The current Smart Fix suggestion, if any. */
  pendingRemap: PendingRemap | null;
  /** Dismiss the current Smart Fix suggestion. */
  dismissRemap: () => void;
};

/** Merge a capture into the in-memory snapshot (optimistic, mirrors the service). */
const mergeCapture = (records: CommandRecord[], command: string, exitCode: number, cwd?: string): CommandRecord[] => {
  const now = Date.now();
  const idx = records.findIndex((r) => r.command === command);
  const success = exitCode === 0;
  if (idx >= 0) {
    const next = records.slice();
    const r = next[idx];
    next[idx] = {
      ...r,
      count: r.count + 1,
      successCount: r.successCount + (success ? 1 : 0),
      lastUsedAt: now,
      lastExitCode: exitCode,
      cwd: cwd ?? r.cwd,
    };
    return next;
  }
  return [
    ...records,
    {
      command,
      program: classifyCommand(command).program,
      cwd,
      count: 1,
      successCount: success ? 1 : 0,
      firstUsedAt: now,
      lastUsedAt: now,
      lastExitCode: exitCode,
    },
  ];
};

/** Trivial commands we never learn (mirrors the service's filter). */
const isWorthy = (command: string): boolean => {
  const c = command.trim();
  return c.length >= 2 && !/^(cd|ls|dir|cls|clear|pwd|exit)$/i.test(c);
};

/** Drive ghost-text + Smart Fix for the terminal. */
export const useTerminalIntelligence = (): TerminalIntelligence => {
  const recordsRef = useRef<CommandRecord[]>([]);
  const [pendingRemap, setPendingRemap] = useState<PendingRemap | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCommandSnapshot().then((records) => {
      if (!cancelled) recordsRef.current = records;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const ghostFor = useCallback((line: string): string | null => {
    if (line.trim().length === 0) return null;
    const suggestion = bestGhost(recordsRef.current, { prefix: line, now: Date.now() });
    if (!suggestion) return null;
    const tail = suggestion.command.slice(line.length);
    return tail.length > 0 ? tail : null;
  }, []);

  const onCommandFinished = useCallback((commandLine: string, exitCode: number, cwd?: string): void => {
    const command = commandLine.trim();
    if (isWorthy(command)) {
      captureCommand({ command, exitCode, cwd });
      recordsRef.current = mergeCapture(recordsRef.current, command, exitCode, cwd);
    }
    if (exitCode !== 0 && command.length > 0) {
      const program = classifyCommand(command).program;
      void resolveRemap(program).then((remap) => {
        if (remap) {
          setPendingRemap({
            failedCommand: command,
            exitCode,
            from: remap.from,
            to: remap.to,
            updateUrl: remap.updateUrl,
            replacementCommand: replaceProgram(command, remap.to),
          });
        }
      });
    }
  }, []);

  const dismissRemap = useCallback((): void => setPendingRemap(null), []);

  return { ghostFor, onCommandFinished, pendingRemap, dismissRemap };
};
