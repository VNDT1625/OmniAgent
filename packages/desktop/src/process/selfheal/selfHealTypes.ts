/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the self-heal layer — the deterministic "Tier 0" companion to
 * the AI-backed monitor (`process/monitor`).
 *
 * Tier 0 handles errors that have a KNOWN, rule-based root cause and a KNOWN fix
 * that needs no model: a missing npm dependency, an icon imported under a name
 * the icon library does not export, a locale file/key missing versus the base
 * language, a lazy route whose module file does not exist. Each detector returns
 * a {@link SelfHealFinding} carrying both the diagnosis and a concrete,
 * machine-applicable {@link SelfHealFix}.
 *
 * Anything a rule cannot diagnose deterministically is left for Tier 1 (the
 * model-backed `rootCauseAnalyzer`); see {@link SelfHealTier}.
 *
 * Process boundary: Main-process (Node.js) types only — no DOM, no runtime.
 */

/** Which healing tier a finding belongs to. */
export type SelfHealTier =
  /** Deterministic, rule-based — fixable without a model. */
  | 'tier0'
  /** Needs model reasoning over the codebase — handed to the monitor analyzer. */
  | 'tier1';

/** The category of a Tier-0 detector. */
export type SelfHealRuleId =
  | 'missing-dependency'
  | 'invalid-icon-import'
  | 'missing-locale-file'
  | 'missing-locale-key'
  | 'missing-route-module';

/** Severity of a finding — drives whether boot should warn or just log. */
export type SelfHealSeverity = 'info' | 'warning' | 'critical';

/**
 * A concrete, machine-applicable fix for a Tier-0 finding. The `kind` selects an
 * executor in the applier; every variant is reversible or idempotent.
 */
export type SelfHealFix =
  /** Install a missing npm package (pinned). Executor runs the package manager. */
  | { kind: 'install-package'; packageName: string }
  /**
   * Replace an identifier in a source file (e.g. an invalid icon name → the
   * nearest valid export). Both `from`/`to` are bare identifiers; the applier
   * rewrites import specifiers + usages within the single file.
   */
  | { kind: 'rename-identifier'; filePath: string; from: string; to: string }
  /** Create a locale file by copying the base-language file as a fallback. */
  | { kind: 'copy-locale-file'; fromPath: string; toPath: string }
  /** No automatic fix is safe; record the diagnosis for a human / Tier 1. */
  | { kind: 'manual'; hint: string };

/**
 * A single diagnosed problem plus its fix. Pure data — the scanner produces
 * these; an applier (Main process) executes the `fix` when allowed.
 */
export type SelfHealFinding = {
  /** Detector that produced this finding. */
  ruleId: SelfHealRuleId;
  /** Healing tier. Tier-0 findings always carry a non-`manual` fix when fixable. */
  tier: SelfHealTier;
  /** Severity for boot-time reporting. */
  severity: SelfHealSeverity;
  /** Stable key for dedup (e.g. `invalid-icon:GitBranch:path`). */
  signature: string;
  /** Human-readable summary (English; UI localises around it). */
  summary: string;
  /** Absolute or repo-relative file the finding concerns, when applicable. */
  filePath?: string;
  /** The concrete fix. */
  fix: SelfHealFix;
};

/** Outcome of applying a single fix. */
export type SelfHealFixResult = {
  /** The finding that was acted on. */
  signature: string;
  /** Whether the fix was applied successfully. */
  applied: boolean;
  /** Detail when not applied (or the action taken when applied). */
  detail?: string;
};
