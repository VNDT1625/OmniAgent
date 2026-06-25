/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure EARS requirements parser + validator.
 *
 * Parses a `requirements.md` body into structured {@link Requirement} blocks
 * and classifies each acceptance criterion by EARS pattern, then emits
 * {@link SpecDiagnostic}s that bring the spec up to Kiro-grade discipline:
 *  - every requirement has a stable id and at least one acceptance criterion,
 *  - criteria use normative `SHALL`/`MUST`,
 *  - criteria follow a recognizable EARS shape.
 *
 * No I/O — callers pass file text in and get analysis out.
 */

import type { AcceptanceCriterion, EarsPattern, Requirement, RequirementsAnalysis, SpecDiagnostic } from './earsTypes';

const LIST_ITEM = /^\s*[-*]\s+(.+?)\s*$/;
const NUMBERED_ITEM = /^\s*\d+[.)]\s+(.+?)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*$/;
/** Matches an explicit requirement id like `R1`, `R12`, `REQ-3` at heading start. */
const REQ_ID = /^(?:requirement\s+)?(R(?:EQ)?-?\d+)\b[:.)\-\s]*/i;
const USER_STORY = /\bas an?\b.+\bi want\b/i;

/** Classify a single criterion string into an EARS pattern. */
export const classifyEars = (text: string): EarsPattern => {
  const t = text.trim();
  const lower = t.toLowerCase();
  const hasShall = /\b(shall|must)\b/i.test(t);
  if (!hasShall) return 'unknown';
  // Unwanted behavior: "IF <condition>, THEN the system SHALL ..."
  if (/^if\b/i.test(lower) && /\bthen\b/i.test(lower)) return 'unwanted';
  // Event driven: "WHEN <trigger>, THEN/the system SHALL ..."
  if (/^when\b/i.test(lower)) return 'event';
  // State driven: "WHILE <state>, the system SHALL ..."
  if (/^while\b/i.test(lower)) return 'state';
  // Optional feature: "WHERE <feature included>, the system SHALL ..."
  if (/^where\b/i.test(lower)) return 'optional';
  // Ubiquitous: "The system SHALL ..." (no precondition keyword).
  if (/\bshall|must\b/i.test(lower)) return 'ubiquitous';
  return 'unknown';
};

/** True when a criterion uses normative language. */
const hasNormative = (text: string): boolean => /\b(shall|must)\b/i.test(text);

const stripListMarker = (line: string): string | null => {
  const m = line.match(LIST_ITEM) ?? line.match(NUMBERED_ITEM);
  return m ? m[1].trim() : null;
};

/** Is this heading line the start of an acceptance-criteria sub-section? */
const isCriteriaHeading = (text: string): boolean => /acceptance criteria|criteria|acceptance/i.test(text);

/**
 * Parse requirements.md into structured requirements. Headings at level 2/3
 * that are not the document title or boilerplate sections become requirements;
 * list items under them become acceptance criteria.
 */
export const parseRequirements = (markdown: string): Requirement[] => {
  const lines = markdown.split(/\r?\n/);
  const requirements: Requirement[] = [];
  let current: Requirement | null = null;
  let autoSeq = 0;

  const boilerplate = /^(goal|non-?goals?|constraints|overview|context|out of scope|summary)$/i;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const headingMatch = raw.match(HEADING);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      // Title (#) and boilerplate sections never become requirements.
      if (level <= 1 || boilerplate.test(headingText.replace(/[:.]+$/, ''))) {
        // A boilerplate heading closes any open requirement so its list items
        // (e.g. Non-Goals bullets) are not mistaken for acceptance criteria.
        current = null;
        continue;
      }
      // An "Acceptance Criteria" sub-heading belongs to the current requirement;
      // do not start a new requirement for it.
      if (isCriteriaHeading(headingText) && current) {
        continue;
      }
      // Start a new requirement.
      autoSeq += 1;
      const idMatch = headingText.match(REQ_ID);
      const id = idMatch ? idMatch[1].toUpperCase().replace(/^REQ-?/, 'R') : `R${autoSeq}`;
      const title = idMatch ? headingText.slice(idMatch[0].length).trim() || headingText : headingText;
      current = { id, title, line: i + 1, userStory: null, criteria: [] };
      requirements.push(current);
      continue;
    }
    if (!current) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Capture a user story line.
    if (current.userStory === null && USER_STORY.test(trimmed)) {
      current.userStory = trimmed.replace(/^[-*]\s+/, '').trim();
      continue;
    }
    const item = stripListMarker(raw);
    if (item) {
      // Every list item directly under a requirement is an acceptance
      // criterion. Boilerplate sections (Non-Goals, Constraints...) already
      // closed the current requirement, so their bullets are not captured here.
      const criterion: AcceptanceCriterion = {
        line: i + 1,
        text: item,
        pattern: classifyEars(item),
        hasShall: hasNormative(item),
      };
      current.criteria.push(criterion);
    }
  }
  return requirements;
};

/** Validate parsed requirements and produce diagnostics. */
export const validateRequirements = (requirements: readonly Requirement[]): SpecDiagnostic[] => {
  const diagnostics: SpecDiagnostic[] = [];
  if (requirements.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'requirements.empty',
      message: 'No requirements found. Add at least one requirement with acceptance criteria.',
    });
    return diagnostics;
  }
  const seen = new Set<string>();
  for (const req of requirements) {
    if (seen.has(req.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'requirement.duplicateId',
        message: `Duplicate requirement id "${req.id}".`,
        refId: req.id,
        line: req.line,
      });
    }
    seen.add(req.id);
    if (req.criteria.length === 0) {
      diagnostics.push({
        severity: 'warning',
        code: 'requirement.noCriteria',
        message: `Requirement "${req.id}" has no acceptance criteria.`,
        refId: req.id,
        line: req.line,
      });
      continue;
    }
    for (const criterion of req.criteria) {
      if (!criterion.hasShall) {
        diagnostics.push({
          severity: 'warning',
          code: 'criterion.noShall',
          message: `Criterion is not normative (missing SHALL/MUST): "${criterion.text}".`,
          refId: req.id,
          line: criterion.line,
        });
      } else if (criterion.pattern === 'unknown') {
        diagnostics.push({
          severity: 'info',
          code: 'criterion.nonEars',
          message: `Criterion has SHALL but no EARS shape (WHEN/IF/WHILE/WHERE): "${criterion.text}".`,
          refId: req.id,
          line: criterion.line,
        });
      }
    }
  }
  return diagnostics;
};

/** Parse + validate requirements.md in one call. */
export const analyzeRequirements = (markdown: string): RequirementsAnalysis => {
  const requirements = parseRequirements(markdown);
  const diagnostics = validateRequirements(requirements);
  const withCriteria = requirements.filter((r) => r.criteria.length > 0).length;
  const earsCompliant = requirements.filter(
    (r) => r.criteria.length > 0 && r.criteria.every((c) => c.hasShall && c.pattern !== 'unknown')
  ).length;
  return {
    requirements,
    diagnostics,
    counts: {
      total: requirements.length,
      withCriteria,
      earsCompliant,
    },
  };
};
