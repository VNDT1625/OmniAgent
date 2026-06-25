/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure phase-gate + Definition-of-Done analyzer.
 *
 * Parses tasks.md into phases (`## Phase N — ...`) and computes whether each
 * phase's gate is open (all tasks done; checkpoint task done if declared). The
 * first phase whose gate is not open is the "active" phase — work should not
 * advance past it. Also detects whether the spec declares a Definition of Done.
 *
 * No I/O — callers pass file text in and get analysis out.
 */

import type { SpecDiagnostic, SpecPhase, PhaseGateAnalysis } from './earsTypes';

const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const TASK_LINE = /^(\s*)[-*]\s+\[([ xX~!/-])\]\s+(.+?)\s*$/;
const PHASE_HEADING = /^phase\b/i;
const CHECKPOINT = /\bcheckpoint\b/i;
const DOD = /\bdefinition of done\b/i;

const statusFromMarker = (marker: string): 'pending' | 'in_progress' | 'done' | 'blocked' | 'deferred' => {
  if (marker === 'x' || marker === 'X') return 'done';
  if (marker === '~') return 'in_progress';
  if (marker === '!' || marker === '/') return 'blocked';
  if (marker === '-') return 'deferred';
  return 'pending';
};

const taskIdFor = (line: number, title: string): string => {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return `t${String(line).padStart(3, '0')}${slug ? `-${slug}` : ''}`;
};

/**
 * Analyze phases and gates from tasks.md. `definitionOfDoneText` is any extra
 * doc (e.g. the head of tasks.md or a steering file) searched for a DoD section.
 */
export const analyzePhaseGates = (tasksMarkdown: string, definitionOfDoneText = ''): PhaseGateAnalysis => {
  const lines = tasksMarkdown.split(/\r?\n/);
  const phases: SpecPhase[] = [];
  let current: SpecPhase | null = null;
  let phaseSeq = 0;

  const hasDefinitionOfDone = DOD.test(tasksMarkdown) || DOD.test(definitionOfDoneText);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const heading = raw.match(HEADING);
    if (heading && PHASE_HEADING.test(heading[2].trim())) {
      phaseSeq += 1;
      current = {
        index: phaseSeq,
        title: heading[2].trim(),
        line: i + 1,
        taskIds: [],
        counts: { total: 0, done: 0, blocked: 0 },
        hasCheckpoint: false,
        gateOpen: false,
      };
      phases.push(current);
      continue;
    }
    // A non-phase heading at level <= 2 ends the current phase scope.
    if (heading && heading[1].length <= 2 && !PHASE_HEADING.test(heading[2].trim())) {
      current = null;
      continue;
    }
    const taskMatch = raw.match(TASK_LINE);
    if (taskMatch && current) {
      const title = taskMatch[3].trim();
      const status = statusFromMarker(taskMatch[2]);
      current.taskIds.push(taskIdFor(i + 1, title));
      current.counts.total += 1;
      if (status === 'done') current.counts.done += 1;
      if (status === 'blocked') current.counts.blocked += 1;
      if (CHECKPOINT.test(title)) {
        current.hasCheckpoint = true;
        // Checkpoint not done keeps the gate closed regardless of other tasks.
        if (status !== 'done') {
          current.gateOpen = false;
        }
      }
    }
  }

  // Compute gate openness: every task done, and (if a checkpoint exists) it is
  // counted within done. A phase with zero tasks has an open gate (nothing to do).
  for (const phase of phases) {
    phase.gateOpen = phase.counts.total === 0 || phase.counts.done === phase.counts.total;
  }

  const activePhase = phases.find((phase) => !phase.gateOpen) ?? null;
  const diagnostics: SpecDiagnostic[] = [];

  if (!hasDefinitionOfDone) {
    diagnostics.push({
      severity: 'warning',
      code: 'spec.noDefinitionOfDone',
      message: 'No Definition of Done section found. Add measurable completion criteria.',
    });
  }

  // Flag phases that have tasks but no checkpoint (weaker gate discipline).
  for (const phase of phases) {
    if (phase.counts.total > 0 && !phase.hasCheckpoint) {
      diagnostics.push({
        severity: 'info',
        code: 'phase.noCheckpoint',
        message: `Phase "${phase.title}" has no CHECKPOINT task to gate it.`,
        line: phase.line,
      });
    }
  }

  return {
    phases,
    hasDefinitionOfDone,
    activePhaseIndex: activePhase?.index ?? null,
    diagnostics,
  };
};
