/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { terminalClient } from '@/renderer/pages/terminal/terminalBridgeClient';

export type VerificationResult = {
  passed: boolean;
  /** Captured terminal output (truncated tail). */
  output: string;
  /** Process exit code, or null when killed / unknown. */
  exitCode: number | null;
};

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 4000;

const isWindows = (): boolean => {
  try {
    return typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);
  } catch {
    return false;
  }
};

/** Build a one-shot shell + args that runs `command` then exits with its code. */
const oneShotShell = (): { shell: string; argsFor: (command: string) => string[] } =>
  isWindows() ? { shell: 'cmd.exe', argsFor: (c) => ['/d', '/s', '/c', c] } : { shell: '/bin/sh', argsFor: (c) => ['-c', c] };

const tail = (text: string, max: number): string => (text.length > max ? `…\n${text.slice(text.length - max)}` : text);

/**
 * Run an independent verification command in `workspacePath` and resolve once it
 * exits. Used by Goal Mode to gate a "done" claim on a real exit code 0 — the
 * renderer does NOT trust the agent's self-reported test status.
 *
 * Best-effort: if the terminal bridge is unavailable, resolves as not-passed so
 * the caller can decide (it never throws).
 */
export const runWorkspaceVerification = async (workspacePath: string, command: string, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<VerificationResult> => {
  if (!workspacePath || !command.trim()) {
    return { passed: false, output: '(missing workspace or command)', exitCode: null };
  }

  const { shell, argsFor } = oneShotShell();

  let sessionId: string | null = null;
  try {
    const created = await terminalClient.create({ options: { cwd: workspacePath, shell, args: argsFor(command), noShellIntegration: true } });
    if (!created.ok || !created.data?.id) {
      return { passed: false, output: '(could not start verification terminal)', exitCode: null };
    }
    sessionId = created.data.id;
  } catch {
    return { passed: false, output: '(terminal bridge unavailable)', exitCode: null };
  }

  const id = sessionId;
  const exitCode = await new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(code);
    };
    const unsubscribe = terminalClient.onExit((event) => {
      if (event.id === id) finish(event.exitCode);
    });
    const timer = setTimeout(() => {
      void terminalClient.kill({ id }).catch(() => {});
      finish(null); // timed out → treat as failure
    }, timeoutMs);
  });

  let output = '';
  try {
    const scrollback = await terminalClient.scrollback({ id });
    if (scrollback.ok && typeof scrollback.data === 'string') output = tail(scrollback.data, MAX_OUTPUT_CHARS);
  } catch {
    // ignore — output is best-effort
  }
  void terminalClient.remove({ id }).catch(() => {});

  return { passed: exitCode === 0, output, exitCode };
};
