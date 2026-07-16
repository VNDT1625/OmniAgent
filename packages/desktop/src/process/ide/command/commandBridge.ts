/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE Command IPC bridge — the renderer-facing surface of the guarded shell
 * runner behind the `ide_command` agent tool ({@link runCommand}).
 *
 * ## Why this exists
 *
 * The agent's `ide_command` tool runs in the Main process (MCP server). But
 * Strict IDE Mode's renderer-side auto-router also needs to run a shell command
 * itself — when it intercepts a denied native `Bash` call it re-runs the same
 * command through {@link runCommand} and injects the real result back into the
 * chat. The renderer cannot spawn a child process (no Node), so it round-trips
 * through this channel.
 *
 * Channel (always-resolving envelope so a renderer await never hangs):
 *  - `ide.run-command` — run one shell command under the guard rails (timeout,
 *    output cap, prompts disabled) and return the captured {@link CommandResult}.
 *
 * The global bootstrap calls {@link registerIdeCommandBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { runCommand, type CommandResult } from './commandRunner';

/** IPC channel names for the IDE command surface (renderer-safe contract). */
export const IDE_COMMAND_CHANNELS = {
  runCommand: 'ide.run-command',
} as const;

/** Always-resolving result envelope. */
export type IdeCommandResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Request for {@link IDE_COMMAND_CHANNELS.runCommand}. */
export type RunCommandRequest = {
  /** Absolute repo root; the default cwd. */
  rootPath: string;
  /** The command line to run (a string; pipes / && / globs allowed). */
  command: string;
  /** Working directory for THIS run (defaults to rootPath). */
  cwd?: string;
  /** Hard timeout before the process is killed (ms). */
  timeoutMs?: number;
};

/** Typed channels. Exported for bootstrap registration wiring. */
export const ideCommandChannels = {
  runCommand: bridge.buildProvider<IdeCommandResult<CommandResult>, RunCommandRequest>(IDE_COMMAND_CHANNELS.runCommand),
};

/**
 * Register the IDE command IPC handler. Idempotent. Intended to be called once
 * during Main-process bootstrap.
 */
export function registerIdeCommandBridge(): void {
  ideCommandChannels.runCommand.provider(async (req): Promise<IdeCommandResult<CommandResult>> => {
    try {
      const root = req.rootPath?.trim();
      if (!root) return { ok: false, error: 'A workspace root is required.' };
      const result = await runCommand(req.command, root, { cwd: req.cwd, timeoutMs: req.timeoutMs });
      return { ok: true, data: result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
