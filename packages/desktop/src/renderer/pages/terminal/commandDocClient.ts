/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for docTerminal + Smart Fix.
 *
 * Rebuilds the `bridge.buildProvider(...)` invokers from the channel-name strings
 * (the Main-process bridge modules pull in Node, so they must not be imported at
 * runtime). Only **types** are borrowed via `import type`.
 *
 * Hot path note: the renderer pulls the command snapshot ONCE and computes
 * ghost-text locally; `capture` is fire-and-forget; `remap` is consulted only on
 * a command failure. No per-keystroke IPC.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type { CommandRecord } from '@process/terminal/commandDoc/commandTypes';
import type { CaptureInput } from '@process/terminal/commandDoc/commandDocService';
import type { CommandDocResult } from '@process/terminal/commandDoc/commandDocBridge';
import type { Remap, SmartFixResult } from '@process/terminal/smartFix/smartFixBridge';

const COMMAND_DOC_CHANNELS = {
  snapshot: 'terminal.cmd-snapshot',
  capture: 'terminal.cmd-capture',
} as const;

const SMART_FIX_CHANNELS = {
  remap: 'terminal.cmd-remap',
} as const;

const providers = {
  snapshot: bridge.buildProvider<CommandDocResult<CommandRecord[]>, void>(COMMAND_DOC_CHANNELS.snapshot),
  capture: bridge.buildProvider<CommandDocResult<boolean>, CaptureInput>(COMMAND_DOC_CHANNELS.capture),
  remap: bridge.buildProvider<SmartFixResult<Remap | null>, { program: string }>(SMART_FIX_CHANNELS.remap),
};

/** Race a bridge call against a timeout so an unwired bridge never hangs the UI. */
const withTimeout = async <T>(promise: Promise<T>, fallback: T, ms = 6000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Load the learned-command snapshot (once, on terminal mount). */
export const fetchCommandSnapshot = (): Promise<CommandRecord[]> =>
  withTimeout(
    providers.snapshot.invoke().then((r): CommandRecord[] => (r.ok ? r.data : [])),
    []
  ).catch((): CommandRecord[] => []);

/** Record a finished command (fire-and-forget; failures are swallowed). */
export const captureCommand = (input: CaptureInput): void => {
  void providers.capture.invoke(input).catch(() => {});
};

/** Resolve a deprecated program to its replacement (consulted on failure only). */
export const resolveRemap = (program: string): Promise<Remap | null> =>
  withTimeout(
    providers.remap.invoke({ program }).then((r): Remap | null => (r.ok ? r.data : null)),
    null
  ).catch((): Remap | null => null);
