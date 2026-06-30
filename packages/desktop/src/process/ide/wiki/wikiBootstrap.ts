/**
 * @license
 * Copyright 2025 Omni Project
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `wikiBootstrap` — the startup pipeline that turns a repo's (possibly stale)
 * documentation into a verified, durable wiki.
 *
 * The flow, in order, with a phase callback at each step:
 *   1. `scanning`  — collect the repo's files (injected `collectFiles`).
 *   2. `verifying` — gather the doc files (README / AGENTS / CONTRIBUTING /
 *      `docs/**`), build {@link RepoFacts}, and {@link verifyDocs}: check every
 *      file-path and command claim against what the repo actually contains. We
 *      do NOT trust the docs — we check them.
 *   3. `fixing`    — write the deterministically-corrected docs back to disk
 *      (moved-file paths and near-miss script names rewritten), so the source
 *      docs themselves stop lying. Best-effort and reversible (git-tracked).
 *   4. `planning`  — derive the section outline from the real code graph and
 *      pick the key files to ground on (reuses the DeepWiki planner).
 *   5. `writing`   — author each section via the model, grounded on BOTH the
 *      code digest AND the corrected-doc digest, one section at a time.
 *   6. `saving`    — persist the assembled wiki durably (app store + repo
 *      export) so it survives an app restart and is reusable.
 *
 * Every collaborator (file IO, model chat, doc write-back, persistence, clock)
 * is INJECTED so the whole orchestration is unit-testable with fakes — no fs, no
 * network. The bridge supplies the real Node implementations.
 *
 * Process boundary: Main-process (Node.js) module, but IO is injected so the
 * module stays DOM/Node-free at module scope.
 */

import { buildGraphFromFiles, type RepoGraph } from '../repoGraph';
import { planWikiSections, selectKeyFiles, type KeyFile } from '../wikiPlanner';
import { buildRepoFacts, countIssues, verifyDocs, type DocVerification } from './docVerify';
import { PERSISTED_WIKI_VERSION, toDocReport, type PersistedWiki, type PersistedWikiSection } from './wikiStore';
import { refineSection } from './wikiRefine';
import type { WikiCritiqueFacts } from './wikiCritic';

/** Phases emitted during a bootstrap run (drives the progress UI). */
export type WikiBootstrapPhase =
  | 'scanning'
  | 'verifying'
  | 'fixing'
  | 'planning'
  | 'writing'
  | 'saving'
  | 'done'
  | 'error';

/** Injected collaborators for {@link runWikiBootstrap}. */
export type WikiBootstrapDeps = {
  /** File discovery: each repo file's relative path + text content. */
  collectFiles: (rootPath: string) => Promise<Array<{ relPath: string; content: string }>>;
  /** Single-shot model call returning the raw completion text. */
  chat: (model: string, system: string, user: string, signal?: AbortSignal) => Promise<string>;
  /** Write a corrected doc back to disk (repo-relative path). Best-effort. */
  writeDoc: (rootPath: string, relPath: string, content: string) => Promise<void>;
  /** Persist the assembled wiki durably. */
  saveWiki: (wiki: PersistedWiki) => Promise<void>;
  /** Clock (injected for deterministic tests); defaults to `Date.now`. */
  now?: () => number;
};

/** Tuning knobs for a single bootstrap run. */
export type WikiBootstrapOptions = {
  /** Model id to author sections with. */
  model: string;
  /** Display language tag (e.g. `vi-VN`) the prose should be written in. */
  language?: string;
  /** Write corrected docs back to disk (default true). */
  fixDocs?: boolean;
  /** Hard cap on files walked / considered (passed through to the caller's collector). */
  maxFiles?: number;
  /** Max self-improvement passes per section (default 2; 0 disables refinement). */
  maxRefineIterations?: number;
};

