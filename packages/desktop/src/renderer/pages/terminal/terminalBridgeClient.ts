/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Terminal IPC surface.
 *
 * The Main-process bridge module (`process/terminal/terminalBridge.ts`) pulls in
 * Electron + Node (`child_process`, `fs`), so it must NOT be imported into the
 * renderer at runtime. Mirroring `managerBridgeClient.ts`/`browserBridgeClient.ts`,
 * this module:
 *
 * - re-declares the channel-name strings (kept in sync with `TERMINAL_CHANNELS`),
 * - rebuilds matching `bridge.buildProvider(...)` / `bridge.buildEmitter(...)`
 *   from those names,
 * - wraps each request with a short timeout so an unregistered channel rejects
 *   instead of hanging (the page then shows a friendly "not ready" notice).
 *
 * Only **types** are borrowed from Main-process modules via `import type`
 * (erased at compile time, safe across the process boundary).
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  CreateTerminalRequest,
  ResizeTerminalRequest,
  SaveScheduleRequest,
  TerminalIdRequest,
  TerminalListData,
  TerminalResult,
  WriteTerminalRequest,
} from '@process/terminal/terminalBridge';
import type {
  SystemTerminalProcess,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSchedule,
  TerminalSession,
} from '@process/terminal/terminalTypes';
import type { ShellProfile } from '@process/terminal/shellProfiles';

/** Terminal IPC channel names. Mirrors `TERMINAL_CHANNELS` in the bridge. */
const TERMINAL_CHANNELS = {
  create: 'terminal.create',
  write: 'terminal.write',
  resize: 'terminal.resize',
  kill: 'terminal.kill',
  remove: 'terminal.remove',
  list: 'terminal.list',
  scrollback: 'terminal.scrollback',
  listSystem: 'terminal.list-system',
  listShells: 'terminal.list-shells',
  listSchedules: 'terminal.list-schedules',
  saveSchedule: 'terminal.save-schedule',
  removeSchedule: 'terminal.remove-schedule',
  runScheduleNow: 'terminal.run-schedule-now',
  data: 'terminal.data',
  exit: 'terminal.exit',
  sessionsChanged: 'terminal.sessions-changed',
  schedulesChanged: 'terminal.schedules-changed',
} as const;

/** How long to wait for an IPC reply before treating the bridge as not wired. */
const BRIDGE_TIMEOUT_MS = 4000;

const channels = {
  create: bridge.buildProvider<TerminalResult<TerminalSession>, CreateTerminalRequest>(TERMINAL_CHANNELS.create),
  write: bridge.buildProvider<TerminalResult<void>, WriteTerminalRequest>(TERMINAL_CHANNELS.write),
  resize: bridge.buildProvider<TerminalResult<void>, ResizeTerminalRequest>(TERMINAL_CHANNELS.resize),
  kill: bridge.buildProvider<TerminalResult<void>, TerminalIdRequest>(TERMINAL_CHANNELS.kill),
  remove: bridge.buildProvider<TerminalResult<void>, TerminalIdRequest>(TERMINAL_CHANNELS.remove),
  list: bridge.buildProvider<TerminalResult<TerminalListData>, void>(TERMINAL_CHANNELS.list),
  scrollback: bridge.buildProvider<TerminalResult<string>, TerminalIdRequest>(TERMINAL_CHANNELS.scrollback),
  listSystem: bridge.buildProvider<TerminalResult<SystemTerminalProcess[]>, void>(TERMINAL_CHANNELS.listSystem),
  listShells: bridge.buildProvider<TerminalResult<ShellProfile[]>, void>(TERMINAL_CHANNELS.listShells),
  listSchedules: bridge.buildProvider<TerminalResult<TerminalSchedule[]>, void>(TERMINAL_CHANNELS.listSchedules),
  saveSchedule: bridge.buildProvider<TerminalResult<TerminalSchedule>, SaveScheduleRequest>(
    TERMINAL_CHANNELS.saveSchedule
  ),
  removeSchedule: bridge.buildProvider<TerminalResult<TerminalSchedule[]>, TerminalIdRequest>(
    TERMINAL_CHANNELS.removeSchedule
  ),
  runScheduleNow: bridge.buildProvider<TerminalResult<void>, TerminalIdRequest>(TERMINAL_CHANNELS.runScheduleNow),
  data: bridge.buildEmitter<TerminalDataEvent>(TERMINAL_CHANNELS.data),
  exit: bridge.buildEmitter<TerminalExitEvent>(TERMINAL_CHANNELS.exit),
  sessionsChanged: bridge.buildEmitter<TerminalSession[]>(TERMINAL_CHANNELS.sessionsChanged),
  schedulesChanged: bridge.buildEmitter<TerminalSchedule[]>(TERMINAL_CHANNELS.schedulesChanged),
};

