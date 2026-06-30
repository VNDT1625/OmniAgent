/**
 * @license
 * Copyright 2025 Omni Project
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `docVerify` — the "trust but verify" core of the persistent-wiki bootstrap.
 *
 * Project documentation (README, AGENTS.md, CONTRIBUTING, `docs/**`) drifts: it
 * references files that were moved/renamed and commands that no longer exist in
 * the manifest. Before we ground a generated wiki on those docs, we VERIFY every
 * checkable claim against what the repo actually contains, and produce a
 * deterministically CORRECTED copy of each doc so the wiki is grounded on truth
 * rather than stale prose.
 *
 * The two claim families we can verify deterministically (no model, no network):
 *   1. **File-path references** — paths written in `inline code` or markdown
 *      links that point at repo files. A reference to a path that does not exist
 *      is a `missing-file` issue; when exactly one real file shares its basename
 *      we auto-correct the path to the moved location, otherwise we annotate it.
 *   2. **Command references** — `npm run X` / `yarn X` / `pnpm X` / `bun run X`
 *      and bare script invocations whose script name is absent from
 *      `package.json` is a `stale-command` issue; a near-miss script name is
 *      suggested and auto-corrected.
 *
 * Everything here is a PURE function of its inputs (markdown text + repo facts)
 * so it is trivially unit-testable; the bootstrap orchestrator does the IO
 * (reading docs, parsing manifests, writing corrected docs back).
 *
 * Process boundary: shared module. No DOM / Node APIs at module scope.
 */

/** A documentation source file gathered from the repo. */
export type DocSourceFile = {
  /** Repo-relative, forward-slash path of the doc. */
  path: string;
  /** Raw markdown content. */
  content: string;
};

/** The ground truth a doc's claims are checked against. */
export type RepoFacts = {
  /** Every real repo-relative path (forward-slash). */
  files: ReadonlySet<string>;
  /** Manifest script names → command line (from every `package.json`). */
  scripts: ReadonlyMap<string, string>;
  /** Lower-cased basename → real paths sharing it (for move detection). */
  byBasename: ReadonlyMap<string, readonly string[]>;
};

/** What kind of doc claim failed verification. */
export type DocIssueKind = 'missing-file' | 'stale-command';

/** A single verification failure found in a doc. */
export type DocIssue = {
  /** Which doc the issue is in (repo-relative). */
  docPath: string;
  /** 1-based line number of the offending reference. */
  line: number;
  /** Kind of failed claim. */
  kind: DocIssueKind;
  /** The exact offending reference text (path or command). */
  text: string;
  /** A closest real match when one was found, else undefined. */
  suggestion?: string;
  /** Whether the corrected doc auto-fixed this issue (vs only annotated). */
  fixed: boolean;
};

/** The verification result for one doc. */
export type DocVerification = {
  /** Repo-relative doc path. */
  docPath: string;
  /** All issues found (empty when the doc verifies clean). */
  issues: DocIssue[];
  /** The corrected markdown (auto-fixed refs; same text when nothing changed). */
  corrected: string;
  /** Whether {@link corrected} differs from the input. */
  changed: boolean;
};

// ---------------------------------------------------------------------------
// Repo facts
// ---------------------------------------------------------------------------

/** Normalise a path to forward-slashes and drop a leading `./`. */
const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** Lower-cased basename (last forward-slash segment) of a path. */
const basenameOf = (p: string): string => {
  const norm = normPath(p);
  const slash = norm.lastIndexOf('/');
  return (slash >= 0 ? norm.slice(slash + 1) : norm).toLowerCase();
};

/**
 * Build the {@link RepoFacts} a doc's claims are checked against, from the
 * repo's file list (relative path + content). Every `package.json` contributes
 * its `scripts`. Pure: derives only from its inputs.
 */
export const buildRepoFacts = (files: ReadonlyArray<{ relPath: string; content: string }>): RepoFacts => {
  const fileSet = new Set<string>();
  const byBasename = new Map<string, string[]>();
  const scripts = new Map<string, string>();

  for (const file of files) {
    const rel = normPath(file.relPath);
    fileSet.add(rel);
    const base = basenameOf(rel);
    const bucket = byBasename.get(base);
    if (bucket) bucket.push(rel);
    else byBasename.set(base, [rel]);

    if (base === 'package.json') {
      try {
        const parsed = JSON.parse(file.content) as { scripts?: Record<string, unknown> };
        for (const [name, cmd] of Object.entries(parsed.scripts ?? {})) {
          if (typeof cmd === 'string' && !scripts.has(name)) scripts.set(name, cmd);
        }
      } catch {
        // A malformed manifest contributes no scripts (never throws the build).
      }
    }
  }

  return { files: fileSet, scripts, byBasename };
};

// ---------------------------------------------------------------------------
// Markdown scanning helpers (pure, regex-based)
// ---------------------------------------------------------------------------

