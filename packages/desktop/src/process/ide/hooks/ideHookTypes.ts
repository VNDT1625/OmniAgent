/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Types for the IDE Agent Hooks feature — workspace automations that react to
 * IDE events (a file saved/created/deleted, or a manual trigger) by either
 * asking the IDE Chat agent a prompt or running a shell command.
 *
 * This mirrors the idea of Kiro's own agent hooks but lives INSIDE AionUi's
 * Studio › IDE, scoped per workspace folder. Definitions are persisted as JSON
 * so they survive restarts.
 *
 * Process boundary: shared type module — safe to import from both Main and
 * renderer (no Node/DOM APIs here).
 */

/** What IDE event triggers a hook. */
export type IdeHookEvent =
  /** A code file in the workspace was saved/changed. */
  | 'fileSaved'
  /** A new file was created in the workspace. */
  | 'fileCreated'
  /** A file was deleted from the workspace. */
  | 'fileDeleted'
  /** The user pressed the hook's "Run" button (no automatic trigger). */
  | 'manual';

/** What a hook does when it fires. */
export type IdeHookActionKind =
  /** Send a prompt to the IDE Chat agent (opens/!uses the agent surface). */
  | 'askAgent'
  /** Run a shell command in the workspace terminal. */
  | 'runCommand';

/** The set of trigger events (for validation / UI enumeration). */
export const IDE_HOOK_EVENTS: readonly IdeHookEvent[] = ['fileSaved', 'fileCreated', 'fileDeleted', 'manual'];

/** The set of action kinds (for validation / UI enumeration). */
export const IDE_HOOK_ACTIONS: readonly IdeHookActionKind[] = ['askAgent', 'runCommand'];

/** Events that are automatic (driven by the file watcher) rather than manual. */
export const AUTOMATIC_IDE_HOOK_EVENTS: readonly IdeHookEvent[] = ['fileSaved', 'fileCreated', 'fileDeleted'];

/**
 * One configured IDE hook. `filePatterns` are glob-like patterns (e.g.
 * `src/**\/*.ts`, `*.tsx`) matched against the workspace-relative path of the
 * changed file; an empty list means "any file". Only meaningful for the
 * file-based events.
 */
export type IdeHook = {
  /** Stable unique id. */
  id: string;
  /** Human-readable name shown in the hooks list. */
  name: string;
  /** Optional longer description of what the hook does and why. */
  description?: string;
  /** Whether the hook is active. Disabled hooks never fire. */
  enabled: boolean;
  /** Which IDE event triggers the hook. */
  event: IdeHookEvent;
  /**
   * Glob patterns matched against the changed file's workspace-relative path.
   * Empty → match any file. Ignored for `manual`.
   */
  filePatterns: string[];
  /** What the hook does when it fires. */
  action: IdeHookActionKind;
  /** Prompt for the IDE Chat agent. Required when `action === 'askAgent'`. */
  prompt?: string;
  /** Shell command to run. Required when `action === 'runCommand'`. */
  command?: string;
  /** Creation timestamp (unix ms). */
  createdAt: number;
  /** Last-update timestamp (unix ms). */
  updatedAt: number;
  /** Last time the hook fired (unix ms), or null if never. */
  lastRunAt?: number | null;
};

/** A fired-hook descriptor handed to the renderer so it can run the action. */
export type IdeHookFireRequest = {
  /** The hook that matched. */
  hook: IdeHook;
  /** Workspace-relative path that triggered it (absent for manual). */
  relPath?: string;
  /** Absolute workspace root. */
  rootPath: string;
};
