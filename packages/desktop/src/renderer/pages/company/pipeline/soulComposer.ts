/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Soul composer — turns a role node into the **soul/workflow** prompt that
 * drives it (spec `agent-company-pipeline`, Requirement 1).
 *
 * The core idea (per the user): the workflow is NOT hardcoded in engine code.
 * Each role acts according to its *soul* — a generic, role-type workflow
 * template, specialised with the role's AI-designed `responsibilities`, its
 * **direct children** (so it knows who it may delegate to), and the company
 * rules. The recursive engine simply feeds this soul to the model and lets it
 * decide how to act (delegate vs execute vs request approval/test). Different
 * companies therefore behave differently purely through their structure +
 * responsibilities + rules — no per-company code branches.
 *
 * Composing at runtime (rather than persisting a frozen soul) means editing a
 * role's `responsibilities` or the company `rules` in the UI changes the next
 * run automatically (Requirement 1.4), with no extra storage round-trip.
 *
 * Process boundary: Renderer module, PURE (no I/O). Only `import type` from
 * Main-process modules (erased at compile time).
 */

import type { CompanyStructure, RoleNode } from '@process/company/companyOrchestrator';

/** A direct report descriptor surfaced to a role's soul. */
export type DirectReport = {
  /** Child role node id (the only valid delegation target). */
  id: string;
  /** Child display name. */
  name: string;
  /** Child role kind. */
  role: RoleNode['role'];
  /** What the child is responsible for. */
  responsibilities?: string;
};

/** Inputs for {@link composeSoul}. */
export type ComposeSoulInput = {
  /** Company display name. */
  companyName: string;
  /** The role whose soul is being composed. */
  node: RoleNode;
  /** The role's direct children (delegation targets). */
  directReports: DirectReport[];
  /** Company-wide rules every role must follow. */
  rules: string[];
};

/** Human label for a role kind. */
const roleLabel = (role: RoleNode['role']): string => {
  switch (role) {
    case 'president':
      return 'President';
    case 'division-head':
      return 'Division head';
    default:
      return 'Worker';
  }
};

/**
 * The generic, role-type workflow for each kind of role. These are NOT specific
 * to any one company — the specifics come from `responsibilities`, the direct
 * reports list, and the rules. (Requirement 1.5.)
 */
const workflowFor = (role: RoleNode['role'], hasReports: boolean): string[] => {
  if (role === 'president') {
    return [
      'WORKFLOW — MANDATORY. This is a binding company process. Follow every step, in order. You must NOT deviate, skip steps, or act outside your role:',
      '- You receive the overall goal from the user.',
      "- You MUST break it into clear directives, ONE per direct report, matched to each report's responsibilities. EVERY direct report must receive a directive.",
      '- You MUST delegate the hands-on work to your direct reports — you lead, you do not execute the work yourself.',
      '- For major milestones (e.g. an architecture/design document), you MUST require the producing role to submit it for your approval before the work fans out.',
      '- When your reports return their results, review them, request a final approval if needed, then produce the final summary for the user.',
    ];
  }
  if (role === 'division-head' || (role === 'worker' && hasReports)) {
    return [
      'WORKFLOW — MANDATORY. This is a binding company process. Follow every step, in order. You must NOT deviate, skip steps, or act outside your role:',
      '- You receive a directive from your superior.',
      '- You MUST delegate the work to your direct reports — ONE task per direct report listed below — never skip levels, never do their hands-on work yourself.',
      '- Give each report a precise sub-task matched to their responsibilities.',
      '- When work needs verification, you MUST request a test run and only accept passing results.',
      "- Aggregate your reports' results and report a single consolidated result back up to your superior.",
    ];
  }
  return [
    'WORKFLOW — MANDATORY. This is a binding company process. Follow every step, in order. You must NOT deviate or act outside your role:',
    '- You receive a concrete task from your lead.',
    '- You MUST execute it for real in your workspace: read/write files, run commands, produce the actual artifact (code, document, etc.). Do the work — do not merely describe it.',
    '- If the task touches something sensitive (destructive commands, production, spending), you MUST request permission first and wait for approval.',
    '- You MUST report your result back to your lead, including the paths of any files you changed.',
  ];
};

/**
 * Compose the full soul/workflow prompt for a role.
 *
 * The returned text is injected as the role's system/context before it acts, so
 * the model knows who it is, what it owns, who it may delegate to, and the rules
 * it must follow (Requirement 1.2, 1.3).
 */
export const composeSoul = (input: ComposeSoulInput): string => {
  const { companyName, node, directReports, rules } = input;
  const hasReports = directReports.length > 0;

  const lines: string[] = [`You are "${node.name}", the ${roleLabel(node.role)} at the AI company "${companyName}".`];

  if (node.responsibilities) {
    lines.push(`Your responsibilities: ${node.responsibilities}`);
  }

  // WHO YOU TALK TO — the binding communication chain (no skipping levels).
  lines.push('', 'CHAIN OF COMMAND (binding — you may ONLY communicate along these links):');
  if (node.role === 'president') {
    lines.push('- You report to the user. You give directives only to your direct reports listed below.');
  } else {
    lines.push(
      '- You receive tasks ONLY from your superior (the role that assigned this task) and report your result ONLY back to them.'
    );
    if (hasReports) {
      lines.push(
        '- You delegate ONLY to your own direct reports listed below — never skip a level, never contact anyone outside this chain.'
      );
    } else {
      lines.push('- You do not contact anyone else in the company.');
    }
  }

  lines.push('', ...workflowFor(node.role, hasReports));

  if (hasReports) {
    lines.push('', 'Your DIRECT REPORTS (you may delegate ONLY to these, by their id):');
    for (const report of directReports) {
      const resp = report.responsibilities ? ` — ${report.responsibilities}` : '';
      lines.push(`- [id: ${report.id}] ${report.name} (${roleLabel(report.role)})${resp}`);
    }
  } else {
    lines.push('', 'You have no direct reports — you carry out tasks yourself.');
  }

  if (rules.length > 0) {
    lines.push('', 'COMPANY RULES (mandatory — must follow at all times):');
    for (const rule of rules) lines.push(`- ${rule}`);
  }

  lines.push(
    '',
    'You must stay strictly in this role and follow the mandatory workflow above 100% of the time. Do not act outside your responsibilities or chain of command.'
  );

  return lines.join('\n');
};

/** Map a role node's direct children to {@link DirectReport}s. */
export const directReportsOf = (node: RoleNode): DirectReport[] =>
  node.children.map((child) => ({
    id: child.id,
    name: child.name,
    role: child.role,
    responsibilities: child.responsibilities,
  }));

/** Find a role node by id within a structure (depth-first), or null. */
export const findRoleNode = (structure: CompanyStructure, nodeId: string): RoleNode | null => {
  const walk = (node: RoleNode): RoleNode | null => {
    if (node.id === nodeId) return node;
    for (const child of node.children) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(structure.root);
};
