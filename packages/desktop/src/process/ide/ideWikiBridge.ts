/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE "generate a wiki" IPC bridge — the DeepWiki-style feature that turns a
 * folder on disk into structured, navigable architecture documentation, the way
 * deepwiki.com does for a public repo.
 *
 * Generating a useful wiki is a two-step job and this bridge exposes it as two
 * channels so the renderer can show real per-section progress:
 *
 *   1. `ide.wiki-plan` — walk the folder (Node `fs`), build the intra-repo
 *      import graph, pick the most architecturally significant files
 *      ({@link selectKeyFiles}), read + budget-clip their contents into a single
 *      grounding "digest", and derive the section outline ({@link planWikiSections})
 *      from what the repo actually contains. Returns the plan + digest.
 *   2. `ide.wiki-section` — author ONE section as Markdown, grounded on the
 *      shared digest, via the user's configured provider ({@link runIdeChat}).
 *      Sections are generated one at a time so a long wiki streams in and a
 *      single failing section never blocks the rest.
 *
 * Splitting generation per-section (rather than one giant completion) keeps each
 * model call inside its context budget and lets the UI render the wiki as it
 * fills in. Both channels return an always-resolving {@link IdeWikiResult}
 * envelope so a failure is observable instead of hanging the renderer.
 *
 * The global bootstrap calls {@link registerIdeWikiBridge} once; this module
 * does not wire itself in (mirrors `ideExplainBridge.ts`).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { buildGraphFromFiles, collectRepoFiles, type RepoGraph } from './repoGraph';
import { planWikiSections, selectKeyFiles, type KeyFile, type WikiSectionPlan } from './wikiPlanner';
import { classifyModelError, runIdeChat, type IdeChatMessage } from './ideProvider';

/** IPC channel names for the IDE wiki surface (renderer-safe contract). */
export const IDE_WIKI_CHANNELS = {
  plan: 'ide.wiki-plan',
  section: 'ide.wiki-section',
} as const;

/** Request for {@link IDE_WIKI_CHANNELS.plan}. */
export type WikiPlanRequest = {
  /** Absolute path of the folder to document. */
  rootPath: string;
  /** Optional hard cap on the number of files walked. */
  maxFiles?: number;
};

/** The plan returned by `ide.wiki-plan`: outline, evidence, and grounding digest. */
export type WikiPlan = {
  /** Sections the model will author, in order. */
  sections: WikiSectionPlan[];
  /** The files chosen to ground the wiki (shown as "evidence" in the UI). */
  keyFiles: KeyFile[];
  /** Budget-clipped concatenation of the key files — shared grounding context. */
  digest: string;
  /** Number of files represented in the scanned graph. */
  fileCount: number;
  /** Number of top-level groups (folders) detected. */
  groupCount: number;
};

/** Request for {@link IDE_WIKI_CHANNELS.section}. */
export type WikiSectionRequest = {
  /** Model id the user picked. */
  model: string;
  /** Repo root, surfaced in the prompt for context. */
  rootPath: string;
  /** Human title of the section being authored. */
  sectionTitle: string;
  /** Instruction describing what the section must cover. */
  brief: string;
  /** The grounding digest from {@link WikiPlan}. */
  digest: string;
  /** Titles of the sections already planned, so the model avoids overlap. */
  outline: string[];
};

/**
 * Result envelope — always resolves. `code: 'no-model'` flags the "no usable
 * model configured" case so the UI can show a targeted hint.
 */
export type IdeWikiResult<T> = { ok: true; data: T } | { ok: false; error: string; code: 'no-model' | 'error' };

/** Typed IDE wiki channels. Exported for bootstrap registration wiring. */
export const ideWikiChannels = {
  plan: bridge.buildProvider<IdeWikiResult<WikiPlan>, WikiPlanRequest>(IDE_WIKI_CHANNELS.plan),
  section: bridge.buildProvider<IdeWikiResult<string>, WikiSectionRequest>(IDE_WIKI_CHANNELS.section),
};

/** Total budget (chars) for the grounding digest across all key files. */
const DIGEST_BUDGET = 22000;
/** Number of key files to ground the wiki on. */
const KEY_FILE_LIMIT = 18;

/** Whether a relative path names a code file (matches repoGraph's parser set). */
const isCodeFile = (relPath: string): boolean => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(relPath);

/** Walk the repo and build {@link RepoGraph} + a map of every walked file's rel path. */
const scan = async (
  rootPath: string,
  maxFiles?: number
): Promise<{ graph: RepoGraph; codeContent: Map<string, string>; metaPaths: string[] }> => {
  const files = await collectRepoFiles(
    rootPath,
    {
      listDir: async (dir) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          fullPath: path.join(dir, entry.name),
          isDir: entry.isDirectory(),
        }));
      },
      readFile: (filePath) => fsp.readFile(filePath, 'utf-8'),
      toRel: (full) => path.relative(rootPath, full).replace(/\\/g, '/'),
    },
    { maxFiles, codeOnly: false }
  );

  const codeFiles = files.filter((f) => isCodeFile(f.relPath));
  const graph = buildGraphFromFiles(rootPath, codeFiles);
  const codeContent = new Map(codeFiles.map((f) => [f.relPath, f.content]));
  const metaPaths = files.filter((f) => !isCodeFile(f.relPath)).map((f) => f.relPath);
  return { graph, codeContent, metaPaths };
};