/** Error thrown when a terminal IPC call does not reply within its budget. */
export class TerminalBridgeTimeoutError extends Error {
  constructor(channel: string) {
    super(`[TerminalBridgeClient] No reply on "${channel}" — the terminal bridge may not be wired yet.`);
    this.name = 'TerminalBridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so a missing handler rejects, not hangs. */
const withTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TerminalBridgeTimeoutError(channel));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/**
 * Timeout-guarded Terminal invokers. Each request method resolves with the
 * bridge's {@link TerminalResult} envelope, or rejects on timeout so the page
 * can show a friendly "not ready" notice. The `on*` methods subscribe to the
 * Main → renderer push streams and return an unsubscribe fn.
 */
export const terminalClient = {
  create: (req: CreateTerminalRequest = {}) =>
    withTimeout(TERMINAL_CHANNELS.create, () => channels.create.invoke(req), BRIDGE_TIMEOUT_MS),
  write: (req: WriteTerminalRequest) =>
    withTimeout(TERMINAL_CHANNELS.write, () => channels.write.invoke(req), BRIDGE_TIMEOUT_MS),
  resize: (req: ResizeTerminalRequest) =>
    withTimeout(TERMINAL_CHANNELS.resize, () => channels.resize.invoke(req), BRIDGE_TIMEOUT_MS),
  kill: (req: TerminalIdRequest) =>
    withTimeout(TERMINAL_CHANNELS.kill, () => channels.kill.invoke(req), BRIDGE_TIMEOUT_MS),
  remove: (req: TerminalIdRequest) =>
    withTimeout(TERMINAL_CHANNELS.remove, () => channels.remove.invoke(req), BRIDGE_TIMEOUT_MS),
  list: () => withTimeout(TERMINAL_CHANNELS.list, () => channels.list.invoke(), BRIDGE_TIMEOUT_MS),
  scrollback: (req: TerminalIdRequest) =>
    withTimeout(TERMINAL_CHANNELS.scrollback, () => channels.scrollback.invoke(req), BRIDGE_TIMEOUT_MS),
  listSystem: () => withTimeout(TERMINAL_CHANNELS.listSystem, () => channels.listSystem.invoke(), BRIDGE_TIMEOUT_MS),
  listShells: () => withTimeout(TERMINAL_CHANNELS.listShells, () => channels.listShells.invoke(), BRIDGE_TIMEOUT_MS),
  listSchedules: () =>
    withTimeout(TERMINAL_CHANNELS.listSchedules, () => channels.listSchedules.invoke(), BRIDGE_TIMEOUT_MS),
  saveSchedule: (req: SaveScheduleRequest) =>
    withTimeout(TERMINAL_CHANNELS.saveSchedule, () => channels.saveSchedule.invoke(req), BRIDGE_TIMEOUT_MS),
  removeSchedule: (req: TerminalIdRequest) =>
    withTimeout(TERMINAL_CHANNELS.removeSchedule, () => channels.removeSchedule.invoke(req), BRIDGE_TIMEOUT_MS),
  runScheduleNow: (req: TerminalIdRequest) =>
    withTimeout(TERMINAL_CHANNELS.runScheduleNow, () => channels.runScheduleNow.invoke(req), BRIDGE_TIMEOUT_MS),
  /** Subscribe to streamed output chunks (main → renderer). Returns an unsubscribe fn. */
  onData: (listener: (event: TerminalDataEvent) => void): (() => void) => channels.data.on(listener),
  /** Subscribe to session-exit events. Returns an unsubscribe fn. */
  onExit: (listener: (event: TerminalExitEvent) => void): (() => void) => channels.exit.on(listener),
  /** Subscribe to the full session-list snapshot whenever it changes. Returns an unsubscribe fn. */
  onSessionsChanged: (listener: (sessions: TerminalSession[]) => void): (() => void) =>
    channels.sessionsChanged.on(listener),
  /** Subscribe to the full schedule-list snapshot whenever it changes. Returns an unsubscribe fn. */
  onSchedulesChanged: (listener: (schedules: TerminalSchedule[]) => void): (() => void) =>
    channels.schedulesChanged.on(listener),
};
