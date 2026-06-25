/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the monitor & auto-fix layer (Yêu cầu 6). Kept in one module
 * so `bugMonitor`, `reportStore`, `rootCauseAnalyzer`, `patchSandbox` and
 * `patchGate` reuse the same shapes without circular imports.
 *
 * Process boundary: Main-process (Node.js) types only — no DOM, no runtime.
 */

/** Where a bug report came from. */
export type BugSource = 'sentry' | 'logs' | 'user';

/**
 * A captured bug report (criteria 6.1 / 6.2): logs + the actions leading up to
 * it + the situation, plus a `signature` used to deduplicate similar errors
 * (criterion 6.9).
 */
export type BugReport = {
  /** Unique id of the report. */
  id: string;
  /** Where the report originated. */
  source: BugSource;
  /** Stable signature for grouping similar errors (e.g. normalised stack head). */
  signature: string;
  /** Short human-readable title. */
  title: string;
  /** The error message. */
  message: string;
  /** Stack trace, when available. */
  stack?: string;
  /** Recent user actions / breadcrumbs leading up to the error. */
  breadcrumbs: string[];
  /** Free-text situation / user description (for user-filed reports). */
  description?: string;
  /** How many times an error with this signature has been seen. */
  occurrences: number;
  /** Unix-ms timestamp of first sighting. */
  firstSeen: number;
  /** Unix-ms timestamp of most recent sighting. */
  lastSeen: number;
  /** Id of an accepted fix recorded for this signature, when one exists (criterion 6.9). */
  knownFixId?: string;
};

/** A proposed fix for a bug, produced by the root-cause analyzer (criterion 6.3). */
export type PatchProposal = {
  /** Unique id of the proposal. */
  id: string;
  /** The report this proposal addresses. */
  reportId: string;
  /** The signature it targets (so a known fix can be recalled by signature). */
  signature: string;
  /** The analyzed root cause, in plain language. */
  rootCause: string;
  /** Human-readable explanation of the fix (criterion 6.3). */
  explanation: string;
  /** A unified diff / patch text to apply to a copy of the app. */
  diff: string;
  /** Risk classification used by the patch gate (criterion 6.6). */
  risk: 'low' | 'medium' | 'high';
  /** Unix-ms timestamp the proposal was created. */
  createdAt: number;
};

/** Result of trying a patch in the isolated sandbox (criteria 6.4 / 6.5). */
export type SandboxResult = {
  /** The proposal that was tried. */
  proposalId: string;
  /** Whether the hidden Windows test run passed on the patched copy. */
  passed: boolean;
  /** Path of the test report produced by the 2b testing layer, if any. */
  reportPath?: string;
  /** Failure detail when `passed` is false. */
  detail?: string;
};

/** State of a patch as it moves through the gate (criteria 6.5 / 6.6 / 6.7). */
export type PatchGateStatus = 'pending-review' | 'approved' | 'applied' | 'rejected' | 'rolled-back';
