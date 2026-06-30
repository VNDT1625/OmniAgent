/**
 * @license
 * Copyright 2025 Omni Project
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `wikiCritic` — the deterministic "self-evaluation" core of the production-grade
 * wiki pipeline.
 *
 * After a section is authored, we do not assume it is good. {@link critiqueSection}
 * scores ONE authored Markdown section (0..1) against the same ground truth the
 * writer was given — the repo's real file set and the section's brief — and
 * returns concrete, actionable issues plus a guidance string the improver feeds
 * back to the model. The score drives the refine loop: keep improving while the
 * section keeps getting meaningfully better, and stop when it converges (it can
 * no longer be optimised) — the "complete until it can't improve" requirement.
 *
 * The checks are deterministic (no model, no network) so the loop is cheap to
 * gate and the whole thing is trivially unit-testable:
 *   - **placeholder / too-short** — the model bailed or produced a stub.
 *   - **hallucinated-path** — a concrete repo path cited in `inline code` that
 *     does NOT exist in the repo (the single most damaging wiki defect).
 *   - **low-grounding** — cites no real repo files at all.
 *   - **missing-diagram** — the brief asked for a Mermaid diagram and there is none.
 *   - **no-subheadings** — a long section with no `###` structure.
 *   - **duplicate-title** — repeats the section title as an H1/H2 (told not to).
 *   - **missing-coverage** — ignores the salient keywords of the brief.
 *
 * Process boundary: shared module. No DOM / Node APIs.
 */

/** Ground truth a section is scored against. */
export type WikiCritiqueFacts = {
  /** Every real repo-relative path (forward-slash, normalised). */
  files: ReadonlySet<string>;
  /** The key files the wiki was grounded on (a citation of these is rewarded). */
  keyFiles: ReadonlySet<string>;
  /** True when the section's brief asked for a Mermaid diagram. */
  expectMermaid: boolean;
  /** Salient lower-cased keywords from the brief, for coverage scoring. */
  briefKeywords: readonly string[];
  /** Human title of the section (to detect a duplicated heading). */
  sectionTitle: string;
};

/** A category of section-quality defect. */
export type CritiqueIssueKind =
  | 'placeholder'
  | 'too-short'
  | 'hallucinated-path'
  | 'low-grounding'
  | 'missing-diagram'
  | 'no-subheadings'
  | 'duplicate-title'
  | 'missing-coverage';

/** One scored defect found in a section. */
export type CritiqueIssue = {
  /** Defect category. */
  kind: CritiqueIssueKind;
  /** Human-readable detail (also fed back to the model as guidance). */
  detail: string;
  /** Penalty weight subtracted from the score (0..1). */
  severity: number;
};

/** The critique of one authored section. */
export type Critique = {
  /** Overall quality score, 0 (unusable) .. 1 (excellent). */
  score: number;
  /** All defects found, worst-first. */
  issues: CritiqueIssue[];
  /** Imperative instructions derived from the issues, for the improve prompt. */
  guidance: string;
};

/** Minimum useful body length (chars) before "too short" applies. */
const MIN_BODY_CHARS = 200;
/** Body length (chars) above which a lack of `###` sub-headings is penalised. */
const SUBHEADING_THRESHOLD = 600;
/** Phrases that betray a non-answer the model emitted. */
const PLACEHOLDER_HINTS = [
  'could not be generated',
  'todo',
  'tbd',
  'lorem ipsum',
  'as an ai',
  'i cannot',
  'placeholder',
];

/** Score at/above which a section is considered excellent (stop improving). */
export const HIGH_SCORE = 0.95;
/** Minimum score gain between iterations to justify another improve pass. */
export const MIN_IMPROVEMENT = 0.02;

/** Normalise a path to forward-slashes and drop a leading `./`. */
const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Lower-cased basename (last forward-slash segment) of a path. */
const basenameOf = (p: string): string => {
  const norm = normPath(p);
  const slash = norm.lastIndexOf('/');
  return (slash >= 0 ? norm.slice(slash + 1) : norm).toLowerCase();
};

