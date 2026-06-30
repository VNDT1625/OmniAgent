/**
 * @license
 * Copyright 2025 Omni Project
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE "build a durable, verified wiki" IPC bridge — the production-grade upgrade
 * of the DeepWiki tab.
 *
 * Where `ideWikiBridge.ts` exposes the original two-call (plan + per-section)
 * generator that lived only in React state, this bridge runs the full
 * {@link runWikiBootstrap} pipeline and PERSISTS the result so it survives an app
 * restart and is reused instantly:
 *
 *   - `ide.wiki-build`    — scan → VERIFY the docs against the real code (and
 *     auto-fix stale paths/commands) → plan → author each section with a
 *     self-evaluate/improve loop → save to disk. Streams phase progress via the
 *     `ide.wiki-progress` emitter and returns the {@link PersistedWiki}.
 *   - `ide.wiki-load`     — load the previously-built wiki for a repo (or null),
 *     so opening the Wiki tab shows the saved wiki with no model calls.
 *   - `ide.wiki-progress` — Main → renderer phase stream for the live status bar.
 *
 * All Node IO (file walk, doc write-back, persistence) is wired here from the
 * pure/injected modules in `process/ide/wiki/`. Channels return an
 * always-resolving {@link IdeWikiResult} envelope so a failure is observable
 * instead of hanging the renderer. The global bootstrap calls
 * {@link registerWikiBuildBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { collectRepoFiles } from '../repoGraph';
import { classifyModelError, runIdeChat } from '../ideProvider';
import { runWikiBootstrap, type WikiBootstrapDeps, type WikiBootstrapPhase } from './wikiBootstrap';
import { loadWiki, saveWiki, type PersistedWiki, type WikiStoreDeps } from './wikiStore';
import type { IdeWikiResult } from '../ideWikiBridge';

/** IPC channel names for the durable-wiki surface (renderer-safe contract). */
export const WIKI_BUILD_CHANNELS = {
  build: 'ide.wiki-build',
  load: 'ide.wiki-load',
  progress: 'ide.wiki-progress',
} as const;

/** Request for {@link WIKI_BUILD_CHANNELS.build}. */
export type WikiBuildRequest = {
  /** Absolute path of the folder to document. */
  rootPath: string;
  /** Model id to author sections with. */
  model: string;
  /** Display language tag (e.g. `vi-VN`) the prose should be written in. */
  language?: string;
  /** Write corrected docs back to disk (default true). */
  fixDocs?: boolean;
  /** Hard cap on files walked. */
  maxFiles?: number;
  /** Max self-improvement passes per section (default 2). */
  maxRefineIterations?: number;
};

/** Request for {@link WIKI_BUILD_CHANNELS.load}. */
export type WikiLoadRequest = {
  /** Absolute repo root whose persisted wiki to load. */
  rootPath: string;
};

/** A live build-progress update (Main → renderer). */
export type WikiBuildProgress = {
  /** Which phase the build is in. */
  phase: WikiBootstrapPhase;
  /** Optional human-readable detail (counts, current section, quality). */
  detail?: string;
  /** The repo root the build is for (so the UI can correlate runs). */
  rootPath: string;
};

/** Typed durable-wiki channels. Exported for bootstrap registration wiring. */
export const wikiBuildChannels = {
  build: bridge.buildProvider<IdeWikiResult<PersistedWiki>, WikiBuildRequest>(WIKI_BUILD_CHANNELS.build),
  load: bridge.buildProvider<IdeWikiResult<PersistedWiki | null>, WikiLoadRequest>(WIKI_BUILD_CHANNELS.load),
  progress: bridge.buildEmitter<WikiBuildProgress>(WIKI_BUILD_CHANNELS.progress),
};

/** Hard cap on files walked when the caller does not specify one. */
const DEFAULT_MAX_FILES = 600;
/** Hard cap on readable text retained per source/doc file during wiki builds. */
const MAX_READABLE_TEXT_FILE_BYTES = 64_000;
const MAX_PERSISTED_WIKI_BYTES = 2_000_000;

/** Non-code text files whose contents are useful grounding for the wiki. */
const isWikiTextFile = (relPath: string): boolean =>
  /\.(?:md|mdx|txt|rst|adoc|json|ya?ml|toml|xml|gradle|properties)$/i.test(relPath) ||
  /(?:^|\/)(?:gemfile|dockerfile|makefile)$/i.test(relPath);