/** Ranges of fenced code blocks (```), so we never "fix" code samples. */
const fencedLineFlags = (lines: string[]): boolean[] => {
  const inFence = Array.from({ length: lines.length }, () => false);
  let fenced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trimStart();
    if (/^(```|~~~)/.test(trimmed)) {
      // The fence delimiter line itself is treated as code so refs on it are skipped.
      inFence[i] = true;
      fenced = !fenced;
      continue;
    }
    inFence[i] = fenced;
  }
  return inFence;
};

/** Whether a token looks like a relative repo file reference (not URL/anchor). */
const looksLikeRepoPath = (token: string): boolean => {
  const t = token.trim();
  if (t.length === 0) return false;
  if (/^(https?:|mailto:|#|\/\/)/i.test(t)) return false; // external / anchor
  if (/[<>|*?"]/.test(t)) return false; // not a real path token
  // Must either contain a slash or carry a file extension to be a "path".
  const hasSlash = t.includes('/');
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(t);
  if (!hasSlash && !hasExt) return false;
  // Skip absolute OS paths and bare domains.
  if (/^[a-z]:[\\/]/i.test(t) || t.startsWith('/')) return false;
  if (/^[\w-]+\.(com|org|net|io|dev|md#)/i.test(t) && !hasSlash) return false;
  return true;
};

/** Strip a trailing markdown anchor / query from a path reference. */
const stripAnchor = (p: string): string => p.replace(/[#?].*$/, '').trim();

/** Inline-code spans: `` `code` ``. Returns the inner token + column. */
const INLINE_CODE_RE = /`([^`\n]+)`/g;
/** Markdown links: `[label](target)`. Returns the target + column. */
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
/** Package-script command invocations in prose/inline code. */
const RUN_CMD_RE = /\b(?:npm run|yarn run|pnpm run|bun run|yarn|pnpm)\s+([a-zA-Z0-9:_-]+)/g;

// ---------------------------------------------------------------------------
// Suggestions (closest real match)
// ---------------------------------------------------------------------------

/** Resolve a moved file: a unique real path sharing the reference's basename. */
const suggestMovedPath = (ref: string, facts: RepoFacts): string | undefined => {
  const candidates = facts.byBasename.get(basenameOf(ref));
  if (!candidates || candidates.length !== 1) return undefined;
  const only = candidates[0];
  return only === normPath(ref) ? undefined : only;
};

/** Levenshtein distance, capped early — enough for short script names. */
const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = Array.from({ length: n + 1 }, () => 0);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
};

/** Suggest the closest existing script name for a stale command (edit distance ≤ 2). */
const suggestScript = (name: string, facts: RepoFacts): string | undefined => {
  let best: string | undefined;
  let bestDist = 3; // strictly less than 3 → accept
  for (const candidate of facts.scripts.keys()) {
    const dist = editDistance(name, candidate);
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
};

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Replace the first occurrence of `from` with `to` on a single line. */
const replaceOnce = (line: string, from: string, to: string): string => {
  const idx = line.indexOf(from);
  return idx < 0 ? line : `${line.slice(0, idx)}${to}${line.slice(idx + from.length)}`;
};

/**
 * Verify one doc's checkable claims against {@link RepoFacts} and return the
 * issues plus a deterministically corrected copy. A `missing-file` reference
 * with a unique moved target is rewritten to the new path; a `stale-command`
 * with a near-miss script is rewritten to the real script. Unfixable references
 * are reported but left intact (we never guess-delete user prose). Pure.
 */
export const verifyDoc = (doc: DocSourceFile, facts: RepoFacts): DocVerification => {
  const lines = doc.content.split('\n');
  const fenced = fencedLineFlags(lines);
  const issues: DocIssue[] = [];
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    let line = lines[i];

    // Collect path references from inline code + markdown links.
    const refs = new Map<string, 'code' | 'link'>();
    for (const m of line.matchAll(INLINE_CODE_RE)) {
      const token = stripAnchor(m[1]);
      if (looksLikeRepoPath(token)) refs.set(token, 'code');
    }
    for (const m of line.matchAll(MD_LINK_RE)) {
      const token = stripAnchor(m[1]);
      if (looksLikeRepoPath(token)) refs.set(token, 'link');
    }

    for (const ref of refs.keys()) {
      const norm = normPath(ref);
      if (facts.files.has(norm)) continue; // verified — real file
      const suggestion = suggestMovedPath(ref, facts);
      if (suggestion) {
        line = replaceOnce(line, ref, suggestion);
        changed = true;
      }
      issues.push({
        docPath: doc.path,
        line: i + 1,
        kind: 'missing-file',
        text: ref,
        suggestion,
        fixed: Boolean(suggestion),
      });
    }

    // Command references (only meaningful when the repo declares scripts).
    if (facts.scripts.size > 0) {
      for (const m of line.matchAll(RUN_CMD_RE)) {
        const name = m[1];
        if (facts.scripts.has(name)) continue; // verified — real script
        // `yarn`/`pnpm` without `run` can be a bare CLI verb (add/install) — only
        // flag it when it is clearly meant as a script (a near-miss exists).
        const suggestion = suggestScript(name, facts);
        if (suggestion) {
          line = replaceOnce(line, name, suggestion);
          changed = true;
          issues.push({
            docPath: doc.path,
            line: i + 1,
            kind: 'stale-command',
            text: name,
            suggestion,
            fixed: true,
          });
        }
      }
    }

    lines[i] = line;
  }

  const corrected = lines.join('\n');
  return { docPath: doc.path, issues, corrected, changed: changed && corrected !== doc.content };
};

/** Aggregate verification across many docs (stable order: input order). */
export const verifyDocs = (docs: ReadonlyArray<DocSourceFile>, facts: RepoFacts): DocVerification[] =>
  docs.map((doc) => verifyDoc(doc, facts));

/** Total issue count across verifications (for a one-line summary). */
export const countIssues = (verifications: ReadonlyArray<DocVerification>): { total: number; fixed: number } => {
  let total = 0;
  let fixed = 0;
  for (const v of verifications) {
    for (const issue of v.issues) {
      total += 1;
      if (issue.fixed) fixed += 1;
    }
  }
  return { total, fixed };
};