/** Inline-code spans: `` `code` ``. */
const INLINE_CODE_RE = /`([^`\n]+)`/g;
/** Fenced code block delimiter. */
const FENCE_RE = /^(```|~~~)/;

/**
 * Whether a token (from inline code) names a concrete repo file reference — it
 * carries a path separator AND a file extension, has no spaces/URL scheme, and
 * is not an absolute OS path. Conservative on purpose: we only flag tokens that
 * really look like "a file in this repo" so prose like `useState` is ignored.
 */
const looksLikeConcreteFile = (token: string): boolean => {
  const t = token.trim();
  if (t.length === 0 || /\s/.test(t)) return false;
  if (/^(https?:|mailto:|#|\/\/)/i.test(t)) return false;
  if (/^[a-z]:[\\/]/i.test(t) || t.startsWith('/')) return false;
  if (/[<>|*?"]/.test(t)) return false;
  const path = t.replace(/[#?].*$/, '');
  return path.includes('/') && /\.[a-z0-9]{1,8}$/i.test(path);
};

/** All non-fenced lines of a markdown body (so code samples are not scored). */
const proseLines = (markdown: string): string[] => {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (FENCE_RE.test(line.trimStart())) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) out.push(line);
  }
  return out;
};

/** Extract concrete-file path tokens cited in inline code across the prose. */
const citedPaths = (markdown: string): string[] => {
  const found = new Set<string>();
  for (const line of proseLines(markdown)) {
    for (const m of line.matchAll(INLINE_CODE_RE)) {
      const token = m[1].trim().replace(/[#?].*$/, '');
      if (looksLikeConcreteFile(token)) found.add(normPath(token));
    }
  }
  return [...found];
};

/** Build the human guidance string fed back to the model from the issues. */
const buildGuidance = (issues: readonly CritiqueIssue[]): string => {
  if (issues.length === 0) return '';
  const lines = issues.map((issue, i) => `${i + 1}. ${issue.detail}`);
  return `Revise the section to fix these specific problems while keeping what is already correct:\n${lines.join('\n')}`;
};

/**
 * Score one authored section against the repo ground truth + its brief. Pure:
 * returns the same critique for the same inputs. The score starts at 1 and each
 * issue subtracts its severity (clamped to [0,1]); the guidance string lists the
 * concrete fixes for the improver.
 */
export const critiqueSection = (markdown: string, facts: WikiCritiqueFacts): Critique => {
  const issues: CritiqueIssue[] = [];
  const body = markdown.trim();
  const lower = body.toLowerCase();

  // 1) Placeholder / non-answer.
  const hint = PLACEHOLDER_HINTS.find((h) => lower.includes(h));
  if (hint) {
    issues.push({
      kind: 'placeholder',
      detail: `Remove the placeholder/non-answer text ("${hint}") and write the real content grounded in the provided files.`,
      severity: 0.6,
    });
  }

  // 2) Too short.
  if (body.length < MIN_BODY_CHARS) {
    issues.push({
      kind: 'too-short',
      detail: `The section is too short (${body.length} chars). Expand it with concrete, grounded detail.`,
      severity: 0.4,
    });
  }

  // 3) Hallucinated paths — concrete repo files cited that do not exist.
  const cited = citedPaths(markdown);
  const real = cited.filter((p) => facts.files.has(p));
  const hallucinated: string[] = [];
  for (const path of cited) {
    if (facts.files.has(path)) continue;
    // A path whose basename exists elsewhere is "imprecise" (lower penalty); a
    // path whose basename is nowhere in the repo is pure invention (higher).
    const basenameExists = [...facts.files].some((f) => basenameOf(f) === basenameOf(path));
    hallucinated.push(path);
    issues.push({
      kind: 'hallucinated-path',
      detail: basenameExists
        ? `The path \`${path}\` is wrong — fix it to the file's real location or remove it.`
        : `The path \`${path}\` does not exist in the repository — remove it or replace it with a real file.`,
      severity: basenameExists ? 0.08 : 0.18,
    });
  }

  // 4) Low grounding — cites no real repo file at all (when there are key files
  //    to cite). Overview-style sections still benefit from at least one anchor.
  if (real.length === 0 && facts.keyFiles.size > 0 && hallucinated.length === 0) {
    issues.push({
      kind: 'low-grounding',
      detail: 'Cite at least one real file path (in `inline code`) from the key files to ground the claims.',
      severity: 0.2,
    });
  }

  // 5) Missing Mermaid diagram when the brief asked for one.
  if (facts.expectMermaid && !/```mermaid/i.test(markdown)) {
    issues.push({
      kind: 'missing-diagram',
      detail: 'Add a Mermaid diagram (```mermaid fenced block) illustrating the structure described.',
      severity: 0.2,
    });
  }

  // 6) No sub-headings in a long section.
  if (body.length > SUBHEADING_THRESHOLD && !/^###\s/m.test(markdown)) {
    issues.push({
      kind: 'no-subheadings',
      detail: 'Break the section into `###` sub-sections so it is scannable.',
      severity: 0.1,
    });
  }

  // 7) Duplicate top-level title.
  const firstHeading = proseLines(markdown).find((l) => /^#{1,2}\s/.test(l.trim()));
  if (firstHeading && firstHeading.replace(/^#{1,2}\s+/, '').trim().toLowerCase() === facts.sectionTitle.trim().toLowerCase()) {
    issues.push({
      kind: 'duplicate-title',
      detail: 'Do not repeat the section title as a heading; the app renders it. Start with the prose.',
      severity: 0.08,
    });
  }

  // 8) Keyword coverage of the brief.
  if (facts.briefKeywords.length > 0) {
    const covered = facts.briefKeywords.filter((kw) => lower.includes(kw.toLowerCase()));
    const ratio = covered.length / facts.briefKeywords.length;
    if (ratio < 0.5) {
      const missing = facts.briefKeywords.filter((kw) => !lower.includes(kw.toLowerCase())).slice(0, 6);
      issues.push({
        kind: 'missing-coverage',
        detail: `Cover the topics the brief asks about — notably: ${missing.join(', ')}.`,
        severity: 0.15 * (1 - ratio),
      });
    }
  }

  const penalty = issues.reduce((sum, issue) => sum + issue.severity, 0);
  const score = Math.max(0, Math.min(1, 1 - penalty));
  return { score, issues, guidance: buildGuidance(issues) };
};

/** Options governing when the refine loop stops. */
export type ConvergenceOptions = {
  /** Stop once a score reaches this (default {@link HIGH_SCORE}). */
  highScore?: number;
  /** Minimum gain over the previous score to keep going (default {@link MIN_IMPROVEMENT}). */
  minImprovement?: number;
  /** Hard cap on improvement passes. */
  maxIterations: number;
};

/**
 * Decide whether the refine loop should stop, given the score history so far
 * (one entry per pass, oldest first). Stops when the latest score is excellent,
 * when the last pass failed to improve by at least `minImprovement` (it can no
 * longer be optimised), or when the iteration cap is hit. Pure.
 */
export const hasConverged = (history: readonly number[], opts: ConvergenceOptions): boolean => {
  if (history.length === 0) return false;
  const high = opts.highScore ?? HIGH_SCORE;
  const minGain = opts.minImprovement ?? MIN_IMPROVEMENT;
  const last = history[history.length - 1];
  if (last >= high) return true;
  if (history.length >= opts.maxIterations) return true;
  if (history.length >= 2) {
    const prev = history[history.length - 2];
    if (last - prev < minGain) return true;
  }
  return false;
};
