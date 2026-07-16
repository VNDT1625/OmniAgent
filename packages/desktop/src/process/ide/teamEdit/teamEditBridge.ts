/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent Team Edit IPC bridge — the renderer-facing surface of the per-workspace
 * {@link getTeamEditService}.
 *
 * The IDE "Team" panel shows WHO (agents + the user) is working on the open
 * folder and WHICH files each one currently holds (an advisory lease), plus a
 * live activity feed. The same service backs the agent-facing MCP tools
 * (`team_*` on `aionui-ide`), so an agent claiming a file and the panel showing
 * that claim hit ONE source of truth.
 *
 * Channels (always-resolving envelopes so a renderer await never hangs):
 *  - `ide.team-snapshot` — point-in-time view (participants + leases + activity).
 *  - `ide.team-join`     — register/refresh the human user as a participant.
 *  - `ide.team-claim`    — claim/renew a lease (used by the panel's manual grab).
 *  - `ide.team-release`  — drop a lease the user holds.
 *  - `ide.team-reset`    — drop the whole workspace session (folder closed).
 *  - `ide.team-changed`  — emitter: pushes a fresh snapshot on every change.
 *
 * The global bootstrap calls {@link registerTeamEditBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import {
  getTeamEditService,
  setTeamEditChangeListener,
  type FileLease,
  type GuardedEditResult,
  type GuardedWriteResult,
  type TeamEditSnapshot,
} from './teamEditService';

/** IPC channel names for the team-edit surface (renderer-safe contract). */
export const TEAM_EDIT_CHANNELS = {
  snapshot: 'ide.team-snapshot',
  join: 'ide.team-join',
  claim: 'ide.team-claim',
  release: 'ide.team-release',
  reset: 'ide.team-reset',
  changed: 'ide.team-changed',
  write: 'ide.team-write',
  edit: 'ide.team-edit',
} as const;

/** Always-resolving result envelope. */
export type TeamEditResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Request carrying just the workspace root. */
export type TeamRootRequest = { rootPath: string };

/** Request to register the human user as a participant. */
export type TeamJoinRequest = { rootPath: string; agentId: string; label: string; isUser?: boolean };

/** Request to claim / renew a lease from the UI. */
export type TeamClaimRequest = { rootPath: string; agentId: string; relPath: string; intent?: string };

/** Request to release a lease from the UI. */
export type TeamReleaseRequest = { rootPath: string; agentId: string; relPath: string };

/** Request to write a file through the guarded team-edit service. */
export type TeamWriteRequest = { rootPath: string; agentId: string; relPath: string; data: string };

/** Request to replace exact text through the guarded team-edit service. */
export type TeamEditRequest = { rootPath: string; agentId: string; relPath: string; oldText: string; newText: string };

/** Claim result shape returned to the renderer. */
export type TeamClaimResult =
  | { ok: true; lease: FileLease; renewed: boolean }
  | { ok: false; reason: 'held'; lease: FileLease };

/** Envelope wrapping a snapshot for the `changed` emitter (avoids union collapse). */
export type TeamChangedEnvelope = { snapshot: TeamEditSnapshot };

/** Typed channels. Exported for bootstrap registration wiring. */
export const teamEditChannels = {
  snapshot: bridge.buildProvider<TeamEditResult<TeamEditSnapshot>, TeamRootRequest>(TEAM_EDIT_CHANNELS.snapshot),
  join: bridge.buildProvider<TeamEditResult<boolean>, TeamJoinRequest>(TEAM_EDIT_CHANNELS.join),
  claim: bridge.buildProvider<TeamEditResult<TeamClaimResult>, TeamClaimRequest>(TEAM_EDIT_CHANNELS.claim),
  release: bridge.buildProvider<TeamEditResult<boolean>, TeamReleaseRequest>(TEAM_EDIT_CHANNELS.release),
  reset: bridge.buildProvider<TeamEditResult<boolean>, TeamRootRequest>(TEAM_EDIT_CHANNELS.reset),
  changed: bridge.buildEmitter<TeamChangedEnvelope>(TEAM_EDIT_CHANNELS.changed),
  write: bridge.buildProvider<TeamEditResult<GuardedWriteResult>, TeamWriteRequest>(TEAM_EDIT_CHANNELS.write),
  edit: bridge.buildProvider<TeamEditResult<GuardedEditResult>, TeamEditRequest>(TEAM_EDIT_CHANNELS.edit),
};

/**
 * Register the team-edit IPC handlers. Idempotent. Intended to be called once
 * during Main-process bootstrap. Wires the service's change listener to the
 * `changed` emitter so the renderer gets a live snapshot on every mutation.
 */
export function registerTeamEditBridge(): void {
  // Push every service-side change out to the renderer as a fresh snapshot.
  setTeamEditChangeListener((snapshot) => teamEditChannels.changed.emit({ snapshot }));
  const service = getTeamEditService();

  teamEditChannels.snapshot.provider(async (req): Promise<TeamEditResult<TeamEditSnapshot>> => {
    try {
      return { ok: true, data: service.snapshot(req.rootPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamEditChannels.join.provider(async (req): Promise<TeamEditResult<boolean>> => {
    try {
      service.join(req.rootPath, req.agentId, req.label, req.isUser);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamEditChannels.claim.provider(async (req): Promise<TeamEditResult<TeamClaimResult>> => {
    try {
      return { ok: true, data: service.claim(req.rootPath, req.agentId, req.relPath, req.intent) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamEditChannels.release.provider(async (req): Promise<TeamEditResult<boolean>> => {
    try {
      return { ok: true, data: service.release(req.rootPath, req.agentId, req.relPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamEditChannels.reset.provider(async (req): Promise<TeamEditResult<boolean>> => {
    try {
      service.reset(req.rootPath);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamEditChannels.write.provider(async (req): Promise<TeamEditResult<GuardedWriteResult>> => {
    try {
      return { ok: true, data: await service.write(req.rootPath, req.agentId, req.relPath, req.data) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  teamEditChannels.edit.provider(async (req): Promise<TeamEditResult<GuardedEditResult>> => {
    try {
      return {
        ok: true,
        data: await service.editReplace(req.rootPath, req.agentId, req.relPath, req.oldText, req.newText),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
