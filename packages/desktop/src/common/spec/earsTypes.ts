/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared, pure types for the spec-driven workflow analyzer (Kiro-grade).
 *
 * These types describe the result of analyzing a `.aionui/specs/<slug>/`
 * directory: EARS requirement validation, Req↔Task↔Test traceability, and
 * phase-gate / Definition-of-Done readiness.
 *
 * Pure module: no Node.js or DOM APIs. Safe to import from both the Main
 * process (bridge) and the renderer (UI), so the same logic powers both.
 */

/**
 * The five canonical EARS (Easy Approach to Requirements Syntax) patterns.
 * `unknown` marks a criterion that contains SHALL but matches no known shape.
 */
export type EarsPattern = 'ubiquitous' | 'event' | 'state' | 'unwanted' | 'optional' | 'unknown';

/** Severity of a spec diagnostic. */
export type SpecSeverity = 'error' | 'warning' | 'info';

/** One acceptance criterion line parsed from a requirement. */
export type AcceptanceCriterion = {
  /** 1-based line number within requirements.md. */
  line: number;
  /** Raw text of the criterion (without the list marker). */
  text: string;
  /** Detected EARS pattern. */
  pattern: EarsPattern;
  /** True when the criterion contains a normative `SHALL`/`MUST`. */
  hasShall: boolean;
};

/** One requirement block parsed from requirements.md. */
export type Requirement = {
  /** Stable id, e.g. `R1`. Derived from an explicit `R<n>` heading or sequence. */
  id: string;
  /** Human title (heading text after the id). */
  title: string;
  /** 1-based line where the requirement heading starts. */
  line: number;
  /** Optional user story ("As a ..., I want ..., so that ..."). */
  userStory: string | null;
  /** Acceptance criteria belonging to this requirement. */
  criteria: AcceptanceCriterion[];
};

/** A single diagnostic about the spec (validation finding). */
export type SpecDiagnostic = {
  severity: SpecSeverity;
  /** i18n-friendly machine code, e.g. `requirement.noCriteria`. */
  code: string;
  /** Human-readable message (already localized or English fallback). */
  message: string;
  /** Optional requirement/task id this diagnostic is attached to. */
  refId?: string;
  /** Optional 1-based source line. */
  line?: number;
};

/** Result of parsing + validating requirements.md. */
export type RequirementsAnalysis = {
  requirements: Requirement[];
  diagnostics: SpecDiagnostic[];
  counts: {
    total: number;
    withCriteria: number;
    earsCompliant: number;
  };
};

/** A task with its parsed requirement references. */
export type TraceTask = {
  /** Task id (mirrors the runbook id, here re-derived from line+title). */
  id: string;
  title: string;
  line: number;
  status: 'pending' | 'in_progress' | 'done' | 'blocked' | 'deferred';
  /** Requirement ids referenced via `(Req: R1, R2)` or `_Requirements: R1_`. */
  reqRefs: string[];
};

/** Coverage row for a single requirement. */
export type CoverageRow = {
  reqId: string;
  reqTitle: string;
  /** Task ids that reference this requirement. */
  taskIds: string[];
  /** True when at least one referencing task is done. */
  hasDoneTask: boolean;
  /** True when verification.md mentions this requirement id. */
  verified: boolean;
};

/** Result of the Req↔Task↔Test traceability analysis. */
export type TraceabilityAnalysis = {
  rows: CoverageRow[];
  /** Requirement ids with no referencing task. */
  uncoveredReqIds: string[];
  /** Task ids that reference no requirement (orphan tasks). */
  orphanTaskIds: string[];
  diagnostics: SpecDiagnostic[];
  counts: {
    requirements: number;
    coveredRequirements: number;
    verifiedRequirements: number;
    orphanTasks: number;
  };
};

/** One phase parsed from tasks.md (`## Phase N — ...`). */
export type SpecPhase = {
  /** Phase index in document order (1-based). */
  index: number;
  title: string;
  line: number;
  /** Task ids belonging to this phase. */
  taskIds: string[];
  counts: { total: number; done: number; blocked: number };
  /** True when the phase declares a CHECKPOINT task. */
  hasCheckpoint: boolean;
  /** Gate is open when all tasks done (and checkpoint done if present). */
  gateOpen: boolean;
};

/** Result of phase-gate + Definition-of-Done analysis. */
export type PhaseGateAnalysis = {
  phases: SpecPhase[];
  /** True when the spec declares a Definition of Done section. */
  hasDefinitionOfDone: boolean;
  /** Index of the first phase whose gate is not open (1-based), or null. */
  activePhaseIndex: number | null;
  diagnostics: SpecDiagnostic[];
};

/** Top-level spec analysis combining all three dimensions. */
export type SpecAnalysis = {
  slug: string;
  requirements: RequirementsAnalysis;
  traceability: TraceabilityAnalysis;
  phaseGates: PhaseGateAnalysis;
  /** Overall readiness score 0..100 (weighted health of the spec). */
  score: number;
  /** Roll-up of the most important diagnostics across dimensions. */
  diagnostics: SpecDiagnostic[];
};
