/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC bridge exposing the docTerminal command service to the renderer.
 *
 * The renderer ranks ghost-text suggestions LOCALLY (the scorer in
 * `commandScore.ts` is renderer-safe), so this surface is intentionally thin:
 *  - `terminal.cmd-snapshot` — fetch all learned records once (the renderer
 *    caches + ranks them; no IPC per keystroke).
 *  - `terminal.cmd-capture`  — record a command the renderer observed finishing
 *    (via shell-integration `command-end`); fire-and-forget.
 *
 * Every request handler ALWAYS resolves a `{ ok }` envelope (mirrors
 * `terminalBridge`). The global bootstrap calls {@link registerCommandDocBridge}
 * once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type { CommandRecord } from './commandTypes';
import { getCommandDocService } from './commandDocWiring';
import type { CaptureInput, ICommandDocService } from './commandDocService';

/** Channel names for the docTerminal surface (renderer-safe contract). */
export const COMMAND_DOC_CHANNELS = {
  snapshot: 'terminal.cmd-snapshot',
  capture: 'terminal.cmd-capture',
} as const;

/** Always-resolve envelope (mirrors `TerminalResult`). */
export type CommandDocResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Typed docTerminal channels. Exported for the renderer client + bootstrap. */
export const commandDocChannels = {
  snapshot: bridge.buildProvider<CommandDocResult<CommandRecord[]>, void>(COMMAND_DOC_CHANNELS.snapshot),
  capture: bridge.buildProvider<CommandDocResult<boolean>, CaptureInput>(COMMAND_DOC_CHANNELS.capture),
};

/**
 * Register the docTerminal IPC handlers.
 *
 * @param resolveService Injectable service accessor (defaults to the singleton).
 */
export function registerCommandDocBridge(
  resolveService: () => Promise<ICommandDocService> = getCommandDocService
): void {
  commandDocChannels.snapshot.provider(async (): Promise<CommandDocResult<CommandRecord[]>> => {
    try {
      return { ok: true, data: (await resolveService()).snapshot() };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  commandDocChannels.capture.provider(async (req): Promise<CommandDocResult<boolean>> => {
    try {
      const command = typeof req?.command === 'string' ? req.command : '';
      if (command.trim().length === 0) return { ok: true, data: false };
      (await resolveService()).capture({
        command,
        exitCode: typeof req?.exitCode === 'number' ? req.exitCode : 0,
        cwd: typeof req?.cwd === 'string' ? req.cwd : undefined,
      });
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
