/**
 * @license
 * Copyright 2025 Omni Project
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `wikiStore` — DURABLE persistence for the bootstrapped repo wiki.
 *
 * The original DeepWiki tab regenerated its sections from scratch every time and
 * kept them only in React state, so closing the app lost the work. This store
 * persists a {@link PersistedWiki} so a wiki built once survives an app restart
 * and is reused instantly — the "save the wiki so it stays even when the app is
 * closed" requirement.
 *
 * Two locations are written on every save (idempotent, atomic tmp+rename):
 *   1. **App store** — `userData/ide-wiki/<hash>.json`: the machine's cache,
 *      keyed by a stable hash of the repo root, loaded on the next session.
 *   2. **Repo export** — `<repo>/.omni/wiki/wiki.json` plus one `.md` per
 *      article: human-readable, travels with the repo, and can be committed.
 *
 * All filesystem access is INJECTED ({@link WikiStoreDeps}) so the policy
 * (what/where/how to write, schema versioning, atomic replace) is unit-testable
 * with an in-memory fs and the bridge supplies Node `fs` + `userData`.
 *
 * Process boundary: Main-process (Node.js) module, but IO is injected so the
 * module itself stays DOM/Node-free at module scope.
 */

import type { DocVerification } from './docVerify';

/** Schema version of the persisted wiki payload. */
export const PERSISTED_WIKI_VERSION = 1;

/** One authored wiki section, persisted verbatim. */
export type PersistedWikiSection = {
  /** Stable section id (anchor / dedupe key). */
  id: string;
  /** i18n key suffix under `ide.wiki.section.*`, or a raw title for custom sections. */
  titleKey: string;
  /** Authored Markdown body. */
  content: string;
  /** Final self-evaluation score (0..1) of this section, when refined. */
  quality?: number;
  /** Number of improvement passes the refine loop ran for this section. */
  iterations?: number;
};

/** A compact record of one doc's verification (issues only, no full corrected text). */
export type PersistedDocReport = {
  /** Repo-relative doc path. */
  docPath: string;
  /** Number of issues found. */
  issueCount: number;
  /** Number auto-fixed. */
  fixedCount: number;
  /** Whether the corrected doc was written back to disk. */
  rewritten: boolean;
};

/** The full persisted, reusable wiki for one repo. */
export type PersistedWiki = {
  /** Schema version. */
  version: number;
  /** Absolute repo root the wiki was built for. */
  rootPath: string;
  /** Build timestamp (epoch ms). */
  builtAt: number;
  /** Display language the prose was authored in (e.g. `vi-VN`). */
  language?: string;
  /** Model id used to author the sections. */
  model?: string;
  /** Authored sections, in reading order. */
  sections: PersistedWikiSection[];
  /** The key files the wiki was grounded on (paths). */
  keyFiles: string[];
  /** Per-doc verification summary from the bootstrap pass. */
  docReports: PersistedDocReport[];
  /** Mean self-evaluation score across sections (0..1), when refined. */
  quality?: number;
};

/** Injected filesystem + path collaborators (Node `fs` / `path` in production). */
export type WikiStoreDeps = {
  /** Absolute path of the app's per-machine wiki cache directory. */
  appStoreDir: string;
  /** Read a UTF-8 file; reject with an ENOENT-like error when missing. */
  readFile: (filePath: string) => Promise<string>;
  /** Write a UTF-8 file (parent dir guaranteed by {@link WikiStoreDeps.mkdirp}). */
  writeFile: (filePath: string, data: string) => Promise<void>;
  /** Create a directory (recursive). */
  mkdirp: (dir: string) => Promise<void>;
  /** List direct children of a directory. */
  listDir: (dir: string) => Promise<Array<{ name: string; isFile: boolean }>>;
  /** Delete one file; should ignore missing files when possible. */
  deleteFile: (filePath: string) => Promise<void>;
  /** Atomically move a file (rename over an existing target). */
  rename: (from: string, to: string) => Promise<void>;
  /** Join path segments (forward-slash-safe). */
  join: (...segments: string[]) => string;
  /** Stable short hash of a string (filesystem-safe). */
  hash: (value: string) => string;
  /** Whether a thrown error is "file not found". */
  isNotFound: (error: unknown) => boolean;
  /** Monotonic clock for tmp filenames (defaults to Date.now). */
  now?: () => number;
};