const readTextFileCapped = async (filePath: string, maxBytes = MAX_READABLE_TEXT_FILE_BYTES): Promise<string> => {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf-8');
  } finally {
    await handle.close();
  }
};

/** Whether a thrown error is a "file not found" (ENOENT). */
const isNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** Stable, filesystem-safe short hash of a string (repo root → cache key). */
const shortHash = (value: string): string => createHash('sha1').update(value).digest('hex').slice(0, 16);

/** Resolve the per-machine wiki cache directory under Electron `userData`. */
const wikiCacheDir = (): string => path.join(app.getPath('userData'), 'ide-wiki');

/** Build the Node-backed {@link WikiStoreDeps} for persistence. */
const nodeWikiStoreDeps = (): WikiStoreDeps => ({
  appStoreDir: wikiCacheDir(),
  readFile: (filePath) => readTextFileCapped(filePath, MAX_PERSISTED_WIKI_BYTES),
  writeFile: (filePath, data) => fsp.writeFile(filePath, data, 'utf-8'),
  mkdirp: async (dir) => {
    await fsp.mkdir(dir, { recursive: true });
  },
  listDir: async (dir) => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isFile: entry.isFile() }));
  },
  deleteFile: (filePath) => fsp.rm(filePath, { force: true }),
  rename: (from, to) => fsp.rename(from, to),
  join: (...segments) => path.join(...segments),
  hash: shortHash,
  isNotFound,
});

/** Build the Node-backed {@link WikiBootstrapDeps} for a build run. */
const nodeBootstrapDeps = (maxFiles: number): WikiBootstrapDeps => ({
  collectFiles: (rootPath) =>
    collectRepoFiles(
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
        readFile: (filePath) => readTextFileCapped(filePath),
        toRel: (full) => path.relative(rootPath, full).replace(/\\/g, '/'),
      },
      {
        maxFiles,
        codeOnly: false,
        readContent: isWikiTextFile,
        maxReadBytes: MAX_READABLE_TEXT_FILE_BYTES,
      }
    ),
  chat: (model, system, user) =>
    runIdeChat(model, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]),
  writeDoc: async (rootPath, relPath, content) => {
    await fsp.writeFile(path.join(rootPath, relPath), content, 'utf-8');
  },
  saveWiki: (wiki) => saveWiki(nodeWikiStoreDeps(), wiki),
});

/**
 * Load the persisted wiki for a repo root using the default on-disk store, or
 * null when none exists. Shared with the team-collab host so a peer can pull the
 * host's wiki read-only without going through the IPC channel.
 */
export const loadWikiForRoot = (rootPath: string): Promise<PersistedWiki | null> =>
  loadWiki(nodeWikiStoreDeps(), rootPath).catch((): PersistedWiki | null => null);

/**
 * Register the durable-wiki IPC handlers. Idempotent (re-registration replaces
 * the bound handlers). Intended to be called once during Main-process bootstrap.
 */
export function registerWikiBuildBridge(): void {
  wikiBuildChannels.build.provider(async (req): Promise<IdeWikiResult<PersistedWiki>> => {
    try {
      const rootPath = req.rootPath?.trim();
      if (!rootPath) throw new Error('A folder path is required.');
      const maxFiles = req.maxFiles ?? DEFAULT_MAX_FILES;
      const result = await runWikiBootstrap(
        rootPath,
        nodeBootstrapDeps(maxFiles),
        {
          model: req.model,
          language: req.language,
          fixDocs: req.fixDocs !== false,
          maxFiles,
          maxRefineIterations: req.maxRefineIterations,
        },
        {
          onPhase: (phase, detail) => wikiBuildChannels.progress.emit({ phase, detail, rootPath }),
        }
      );
      return { ok: true, data: result.wiki };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[WikiBuildBridge] wiki-build failed:', error);
      return { ok: false, error: message, code: classifyModelError(error) };
    }
  });

  wikiBuildChannels.load.provider(async (req): Promise<IdeWikiResult<PersistedWiki | null>> => {
    try {
      const rootPath = req.rootPath?.trim();
      if (!rootPath) return { ok: true, data: null };
      return { ok: true, data: await loadWiki(nodeWikiStoreDeps(), rootPath) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[WikiBuildBridge] wiki-load failed:', error);
      return { ok: false, error: message, code: 'error' };
    }
  });
}

export type { PersistedWiki, PersistedWikiSection, PersistedDocReport } from './wikiStore';
export type { WikiBootstrapPhase } from './wikiBootstrap';
