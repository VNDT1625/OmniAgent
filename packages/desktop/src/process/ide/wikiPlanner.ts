/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure planning helpers for the DeepWiki-style "generate a wiki" IDE feature.
 *
 * Generating a useful codebase wiki from an arbitrary repo is fundamentally a
 * SELECTION problem: a repo can hold hundreds of files but a single model call
 * has a finite context budget. This module turns a scanned {@link RepoGraph}
 * (plus a few well-known meta files) into:
 *
 *   1. A ranked shortlist of the most architecturally significant files
 *      ({@link selectKeyFiles}) — entry points, config/manifest files, and the
 *      highest in-degree "hub" modules the rest of the repo imports.
 *   2. A deterministic outline of wiki sections ({@link planWikiSections}) the
 *      model is asked to write, derived from what the repo actually contains
 *      (overview always; architecture + module map when there are modules; data
 *      model / API / build sections when tell-tale files exist).
 *
 * Everything here is a PURE function of its inputs (no fs, no network, no
 * `node:path`) so it is trivially unit-testable and reusable; the bridge does
 * the IO and the model call.
 *
 * Process boundary: Main-process (Node.js) module, but DOM-free and IO-free.
 */

import type { RepoGraph } from './repoGraph';

/** A file the planner deems worth feeding to the model, with why it was picked. */
export type KeyFile = {
  /** Repo-relative, forward-slash path. */
  path: string;
  /** Why this file was selected (drives ordering + the UI "evidence" list). */
  reason: 'entry' | 'manifest' | 'doc' | 'hub' | 'source';
  /** In-degree (how many modules import it); 0 for non-graph meta files. */
  degree: number;
};

/** A single planned wiki section the model is asked to author. */
export type WikiSectionPlan = {
  /** Stable id (anchor / dedupe key). */
  id: string;
  /** i18n key suffix under `ide.wiki.section.*` for the human title. */
  titleKey: string;
  /** Short instruction injected into the prompt telling the model what to cover. */
  brief: string;
};

/** Well-known manifest/config basenames that describe how a repo is built/run. */
const MANIFEST_FILES = new Set([
  'package.json',
  'cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'gemfile',
  'requirements.txt',
  'tsconfig.json',
  'pubspec.yaml',
  'deno.json',
]);

/** Basenames (lowercased) that usually mark a program's entry point. */
const ENTRY_BASENAMES = new Set([
  'index.ts',
  'index.tsx',
  'index.js',
  'main.ts',
  'main.tsx',
  'main.js',
  'main.py',
  'main.go',
  'main.rs',
  'app.ts',
  'app.tsx',
  'app.py',
  'server.ts',
  'server.js',
  'cli.ts',
  'cli.js',
  '__main__.py',
  'mod.rs',
  'lib.rs',
]);

/** Doc basenames worth grounding the overview on. */
const DOC_BASENAMES = new Set(['readme.md', 'readme', 'readme.txt', 'architecture.md', 'contributing.md', 'docs.md']);

/** Tell-tale path fragments that imply a data layer worth its own section. */
const DATA_HINTS = ['schema', 'migration', 'entity', 'entities', 'model', 'models', 'prisma', '.sql'];

/** Tell-tale path fragments that imply an HTTP/API surface worth its own section. */
const API_HINTS = ['route', 'router', 'controller', 'endpoint', 'api/', 'handler', 'graphql', 'resolver'];

/** Basename (last forward-slash segment) of a relative path. */
const basenameOf = (relPath: string): string => {
  const slash = relPath.lastIndexOf('/');
  return slash >= 0 ? relPath.slice(slash + 1) : relPath;
};

/** Compute in-degree (imported-by count) for every node in the graph. */
const inDegrees = (graph: RepoGraph): Map<string, number> => {
  const indeg = new Map<string, number>();
  for (const node of graph.nodes) indeg.set(node.id, 0);
  for (const edge of graph.edges) {
    if (indeg.has(edge.to)) indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  }
  return indeg;
};

/**
 * Rank the most architecturally significant files in a scanned repo.
 *
 * Selection order (highest priority first), de-duplicated by path and capped at
 * `limit`: README/docs, manifest/config files, conventional entry points, then
 * the highest in-degree "hub" modules. Pure function of the graph + the list of
 * meta (non-code) file paths discovered alongside it.
 */