/** Progress + cancellation hooks for a bootstrap run. */
export type WikiBootstrapContext = {
  /** Phase progress callback. */
  onPhase?: (phase: WikiBootstrapPhase, detail?: string) => void;
  /** Abort signal — checked between phases/sections. */
  signal?: AbortSignal;
};

/** The result of a bootstrap run (mirrors what gets persisted, plus live detail). */
export type WikiBootstrapResult = {
  /** The persisted wiki payload. */
  wiki: PersistedWiki;
  /** Full verification detail for the run (not persisted in full). */
  verifications: DocVerification[];
  /** Count of docs whose corrected copy was written back. */
  rewrittenCount: number;
};

/** Total budget (chars) for each grounding digest (code + docs). */
const CODE_DIGEST_BUDGET = 10000;
const DOC_DIGEST_BUDGET = 8000;
/** Number of key code files to ground the wiki on. */
const KEY_FILE_LIMIT = 16;
/** Max doc files considered for verification + grounding. */
const MAX_DOC_FILES = 12;
/** Default self-improvement passes per section. */
const DEFAULT_REFINE_ITERATIONS = 0;

/** Stop-words excluded from brief keyword extraction (low signal for coverage). */
const BRIEF_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'its',
  'this',
  'that',
  'with',
  'into',
  'from',
  'when',
  'what',
  'how',
  'they',
  'their',
  'include',
  'including',
  'ground',
  'section',
  'main',
  'real',
  'each',
  'use',
  'a',
  'an',
]);

/**
 * Extract salient lower-cased keywords from a section brief, for the critic's
 * coverage check. Keeps alphabetic words of length ≥ 4 that are not stop-words,
 * de-duplicated and capped. Pure.
 */
const briefKeywords = (brief: string): string[] => {
  const seen = new Set<string>();
  for (const raw of brief.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (BRIEF_STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    if (seen.size >= 10) break;
  }
  return [...seen];
};

/** Whether a relative path names a code file (matches repoGraph's parser set). */
const isCodeFile = (relPath: string): boolean => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(relPath);

/** Whether a relative path is a documentation file worth verifying + grounding. */
export const isDocFile = (relPath: string): boolean => {
  const p = relPath.replace(/\\/g, '/').toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (/\.(md|markdown|mdx)$/.test(base)) return true;
  return base === 'readme' || base === 'agents.md' || base === 'contributing';
};

/** Clip text to `budget` chars with a truncation marker. */
const clip = (text: string, budget: number): string =>
  text.length > budget ? `${text.slice(0, budget)}\n[truncated]` : text;

/** Build a budget-clipped digest from a set of (path, content) pairs. */
const buildDigest = (entries: ReadonlyArray<{ path: string; content: string }>, budget: number): string => {
  if (entries.length === 0) return '';
  const perFile = Math.max(400, Math.floor(budget / entries.length));
  let remaining = budget;
  const out: string[] = [];
  for (const entry of entries) {
    if (remaining <= 0) break;
    if (entry.content.length === 0) continue;
    const allowance = Math.min(perFile, remaining);
    out.push(`### ${entry.path}\n\`\`\`\n${clip(entry.content, allowance)}\n\`\`\``);
    remaining -= Math.min(entry.content.length, allowance);
  }
  return out.join('\n\n');
};

/** System prompt for one wiki section, grounded on verified docs + code. */
const SECTION_SYSTEM_PROMPT =
  'You are a senior software architect writing a section of a technical wiki for a codebase, in the style of deepwiki.com. ' +
  'Write clear, accurate GitHub-flavored Markdown grounded ONLY in the provided VERIFIED docs and code — never invent APIs, files, or behavior. ' +
  'The provided documentation has already been fact-checked and corrected against the real code, so prefer it as the source of intent, ' +
  'but cross-check every claim against the code excerpts. Reference real file paths in `inline code`. ' +
  'Use Mermaid code fences (```mermaid) for diagrams when the section asks for one. ' +
  'Do NOT repeat a top-level heading for the section (the title is rendered by the app); start directly with the prose and use ### for sub-headings.';

/** A localisation directive appended to the system prompt when not English. */
const langLine = (language?: string): string => {
  if (!language || /^en\b/i.test(language)) return '';
  return `\n\nIMPORTANT: Write all prose in ${language}. Keep code identifiers, file paths, and commands exactly as given.`;
};

/** Throw a DOMException-like abort if the signal fired (matches fetch semantics). */
const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error('Wiki bootstrap was cancelled.');
};

