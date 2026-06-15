/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure Req↔Task↔Test traceability analyzer.
 *
 * Reads tasks.md for requirement references (`(Req: R1, R2)` or
 * `_Requirements: R1, R2_`) and verification.md for requirement mentions, then
 * builds a coverage matrix: which requirements are covered by a task, which are
 * verified, which tasks reference no requirement (orphans), and which
 * requirements have no task at all.
 *
 * No I/O — callers pass file text in and get analysis out.
 */

import type { CoverageRow, Requirement, SpecDiagnostic, TraceabilityAnalysis, TraceTask } from './earsTypes';

const TASK_LINE = /^(\s*)[-*]\s+\[([ xX~!/-])\]\s+(.+?)\s*$/;
/** Find requirement refs: `(Req: R1, R2)`, `_Requirements: R1_`, `[R1,R2]`. */
const REQ_REF_BLOCK = /(?:\(?\s*req(?:uirements?)?\s*[:#]\s*([^)\]_\n]+)\)?)|(?:_requirements?\s*:\s*([^_\n]+)_)/gi;
const REQ_ID_TOKEN = /\bR(?:EQ)?-?\d+\b/gi;

const statusFromMarker = (marker: string): TraceTask['status'] => {
  if (marker === 'x' || marker === 'X') return 'done';
  if (marker === '~') return 'in_progress';
  if (marker === '!' || marker === '/') return 'blocked';
  if (marker === '-') return 'deferred';
  return 'pending';
};

const normalizeReqId = (token: string): string =>
  token
    .toUpperCase()
    .replace(/^REQ-?/, 'R')
    .replace(/-/g, '');

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

/** Extract requirement ids referenced by a single task title. */
export const extractReqRefs = (title: string): string[] => {
  const refs = new Set<string>();
  let blockMatch: RegExpExecArray | null;
  REQ_REF_BLOCK.lastIndex = 0;
  while ((blockMatch = REQ_REF_BLOCK.exec(title)) !== null) {
    const body = blockMatch[1] ?? blockMatch[2] ?? '';
    const tokens = body.match(REQ_ID_TOKEN);
    if (tokens) {
      for (const token of tokens) refs.add(normalizeReqId(token));
    }
  }
  return [...refs];
};

/** Parse tasks.md into traceable tasks (with requirement references). */
export const parseTraceTasks = (tasksMarkdown: string): TraceTask[] => {
  const lines = tasksMarkdown.split(/\r?\n/);
  const tasks: TraceTask[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(TASK_LINE);
    if (!m) continue;
    const line = i + 1;
    const title = m[3].trim();
    tasks.push({
      id: taskIdFor(line, title),
      title,
      line,
      status: statusFromMarker(m[2]),
      reqRefs: extractReqRefs(title),
    });
  }
  return tasks;
};

/** Collect requirement ids mentioned anywhere in verification.md. */
export const extractVerifiedReqIds = (verificationMarkdown: string): Set<string> => {
  const ids = new Set<string>();
  const tokens = verificationMarkdown.match(REQ_ID_TOKEN);
  if (tokens) {
    for (const token of tokens) ids.add(normalizeReqId(token));
  }
  return ids;
};

/**
 * Build the full traceability analysis from parsed requirements, tasks.md text
 * and verification.md text.
 */
export const analyzeTraceability = (
  requirements: readonly Requirement[],
  tasksMarkdown: string,
  verificationMarkdown: string
): TraceabilityAnalysis => {
  const tasks = parseTraceTasks(tasksMarkdown);
  const verifiedIds = extractVerifiedReqIds(verificationMarkdown);
  const reqIds = new Set(requirements.map((r) => r.id));

  const rows: CoverageRow[] = requirements.map((req) => {
    const referencing = tasks.filter((task) => task.reqRefs.includes(req.id));
    return {
      reqId: req.id,
      reqTitle: req.title,
      taskIds: referencing.map((task) => task.id),
      hasDoneTask: referencing.some((task) => task.status === 'done'),
      verified: verifiedIds.has(req.id),
    };
  });

  const uncoveredReqIds = rows.filter((row) => row.taskIds.length === 0).map((row) => row.reqId);
  // Orphan = a task that references requirement ids, but none exist; or a task
  // that should reference a requirement but references none. We only flag tasks
  // that reference *unknown* requirement ids, plus implementation-looking tasks
  // with zero refs (heuristic: not a planning/checkpoint line).
  const orphanTaskIds: string[] = [];
  const diagnostics: SpecDiagnostic[] = [];
  for (const task of tasks) {
    const unknownRefs = task.reqRefs.filter((ref) => !reqIds.has(ref));
    if (unknownRefs.length > 0) {
      diagnostics.push({
        severity: 'error',
        code: 'task.unknownReq',
        message: `Task references unknown requirement(s) ${unknownRefs.join(', ')}: "${task.title}".`,
        line: task.line,
      });
      orphanTaskIds.push(task.id);
    }
  }

  for (const reqId of uncoveredReqIds) {
    diagnostics.push({
      severity: 'warning',
      code: 'requirement.uncovered',
      message: `Requirement "${reqId}" is not referenced by any task.`,
      refId: reqId,
    });
  }

  const coveredRequirements = rows.filter((row) => row.taskIds.length > 0).length;
  const verifiedRequirements = rows.filter((row) => row.verified).length;

  return {
    rows,
    uncoveredReqIds,
    orphanTaskIds,
    diagnostics,
    counts: {
      requirements: requirements.length,
      coveredRequirements,
      verifiedRequirements,
      orphanTasks: orphanTaskIds.length,
    },
  };
};
