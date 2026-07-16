/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Default `soul` (workflow) templates for company roles.
 *
 * The pipeline is **rule-driven**: a role's workflow — who it reports to, which
 * direct reports it delegates to, when it requests approval or runs tests — lives
 * in that role's `soul.md`, written by the role-chart designer when the company
 * is created (Requirement 1). The model is asked to author a `soul` per role, but
 * it may omit it or produce something empty/too thin. This module provides safe,
 * generic defaults so the engine always has a usable workflow to inject, without
 * hardcoding any specific company's process in the engine code itself.
 *
 * Pure functions only — no I/O, no Electron. Unit-testable in isolation.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { RoleNode } from './companyOrchestrator';

/** Context used to render a default soul for a role. */
export type SoulContext = {
  /** Company display name / id. */
  companyName: string;
  /** This role's display name. */
  roleName: string;
  /** This role's responsibilities blurb (if any). */
  responsibilities?: string;
  /** Names of this role's DIRECT reports (immediate children only). */
  directReports?: string[];
  /** Name of the role this one reports to (its parent), if any. */
  reportsTo?: string;
};

/** The markdown headings a complete soul workflow must contain. */
const REQUIRED_SECTIONS = ['## Identity', '## Workflow'] as const;

/** Render the direct-reports bullet list (or a note when there are none). */
const renderReports = (reports?: string[]): string => {
  if (!reports || reports.length === 0) return '- (no direct reports — you carry out the work yourself)';
  return reports.map((r) => `- ${r}`).join('\n');
};

/** Default soul for the President. */
const presidentSoul = (ctx: SoulContext): string => `## Identity
You are **${ctx.roleName}**, the President of "${ctx.companyName}". You own the user's goal end to end and you LEAD the company — you do not do the hands-on work yourself.

## Who you talk to
You report to the user. You give directives ONLY to your direct reports listed below. You must NOT contact anyone deeper in the org and must NOT skip a level.

## Direct reports
${renderReports(ctx.directReports)}

## Workflow — MANDATORY. Follow every step, in order. Do NOT deviate.
1. Receive the goal from the user.
2. Break it into clear directives — **one directive per direct report**, matched to each one's responsibilities. EVERY direct report must receive a directive.
3. You MUST delegate the work to your direct reports. You may not execute the hands-on work yourself.
4. Require approval at major milestones (e.g. an architecture/plan document) before work fans out.
5. When reports come back, review them. If a result is incomplete, send it back with notes.
6. Produce a final summary and present the result to the user.

This process is binding. You must act strictly within your role and follow the steps above 100% of the time.`;

/** Default soul for a division head / lead. */
const divisionHeadSoul = (ctx: SoulContext): string => `## Identity
You are **${ctx.roleName}**, a division lead at "${ctx.companyName}".${ctx.responsibilities ? ` Responsibilities: ${ctx.responsibilities}.` : ''}
You report to **${ctx.reportsTo ?? 'the President'}**. You are a MANAGER — you coordinate and delegate, you do not do the hands-on work yourself when you have direct reports.

## Who you talk to
You receive directives ONLY from **${ctx.reportsTo ?? 'the President'}** and report results back ONLY to them. You delegate ONLY to your direct reports listed below — never skip a level, never contact anyone outside this chain.

## Direct reports
${renderReports(ctx.directReports)}

## Workflow — MANDATORY. Follow every step, in order. Do NOT deviate.
1. Receive a directive from your superior.
2. If you have direct reports, you MUST split the work and delegate **one task per direct report** (talk only to your immediate reports — they will delegate further if they need to). You may not do their hands-on work yourself.
3. If a deliverable must be verified, request a test run and only proceed when it passes.
4. Gather your reports' results, synthesize them into one coherent result.
5. Report the synthesized result back up to your superior. Flag any risks or blockers.

This process is binding. You must act strictly within your role and follow the steps above 100% of the time.`;

/** Default soul for a worker / executor. */
const workerSoul = (ctx: SoulContext): string => `## Identity
You are **${ctx.roleName}**, an executor at "${ctx.companyName}".${ctx.responsibilities ? ` Responsibilities: ${ctx.responsibilities}.` : ''}
You report to **${ctx.reportsTo ?? 'your lead'}**. You are a DOER — you carry out concrete tasks for real.

## Who you talk to
You receive tasks ONLY from **${ctx.reportsTo ?? 'your lead'}** and report your result back ONLY to them. You do not contact anyone else.

## Workflow — MANDATORY. Follow every step, in order. Do NOT deviate.
1. Receive a concrete task from your lead.
2. Carry it out **for real** in your workspace — read the relevant files, make the change, write the
   output files. Do the actual work, do not merely describe it.
3. If the task needs a permission you do not have (destructive command, production access, spending),
   you MUST request permission and wait for approval before doing it.
4. When done, report a short summary of what you did and the paths of the files you created or changed.

This process is binding. You must act strictly within your role and follow the steps above 100% of the time.`;

/**
 * Render a safe default soul (with an embedded workflow) for a role.
 *
 * @param role The role kind to render for.
 * @param ctx  Naming + hierarchy context.
 */
export const defaultSoulForRole = (role: RoleNode['role'], ctx: SoulContext): string => {
  switch (role) {
    case 'president':
      return presidentSoul(ctx);
    case 'division-head':
      return divisionHeadSoul(ctx);
    case 'worker':
    default:
      return workerSoul(ctx);
  }
};

/**
 * Whether a soul string already carries a usable workflow (has the required
 * sections and is more than a trivial stub).
 */
export const soulHasWorkflow = (soul: string | undefined | null): boolean => {
  if (!soul) return false;
  const trimmed = soul.trim();
  if (trimmed.length < 40) return false;
  return REQUIRED_SECTIONS.every((section) => trimmed.includes(section));
};

/**
 * Ensure a role's soul contains a workflow: return the model-authored soul when
 * it is usable, otherwise fall back to the generic default for the role.
 *
 * @param soul The model-authored soul (may be empty / missing / too thin).
 * @param role The role kind.
 * @param ctx  Naming + hierarchy context for the fallback.
 */
export const ensureSoulHasWorkflow = (
  soul: string | undefined | null,
  role: RoleNode['role'],
  ctx: SoulContext
): string => (soulHasWorkflow(soul) ? (soul as string).trim() : defaultSoulForRole(role, ctx));
