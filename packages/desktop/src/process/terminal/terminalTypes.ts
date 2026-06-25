/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the in-app Terminal manager (Settings › Terminal + the IDE
 * terminal panel). These are renderer-safe: they describe sessions, schedules,
 * and the streamed I/O events, and are imported with `import type` across the
 * process boundary (erased at compile time) so the renderer never loads the
 * Node-only manager/backend modules.
 *
 * Process boundary note: this file declares TYPES only (no Node APIs), so it is
 * safe to import from both Main and Renderer.
 */

/** Lifecycle status of a managed terminal session. */
export type TerminalStatus = 'running' | 'exited';

/**
 * A live, app-managed terminal session. The actual OS child process lives in the
 * Main process; the renderer only ever sees this metadata snapshot.
 */
export type TerminalSession = {
  /** Stable session id (uuid). */
  id: string;
  /** Human label (defaults to the shell name + index). */
  title: string;
  /** Absolute path of the resolved shell executable (e.g. `cmd.exe`, `bash`). */
  shell: string;
  /** Working directory the session was started in. */
  cwd: string;
  /** Current lifecycle status. */
  status: TerminalStatus;
  /** Epoch ms the session was created. */
  createdAt: number;
  /** Epoch ms the session exited, or null while running. */
  exitedAt: number | null;
  /** Process exit code once exited, or null. */
  exitCode: number | null;
  /** OS process id of the shell, or null if not yet known / already gone. */
  pid: number | null;
  /** True when this session was spawned to run a schedule (not user-created). */
  scheduled: boolean;
};

/** Options accepted when creating a session. All optional → sensible defaults. */
export type CreateTerminalOptions = {
  /** Override the shell executable. Defaults to the per-OS user shell. */
  shell?: string;
  /** Explicit argv for the shell (used by shell profiles). Defaults per shell. */
  args?: string[];
  /** Working directory. Defaults to the user's home directory. */
  cwd?: string;
  /** Custom title. Defaults to the shell base name. */
  title?: string;
  /** Initial column count (best-effort; child_process backend ignores it). */
  cols?: number;
  /** Initial row count (best-effort). */
  rows?: number;
  /** Extra environment variables merged over `process.env`. */
  env?: Record<string, string>;
  /** Internal: marks a session spawned by the scheduler. */
  scheduled?: boolean;
  /**
   * Disable VS Code-style shell integration (OSC 633 command decorations) for
   * this session. Defaults to off (integration on). Scheduled runs set this so
   * scripts see a pristine prompt.
   */
  noShellIntegration?: boolean;
};

/** A chunk of output streamed from a session (stdout + stderr are merged). */
export type TerminalDataEvent = {
  /** Source session id. */
  id: string;
  /** Raw output chunk (may contain ANSI escape sequences). */
  data: string;
};

/** Emitted once when a session's underlying process exits. */
export type TerminalExitEvent = {
  /** Source session id. */
  id: string;
  /** Process exit code, or null if killed by signal. */
  exitCode: number | null;
  /** Epoch ms the exit was observed. */
  exitedAt: number;
};

/**
 * A read-only snapshot of an OS shell/terminal-like process discovered on the
 * machine (Phase 1 "how many terminals are running" view). These are NOT
 * interactive — the app cannot read their output or send them input; it only
 * counts and lists them.
 */
export type SystemTerminalProcess = {
  /** OS process id. */
  pid: number;
  /** Process image/command name (e.g. `pwsh.exe`, `bash`, `wt.exe`). */
  name: string;
};

/** How often a schedule repeats. */
export type TerminalScheduleKind = 'cron' | 'once';

/**
 * A saved terminal schedule: a script to run in a shell on a cron expression (or
 * once at a fixed time). The classic use case is "open 9router at boot / every
 * morning" without babysitting a terminal.
 */
export type TerminalSchedule = {
  /** Stable schedule id (uuid). */
  id: string;
  /** Human label. */
  name: string;
  /** Shell to run the script in. Defaults to the per-OS user shell when blank. */
  shell?: string;
  /** Working directory for the spawned session. Defaults to home. */
  cwd?: string;
  /** The script body — one or more lines written to the shell's stdin. */
  script: string;
  /** Repeat kind. */
  kind: TerminalScheduleKind;
  /** Cron expression (when `kind === 'cron'`), e.g. `0 9 * * *`. */
  cron?: string;
  /** Absolute epoch ms to fire at (when `kind === 'once'`). */
  at?: number;
  /** IANA timezone the cron expression is anchored to. */
  tz?: string;
  /** Whether the schedule is armed. Paused schedules never fire. */
  enabled: boolean;
  /** Epoch ms of the last fire, or null. */
  lastRunAt: number | null;
  /** Outcome of the last fire ('ok' | 'error'), or null. */
  lastStatus: 'ok' | 'error' | null;
  /** Error message from the last fire, or null. */
  lastError: string | null;
  /** Epoch ms created. */
  createdAt: number;
  /** Epoch ms last edited. */
  updatedAt: number;
};