/** Slugify a section/title to a filesystem- and link-safe basename. */
const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';

/** Atomic write: tmp then rename, so a reader never sees a half-written file. */
const atomicWrite = async (deps: WikiStoreDeps, target: string, data: string): Promise<void> => {
  const stamp = (deps.now ?? Date.now)();
  const tmp = `${target}.${stamp}.tmp`;
  await deps.writeFile(tmp, data);
  await deps.rename(tmp, target);
};

/** The app-store filename for a repo root. */
const appStoreFile = (deps: WikiStoreDeps, rootPath: string): string =>
  deps.join(deps.appStoreDir, `${deps.hash(rootPath)}.wiki.json`);

/** Render the human-readable `wiki.json` payload exported into the repo. */
const repoExportDir = (deps: WikiStoreDeps, rootPath: string): string => deps.join(rootPath, '.omni', 'wiki');

/** Remove previously generated repo-export files so rebuilds are snapshots, not append-only exports. */
const cleanRepoExport = async (deps: WikiStoreDeps, dir: string): Promise<void> => {
  const entries = await deps.listDir(dir).catch((): Array<{ name: string; isFile: boolean }> => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile)
      .filter((entry) => entry.name === 'wiki.json' || entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => deps.deleteFile(deps.join(dir, entry.name)).catch((): undefined => undefined))
  );
};

/**
 * Persist a wiki to BOTH the app store (cache, keyed by repo hash) and the repo
 * export (`.omni/wiki/`, human-readable + committable). The repo export is
 * best-effort: a read-only or missing repo dir never fails the app-store save.
 */
export const saveWiki = async (deps: WikiStoreDeps, wiki: PersistedWiki): Promise<void> => {
  // 1) App store (authoritative cache).
  await deps.mkdirp(deps.appStoreDir);
  await atomicWrite(deps, appStoreFile(deps, wiki.rootPath), JSON.stringify(wiki));

  // 2) Repo export (best-effort, human-readable).
  try {
    const dir = repoExportDir(deps, wiki.rootPath);
    await deps.mkdirp(dir);
    await cleanRepoExport(deps, dir);
    await atomicWrite(deps, deps.join(dir, 'wiki.json'), JSON.stringify(wiki, null, 2));
    const index: string[] = [`# ${wiki.rootPath.split(/[\\/]/).pop() ?? 'Project'} Wiki`, ''];
    for (const section of wiki.sections) {
      const slug = slugify(section.titleKey);
      index.push(`- [${section.titleKey}](./${slug}.md)`);
      const body = `# ${section.titleKey}\n\n${section.content}\n`;
      // eslint-disable-next-line no-await-in-loop -- sequential export writes keep disk pressure low and ordering deterministic.
      await atomicWrite(deps, deps.join(dir, `${slug}.md`), body);
    }
    await atomicWrite(deps, deps.join(dir, 'README.md'), `${index.join('\n')}\n`);
  } catch {
    // Repo export is a convenience; the app-store copy is the source of truth.
  }
};

/** Load a previously-persisted wiki for a repo root, or `null` when absent/stale. */
export const loadWiki = async (deps: WikiStoreDeps, rootPath: string): Promise<PersistedWiki | null> => {
  try {
    const text = await deps.readFile(appStoreFile(deps, rootPath));
    const parsed = JSON.parse(text) as PersistedWiki;
    if (parsed.version !== PERSISTED_WIKI_VERSION) return null;
    return parsed;
  } catch (error) {
    if (deps.isNotFound(error) || error instanceof SyntaxError) return null;
    throw error;
  }
};

/** Compact a {@link DocVerification} into the persisted report shape. */
export const toDocReport = (verification: DocVerification, rewritten: boolean): PersistedDocReport => ({
  docPath: verification.docPath,
  issueCount: verification.issues.length,
  fixedCount: verification.issues.filter((i) => i.fixed).length,
  rewritten,
});