/** Read a key file's content from the walked map or, for meta files, from disk. */
const readKeyFile = async (rootPath: string, key: KeyFile, codeContent: Map<string, string>): Promise<string> => {
  const cached = codeContent.get(key.path);
  if (typeof cached === 'string') return cached;
  return fsp.readFile(path.join(rootPath, key.path), 'utf-8').catch(() => '');
};

/** Build the shared grounding digest from the selected key files (budget-clipped). */
const buildDigest = async (
  rootPath: string,
  keyFiles: KeyFile[],
  codeContent: Map<string, string>
): Promise<string> => {
  const perFile = keyFiles.length > 0 ? Math.max(400, Math.floor(DIGEST_BUDGET / keyFiles.length)) : DIGEST_BUDGET;
  let remaining = DIGEST_BUDGET;
  const sections: string[] = [];
  for (const key of keyFiles) {
    if (remaining <= 0) break;
    const content = await readKeyFile(rootPath, key, codeContent);
    if (content.length === 0) continue;
    const allowance = Math.min(perFile, remaining);
    const clipped = content.length > allowance ? `${content.slice(0, allowance)}\n[truncated]` : content;
    remaining -= Math.min(content.length, allowance);
    sections.push(`### ${key.path}\n\`\`\`\n${clipped}\n\`\`\``);
  }
  return sections.join('\n\n');
};

/** Plan the wiki: scan, pick key files, build the digest, derive the outline. */
const runPlan = async (req: WikiPlanRequest): Promise<WikiPlan> => {
  const rootPath = req.rootPath?.trim();
  if (!rootPath || rootPath.length === 0) throw new Error('A folder path is required.');

  const { graph, codeContent, metaPaths } = await scan(rootPath, req.maxFiles);
  const keyFiles = selectKeyFiles(graph, metaPaths, KEY_FILE_LIMIT);
  const digest = await buildDigest(rootPath, keyFiles, codeContent);
  const sections = planWikiSections(graph, metaPaths);
  const groupCount = new Set(graph.nodes.map((n) => n.group)).size;

  return { sections, keyFiles, digest, fileCount: graph.fileCount, groupCount };
};

/** System prompt for a single wiki section (technical-writer persona). */
const SECTION_SYSTEM_PROMPT =
  'You are a senior software architect writing a section of a technical wiki for a codebase, in the style of deepwiki.com. ' +
  'Write clear, accurate GitHub-flavored Markdown grounded ONLY in the provided files — never invent APIs, files, or behavior. ' +
  'Reference real file paths in `inline code`. Use Mermaid code fences (```mermaid) for diagrams when the section asks for one. ' +
  'Do NOT repeat a top-level heading for the section (the title is rendered by the app); start directly with the prose and use ### for sub-headings.';

/** Compose the messages for one section completion. */
const buildSectionMessages = (req: WikiSectionRequest): IdeChatMessage[] => {
  const rootLine = `Repository root: ${req.rootPath}`;
  const outlineLine =
    req.outline.length > 0
      ? `Full wiki outline (for context, do not duplicate other sections): ${req.outline.join(', ')}.`
      : '';
  const grounding =
    req.digest.length > 0
      ? `Key files:\n\n${req.digest}`
      : 'No file contents were available; be explicit about uncertainty.';
  return [
    { role: 'system', content: `${SECTION_SYSTEM_PROMPT}\n\n${rootLine}\n${outlineLine}` },
    {
      role: 'user',
      content: `Write the "${req.sectionTitle}" section.\n\nWhat to cover: ${req.brief}\n\n${grounding}`,
    },
  ];
};

/**
 * Register the IDE wiki IPC handlers. Idempotent (re-registration replaces the
 * bound handlers). Intended to be called once during Main-process bootstrap.
 */
export function registerIdeWikiBridge(): void {
  ideWikiChannels.plan.provider(async (req): Promise<IdeWikiResult<WikiPlan>> => {
    try {
      return { ok: true, data: await runPlan(req) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[IdeWikiBridge] wiki-plan failed:', error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  ideWikiChannels.section.provider(async (req): Promise<IdeWikiResult<string>> => {
    try {
      return { ok: true, data: await runIdeChat(req.model, buildSectionMessages(req)) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[IdeWikiBridge] wiki-section failed:', error);
      return { ok: false, error: message, code: classifyModelError(error) };
    }
  });
}

export type { KeyFile, WikiSectionPlan } from './wikiPlanner';