/**
 * Run the full doc-verify → wiki bootstrap pipeline for a repo. Returns the
 * persisted wiki + verification detail. Throws on a fatal error (the caller
 * wraps into a result envelope); a single failing section does not abort the
 * run (it is recorded with an error note and the rest continue).
 */
export const runWikiBootstrap = async (
  rootPath: string,
  deps: WikiBootstrapDeps,
  opts: WikiBootstrapOptions,
  ctx: WikiBootstrapContext = {}
): Promise<WikiBootstrapResult> => {
  const now = deps.now ?? Date.now;
  const emit = (phase: WikiBootstrapPhase, detail?: string): void => ctx.onPhase?.(phase, detail);
  const trimmedRoot = rootPath.trim();
  if (trimmedRoot.length === 0) throw new Error('A folder path is required.');

  // 1) Scan.
  emit('scanning');
  throwIfAborted(ctx.signal);
  const files = await deps.collectFiles(trimmedRoot);

  // 2) Verify docs against repo facts.
  emit('verifying');
  throwIfAborted(ctx.signal);
  const repoFacts = buildRepoFacts(files);
  const docEntries = files.filter((f) => isDocFile(f.relPath)).slice(0, MAX_DOC_FILES);
  const verifications = verifyDocs(
    docEntries.map((f) => ({ path: f.relPath.replace(/\\/g, '/'), content: f.content })),
    repoFacts
  );
  const { total, fixed } = countIssues(verifications);
  emit('verifying', `${docEntries.length} docs · ${total} issues · ${fixed} fixable`);

  // 3) Fix docs (write corrected copies back to disk).
  emit('fixing');
  let rewrittenCount = 0;
  const rewritten = new Set<string>();
  if (opts.fixDocs !== false) {
    for (const verification of verifications) {
      throwIfAborted(ctx.signal);
      if (!verification.changed) continue;
      try {
        // eslint-disable-next-line no-await-in-loop -- doc write-backs are best-effort and low-volume; sequential keeps it simple.
        await deps.writeDoc(trimmedRoot, verification.docPath, verification.corrected);
        rewritten.add(verification.docPath);
        rewrittenCount += 1;
      } catch {
        // A read-only or vanished doc is non-fatal; we still ground on the
        // corrected text held in memory.
      }
    }
  }
  emit('fixing', `${rewrittenCount} docs corrected`);

  // 4) Plan: real code graph → outline + key files.
  emit('planning');
  throwIfAborted(ctx.signal);
  const codeFiles = files.filter((f) => isCodeFile(f.relPath));
  const graph: RepoGraph = buildGraphFromFiles(trimmedRoot, codeFiles);
  const metaPaths = files.filter((f) => !isCodeFile(f.relPath)).map((f) => f.relPath.replace(/\\/g, '/'));
  const keyFiles: KeyFile[] = selectKeyFiles(graph, metaPaths, KEY_FILE_LIMIT);
  const sectionPlans = planWikiSections(graph, metaPaths);

  // Build the two grounding digests without duplicating every source file's content.
  const keyPathSet = new Set(keyFiles.filter((key) => key.reason !== 'doc').map((key) => key.path));
  const keyEntries = files
    .map((file) => ({ path: file.relPath.replace(/\\/g, '/'), content: file.content }))
    .filter((file) => keyPathSet.has(file.path) && file.content.length > 0);
  const codeDigest = buildDigest(keyEntries, CODE_DIGEST_BUDGET);
  const docDigest = buildDigest(
    verifications.map((v) => ({ path: v.docPath, content: v.corrected })),
    DOC_DIGEST_BUDGET
  );

  // 5) Author each section, then self-evaluate + improve it until it converges.
  emit('writing', `0/${sectionPlans.length}`);
  const sections: PersistedWikiSection[] = [];
  const outline = sectionPlans.map((s) => s.titleKey);
  const grounding =
    `Verified documentation (already fact-checked against the code):\n\n${docDigest || '(no documentation found)'}` +
    `\n\nKey code files:\n\n${codeDigest || '(no code files found)'}`;
  const system = `${SECTION_SYSTEM_PROMPT}${langLine(opts.language)}\n\nRepository root: ${trimmedRoot}\nFull wiki outline (do not duplicate other sections): ${outline.join(', ')}.`;

  // The critic scores cited paths against the repo's real file set + key files.
  const keyFileSet = new Set(keyFiles.map((k) => k.path));
  const maxRefine = opts.maxRefineIterations ?? DEFAULT_REFINE_ITERATIONS;
  // The brief is English; the prose may be authored in another language, so the
  // keyword-coverage check only applies when the wiki is written in English
  // (path/grounding checks are language-agnostic and always apply).
  const englishProse = !opts.language || /^en\b/i.test(opts.language);
  // Bind the injected model call to the chosen model and the refine chat shape.
  const boundChat = (sys: string, user: string, signal?: AbortSignal): Promise<string> =>
    deps.chat(opts.model, sys, user, signal);

  for (let i = 0; i < sectionPlans.length; i += 1) {
    throwIfAborted(ctx.signal);
    const plan = sectionPlans[i];
    const facts: WikiCritiqueFacts = {
      files: repoFacts.files,
      keyFiles: keyFileSet,
      expectMermaid: /mermaid/i.test(plan.brief),
      briefKeywords: englishProse ? briefKeywords(plan.brief) : [],
      sectionTitle: plan.titleKey,
    };
    const groundingUser = `Write the "${plan.titleKey}" section.\n\nWhat to cover: ${plan.brief}\n\n${grounding}`;
    let content = '';
    let quality: number | undefined;
    let iterations = 0;
    try {
      // eslint-disable-next-line no-await-in-loop -- sections are authored one at a time so progress streams and a slow model never floods.
      const refined = await refineSection(
        boundChat,
        { system, groundingUser, facts },
        { maxIterations: maxRefine + 1, signal: ctx.signal }
      );
      content = refined.content;
      quality = refined.critique.score;
      iterations = refined.iterations;
      emit('writing', `${i + 1}/${sectionPlans.length} · ${plan.titleKey} · q=${quality.toFixed(2)} · ${iterations}x`);
    } catch (error) {
      content = `> _This section could not be generated: ${error instanceof Error ? error.message : String(error)}_`;
      emit('writing', `${i + 1}/${sectionPlans.length} · ${plan.titleKey} · failed`);
    }
    sections.push({ id: plan.id, titleKey: plan.titleKey, content, quality, iterations });
  }
  emit('writing', `${sectionPlans.length}/${sectionPlans.length}`);

  // 6) Persist durably.
  emit('saving');
  const refinedScores = sections.map((s) => s.quality).filter((q): q is number => typeof q === 'number');
  const meanQuality =
    refinedScores.length > 0 ? refinedScores.reduce((sum, q) => sum + q, 0) / refinedScores.length : undefined;
  const wiki: PersistedWiki = {
    version: PERSISTED_WIKI_VERSION,
    rootPath: trimmedRoot,
    builtAt: now(),
    language: opts.language,
    model: opts.model,
    sections,
    keyFiles: keyFiles.map((k) => k.path),
    docReports: verifications.map((v) => toDocReport(v, rewritten.has(v.docPath))),
    quality: meanQuality,
  };
  await deps.saveWiki(wiki);
  emit('done');

  return { wiki, verifications, rewrittenCount };
};
