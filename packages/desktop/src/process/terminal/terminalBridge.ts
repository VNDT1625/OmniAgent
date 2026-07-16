/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Terminal IPC bridge — exposes the Main-process Terminal manager + scheduler to
 * the renderer (Settings › Terminal page, and later the IDE terminal panel).
 *
 * This is an Electron-native bridge (not an aioncore HTTP route), built with the
 * same `@office-ai/platform` `bridge` helper that backs `ipcBridge.ts`. Because
 * `ipcBridge.ts` carries no `terminal` namespace and this feature must not
 * modify it, the typed channels are declared **here** and exported so the
 * renderer (via `terminalBridgeClient.ts`) and the global bootstrap can reach
 * them. The channel-name constants ({@link TERMINAL_CHANNELS}) are the
 * renderer-safe contract — the renderer rebuilds matching invokers from those
 * names without importing this Node-only module.
 *
 * ## Always-resolve envelope
 *
 * The platform bridge only forwards a provider's **resolved** value — a thrown
 * error is swallowed and the renderer's `invoke()` never settles (infinite
 * spinner). So every request handler is wrapped to ALWAYS resolve a
 * {@link TerminalResult}: `{ ok: true, data }` on success, `{ ok: false, error }`
 * on failure. The streaming `data`/`exit`/`sessions-changed`/`schedules-changed`
 * emitters are fire-and-forget (Main → renderer push).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type { ITerminalManager } from './terminalManager';
import type { ITerminalScheduler } from './terminalScheduler';
import type { ITerminalScheduleStore } from './terminalScheduleStore';
import { listSystemTerminals } from './systemProcesses';
import { discoverShellProfiles, type ShellProfile } from './shellProfiles';
import { commandFromTerminalInput, isDirectWriteCommand } from './mtuiPolicy';
import type {
  CreateTerminalOptions,
  SystemTerminalProcess,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalSchedule,
  TerminalSession,
} from './terminalTypes';

// ---------------------------------------------------------------------------
// Channel names (renderer-safe contract)
// ---------------------------------------------------------------------------