export const selectKeyFiles = (graph: RepoGraph, metaPaths: string[], limit: number): KeyFile[] => {
  const indeg = inDegrees(graph);
  const seen = new Set<string>();
  const picked: KeyFile[] = [];

  const add = (path: string, reason: KeyFile['reason'], degree: number): void => {
    const rel = path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (seen.has(rel) || picked.length >= limit) return;
    seen.add(rel);
    picked.push({ path: rel, reason, degree });
  };

  const allPaths = [...metaPaths.map((p) => p.replace(/\\/g, '/')), ...graph.nodes.map((n) => n.id)];

  const docs = allPaths.filter((path) => DOC_BASENAMES.has(basenameOf(path).toLowerCase()));
  const docQuota = Math.min(docs.length, Math.max(1, Math.floor(limit / 4)));

  // 1) A bounded doc sample — enough for intent without crowding out code.
  for (const path of docs.slice(0, docQuota)) add(path, 'doc', indeg.get(path) ?? 0);
  // 2) Manifests / build config.
  for (const path of allPaths) {
    if (MANIFEST_FILES.has(basenameOf(path).toLowerCase())) add(path, 'manifest', indeg.get(path) ?? 0);
  }
  // 3) Entry points.
  for (const path of graph.nodes.map((n) => n.id)) {
    if (ENTRY_BASENAMES.has(basenameOf(path).toLowerCase())) add(path, 'entry', indeg.get(path) ?? 0);
  }
  // 4) Hubs — most-imported modules, by in-degree desc (stable tiebreak).
  const hubs = [...graph.nodes]
    .map((n) => ({ id: n.id, degree: indeg.get(n.id) ?? 0 }))
    .filter((n) => n.degree > 0)
    .toSorted((a, b) => (b.degree - a.degree !== 0 ? b.degree - a.degree : a.id.localeCompare(b.id)));
  for (const hub of hubs) add(hub.id, 'hub', hub.degree);

  // 5) Fall back to source files for flat repos with no conventional entry or imports.
  for (const node of graph.nodes) add(node.id, 'source', indeg.get(node.id) ?? 0);

  // 6) Reuse any remaining capacity for additional documentation.
  for (const path of docs.slice(docQuota)) add(path, 'doc', indeg.get(path) ?? 0);

  return picked;
};

/** Whether any path in the repo matches one of the given fragment hints. */
const anyPathMatches = (paths: string[], hints: string[]): boolean =>
  paths.some((p) => hints.some((h) => p.toLowerCase().includes(h)));

/**
 * Derive the wiki outline from what the repo actually contains. The overview +
 * architecture + module-map sections are always planned; data-model / API /
 * build sections are added only when matching files exist, so the wiki reflects
 * the real shape of the project rather than a fixed template.
 */
export const planWikiSections = (graph: RepoGraph, metaPaths: string[]): WikiSectionPlan[] => {
  const allPaths = [...metaPaths, ...graph.nodes.map((n) => n.id)];
  const groups = Array.from(new Set(graph.nodes.map((n) => n.group)));

  const sections: WikiSectionPlan[] = [
    {
      id: 'overview',
      titleKey: 'overview',
      brief:
        'A high-level overview: what this project is, the problem it solves, its primary technologies, and how to run it. Ground this in the README and manifest files.',
    },
    {
      id: 'architecture',
      titleKey: 'architecture',
      brief:
        'The system architecture: the major layers/components, how control and data flow between them, and the key design decisions. Include a Mermaid `graph` or `flowchart` diagram of the high-level components.',
    },
  ];

  if (groups.length > 1) {
    sections.push({
      id: 'modules',
      titleKey: 'modules',
      brief: `A module map of the top-level folders (${groups.slice(0, 12).join(', ')}). For each, state its responsibility and its most important files.`,
    });
  }

  if (anyPathMatches(allPaths, DATA_HINTS)) {
    sections.push({
      id: 'dataModel',
      titleKey: 'dataModel',
      brief:
        'The data model: the main entities/tables/schemas, their key fields, and relationships. Include a Mermaid `erDiagram` when the relationships are clear.',
    });
  }

  if (anyPathMatches(allPaths, API_HINTS)) {
    sections.push({
      id: 'api',
      titleKey: 'api',
      brief:
        'The API / interaction surface: the main endpoints, routes, commands, or public entry functions, what they do, and who calls them.',
    });
  }

  sections.push({
    id: 'buildRun',
    titleKey: 'buildRun',
    brief:
      'How to build, run, test, and contribute: scripts/commands, environment requirements, and the developer workflow. Ground this in the manifest and config files.',
  });

  return sections;
};
