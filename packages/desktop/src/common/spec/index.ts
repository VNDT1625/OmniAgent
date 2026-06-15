/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Spec-driven workflow analyzer — pure, shared barrel.
 *
 * Combines EARS requirements validation, Req↔Task↔Test traceability, and
 * phase-gate / Definition-of-Done analysis into a single {@link SpecAnalysis}
 * with a 0..100 readiness score. Used by the Main-process bridge and the
 * renderer UI alike (no I/O here).
 */

import { analyzeRequirements } from './earsRequirements';
import { analyzeTraceability } from './traceability';
import { analyzePhaseGates } from './phaseGates';
import type { SpecAnalysis, SpecDiagnostic } from './earsTypes';

export * from './earsTypes';
export { analyzeRequirements, classifyEars, parseRequirements, validateRequirements } from './earsRequirements';
export { analyzeTraceability, extractReqRefs, extractVerifiedReqIds, parseTraceTasks } from './traceability';
export { analyzePhaseGates } from './phaseGates';

/** Inputs for a full spec analysis (raw file contents). */
export type SpecAnalysisInput = {
  slug: string;
  requirementsMarkdown: string;
  tasksMarkdown: string;
  verificationMarkdown: string;
};

/** Weight constants for the readiness score (sum = 100). */
const WEIGHTS = {
  requirementsCompliance: 35,
  coverage: 35,
  verification: 15,
  phaseDiscipline: 15,
} as const;

const ratio = (numerator: number, denominator: number): number =>
  denominator <= 0 ? 1 : Math.min(1, Math.max(0, numerator / denominator));

/**
 * Compute a 0..100 readiness score: how disciplined the spec is. A spec with no
 * requirements scores 0; a fully EARS-compliant, fully covered, fully verified
 * spec with checkpoints and a Definition of Done scores 100.
 */
export const computeSpecScore = (analysis: Omit<SpecAnalysis, 'score'>): number => {
  const reqTotal = analysis.requirements.counts.total;
  if (reqTotal === 0) return 0;
  const compliance = ratio(analysis.requirements.counts.earsCompliant, reqTotal);
  const coverage = ratio(analysis.traceability.counts.coveredRequirements, reqTotal);
  const verification = ratio(analysis.traceability.counts.verifiedRequirements, reqTotal);
  const phasesWithTasks = analysis.phaseGates.phases.filter((p) => p.counts.total > 0);
  const checkpointed = phasesWithTasks.filter((p) => p.hasCheckpoint).length;
  const phaseDiscipline =
    (analysis.phaseGates.hasDefinitionOfDone ? 0.5 : 0) +
    0.5 * (phasesWithTasks.length === 0 ? 1 : ratio(checkpointed, phasesWithTasks.length));
  const score =
    WEIGHTS.requirementsCompliance * compliance +
    WEIGHTS.coverage * coverage +
    WEIGHTS.verification * verification +
    WEIGHTS.phaseDiscipline * phaseDiscipline;
  return Math.round(score);
};

/** Run the full, pure spec analysis. */
export const analyzeSpec = (input: SpecAnalysisInput): SpecAnalysis => {
  const requirements = analyzeRequirements(input.requirementsMarkdown);
  const traceability = analyzeTraceability(requirements.requirements, input.tasksMarkdown, input.verificationMarkdown);
  const phaseGates = analyzePhaseGates(input.tasksMarkdown, input.tasksMarkdown);
  const partial: Omit<SpecAnalysis, 'score'> = {
    slug: input.slug,
    requirements,
    traceability,
    phaseGates,
    diagnostics: [],
  };
  const diagnostics: SpecDiagnostic[] = [
    ...requirements.diagnostics,
    ...traceability.diagnostics,
    ...phaseGates.diagnostics,
  ];
  // Surface errors first, then warnings, then info.
  const order: Record<SpecDiagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };
  diagnostics.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    ...partial,
    diagnostics,
    score: computeSpecScore(partial),
  };
};