/** IPC channel names for the terminal surface. Safe to mirror in the renderer. */
export const TERMINAL_CHANNELS = {
  // Session lifecycle + I/O
  create: 'terminal.create',
  write: 'terminal.write',
  resize: 'terminal.resize',
  kill: 'terminal.kill',
  remove: 'terminal.remove',
  list: 'terminal.list',
  scrollback: 'terminal.scrollback',
  // System (read-only) discovery
  listSystem: 'terminal.list-system',
  // Shell profiles (pickable shells)
  listShells: 'terminal.list-shells',
  // Schedules (Phase 2)
  listSchedules: 'terminal.list-schedules',
  saveSchedule: 'terminal.save-schedule',
  removeSchedule: 'terminal.remove-schedule',
  runScheduleNow: 'terminal.run-schedule-now',
  // Emitters (Main → renderer push)
  data: 'terminal.data',
  exit: 'terminal.exit',
  sessionsChanged: 'terminal.sessions-changed',
  schedulesChanged: 'terminal.schedules-changed',
} as const;

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export type CreateTerminalRequest = { options?: CreateTerminalOptions };
export type WriteTerminalRequest = { id: string; data: string };
export type ResizeTerminalRequest = { id: string; cols: number; rows: number };
export type TerminalIdRequest = { id: string };
/** A snapshot of all sessions plus the running count (single round-trip). */
export type TerminalListData = { sessions: TerminalSession[]; runningCount: number };
/** Save (create or update) a schedule. Mirrors {@link ITerminalScheduleStore.save}. */
export type SaveScheduleRequest = { schedule: Partial<TerminalSchedule> & { name: string; script: string } };

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/** Every terminal request channel resolves with this envelope (never rejects on a handled failure). */
export type TerminalResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Typed terminal IPC channels. Exported for the bootstrap registration wiring. */
export const terminalChannels = {
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Services the terminal bridge operates on. */
export type TerminalBridgeServices = {
  manager: ITerminalManager;
  scheduler: ITerminalScheduler;
  store: ITerminalScheduleStore;
};

/** Options for {@link registerTerminalBridge}. */
export type RegisterTerminalBridgeOptions = { services: TerminalBridgeServices };

let unsubscribers: Array<() => void> = [];

/**
 * Register the terminal IPC handlers and wire the live push streams.
 *
 * Idempotent: a repeated call re-registers the providers and replaces the prior
 * subscriptions. Intended to be invoked once during Main-process bootstrap.
 */
export function registerTerminalBridge(options: RegisterTerminalBridgeOptions): void {
  const { manager, scheduler, store } = options.services;

  /** Wrap a handler so it ALWAYS resolves a {@link TerminalResult}. */
  const safe =
    <Req, Res>(label: string, handler: (req: Req) => Promise<Res> | Res) =>
    async (req: Req): Promise<TerminalResult<Res>> => {
      try {
        return { ok: true, data: await handler(req) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[TerminalBridge] ${label} failed:`, error);
        return { ok: false, error: message };
      }
    };

  // --- Session lifecycle + I/O -------------------------------------------
  terminalChannels.create.provider(safe('create', ({ options: opts }: CreateTerminalRequest) => manager.create(opts)));
  terminalChannels.write.provider(
    safe('write', ({ id, data }: WriteTerminalRequest) => {
      const command = commandFromTerminalInput(data);
      if (command && isDirectWriteCommand(command)) {
        terminalChannels.data.emit({
          id,
          data: `\r\n[Strict MTUI Mode] Blocked direct file-write command: ${command}\r\nUse mtui --json for file changes.\r\n`,
        });
        return;
      }
      manager.write(id, data);
    })
  );
  terminalChannels.resize.provider(
    safe('resize', ({ id, cols, rows }: ResizeTerminalRequest) => {
      manager.resize(id, cols, rows);
    })
  );
  terminalChannels.kill.provider(
    safe('kill', ({ id }: TerminalIdRequest) => {
      manager.kill(id);
    })
  );
  terminalChannels.remove.provider(
    safe('remove', ({ id }: TerminalIdRequest) => {
      manager.remove(id);
    })
  );
  terminalChannels.list.provider(
    safe('list', (): TerminalListData => ({ sessions: manager.list(), runningCount: manager.runningCount() }))
  );
  terminalChannels.scrollback.provider(safe('scrollback', ({ id }: TerminalIdRequest) => manager.getScrollback(id)));

  // --- System (read-only) discovery --------------------------------------
  terminalChannels.listSystem.provider(safe('listSystem', () => listSystemTerminals()));

  // --- Shell profiles (pickable shells) ----------------------------------
  terminalChannels.listShells.provider(safe('listShells', () => discoverShellProfiles()));

  // --- Schedules ----------------------------------------------------------
  terminalChannels.listSchedules.provider(safe('listSchedules', () => store.list()));
  terminalChannels.saveSchedule.provider(
    safe('saveSchedule', async ({ schedule }: SaveScheduleRequest) => {
      const saved = await store.save(schedule);
      await scheduler.reload();
      return saved;
    })
  );
  terminalChannels.removeSchedule.provider(
    safe('removeSchedule', async ({ id }: TerminalIdRequest) => {
      const next = await store.remove(id);
      await scheduler.reload();
      return next;
    })
  );
  terminalChannels.runScheduleNow.provider(safe('runScheduleNow', ({ id }: TerminalIdRequest) => scheduler.runNow(id)));

  // --- Live push streams --------------------------------------------------
  for (const off of unsubscribers) off();
  unsubscribers = [
    manager.on('data', (event) => terminalChannels.data.emit(event)),
    manager.on('exit', (event) => terminalChannels.exit.emit(event)),
    manager.on('sessions-changed', (sessions) => terminalChannels.sessionsChanged.emit(sessions)),
    store.onChange((schedules) => terminalChannels.schedulesChanged.emit(schedules)),
  ];
}

/** Detach the live push subscriptions (deterministic teardown for tests/hot-reload). */
export function disposeTerminalBridge(): void {
  for (const off of unsubscribers) off();
  unsubscribers = [];
}
