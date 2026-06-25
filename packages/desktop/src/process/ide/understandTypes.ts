/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared, renderer-safe types for the IDE "Understand Anything" feature — an
 * in-app adaptation of the Understand-Anything approach (github.com/Lum1104/
 * Understand-Anything, MIT): a **deterministic structural pass** (tree-sitter)
 * fused with a **semantic LLM pass** to produce a knowledge graph + navigable
 * wiki, all driven by the user's configured cloud model.
 *
 * These types are plain serialisable data so they cross the IPC bridge to the
 * renderer untouched, and are imported by both the Main-process builders and the
 * renderer views via `import type`.
 *
 * Process boundary: shared module. No DOM / Node APIs at module scope.
 */

/** Architectural layer a file/symbol belongs to (Understand-Anything's layering). */
export type ArchLayer = 'api' | 'service' | 'data' | 'ui' | 'util' | 'config' | 'test' | 'unknown';

/** A symbol (function/class/etc.) extracted from a file by the structural pass. */
export type CodeSymbol = {
  /** Symbol name. */
  name: string;
  /** Kind of declaration. */
  kind: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum' | 'constant' | 'component';
  /** 1-based start line in the file. */
  line: number;
  /** 1-based inclusive end line in the file, inferred deterministically. */
  endLine?: number;
  /** Symbols in the same file this symbol appears to call/use. */
  calls?: string[];
};

/**
 * Where a node's `summary` came from. `llm` = the semantic pass authored it;
 * `fallback` = a deterministic sentence derived from name/layer/tags/symbols
 * (so a file the LLM never reached still reads as explained, not blank); empty
 * for legacy graphs built before the field existed.
 */
export type SummarySource = 'llm' | 'fallback';

/** A node in the knowledge graph — one file in the repo. */
export type KnowledgeNode = {
  /** Relative file path (forward-slash). Stable identity. */
  id: string;
  /** Basename shown as the node label. */
  label: string;
  /** Top-level folder (used for grouping/colour). */
  group: string;
  /** Architectural layer (semantic pass; defaults to a heuristic). */
  layer: ArchLayer;
  /** Plain-English one-paragraph summary of what the file is for (semantic pass). */
  summary: string;
  /** Provenance of {@link summary} (LLM vs deterministic fallback). */
  summarySource?: SummarySource;
  /** Short tags (semantic pass). */
  tags: string[];
  /** Symbols declared in the file (structural pass). */
  symbols: CodeSymbol[];
  /** Detected language (by extension). */
  language: string;
  /** In-degree (how many files import this one) — filled at graph-build time. */
  importedBy: number;
  /**
   * Stable content hash of the file (deterministic, pure — no node:crypto).
   * Powers incremental rebuilds: when a file's fingerprint is unchanged AND its
   * summary already came from the LLM, the expensive semantic pass is skipped
   * and the previous node is reused verbatim.
   */
  fingerprint?: string;
};

/** A directed edge: `from` imports `to` (both relative paths). */
export type KnowledgeEdge = {
  from: string;
  to: string;
};

/** Legacy guided-tour step retained for persisted graph compatibility. */
export type TourStep = {
  /** File the step focuses on (node id). */
  nodeId: string;
  /** Why this file matters / what to notice (semantic pass). */
  note: string;
};

/** A guided learning tour (ordered by dependency / importance). */
export type GuidedTour = {
  /** Tour title. */
  title: string;
  /** Ordered steps. */
  steps: TourStep[];
};

/** Status of a knowledge-graph build (for the progress UI). */
export type KnowledgeBuildPhase =
  | 'idle'
  | 'scanning'
  | 'parsing'
  | 'reusing'
  | 'summarizing'
  | 'modules'
  | 'overview'
  | 'done'
  | 'error';

/**
 * An external dependency the repo imports (a bare/package specifier such as
 * `react` or `@scope/pkg`). Deterministically extracted so the C4 "Context"
 * level can show real system boundaries instead of guesses.
 */
export type ExternalDependency = {
  /** Package name (bare specifier, scope kept: `@scope/pkg`). Stable identity. */
  name: string;
  /** How many repo files import it (popularity → node size). */
  usedBy: number;
};

/** The full knowledge graph persisted per repo (mirrors Understand-Anything's knowledge-graph.json). */
export type KnowledgeGraph = {
  /** Absolute repo root the graph was built for. */
  rootPath: string;
  /** Schema version. */
  version: number;
  /** Build timestamp (epoch ms). */
  builtAt: number;
  /** File nodes. */
  nodes: KnowledgeNode[];
  /** Import edges. */
  edges: KnowledgeEdge[];
  /** Legacy guided tours. New builds keep this empty. */
  tours: GuidedTour[];
  /** Plain-English project overview (the "teach me" intro). Optional for older graphs. */
  overview?: ProjectOverview;
  /** Module-level aggregation (folder groups) — the legible architecture view. */
  modules?: KnowledgeModule[];
  /** Module-level import edges (aggregated, weighted). */
  moduleEdges?: ModuleEdge[];
  /** Top external/package dependencies (for the C4 "Context" level). */
  externals?: ExternalDependency[];
  /** Structured commands/env/ports for running and testing this repo. */
  runbook?: ProjectRunbook;
  /** Mermaid diagrams generated from graph/runbook evidence. */
  diagrams?: KnowledgeDiagram[];
  /**
   * BCP-47-ish language code the semantic text (summaries/overview) was
   * generated in (e.g. `vi-VN`, `en-US`). Drives incremental reuse: when the
   * user's display language changed since the last build, prior LLM summaries
   * (in the old language) are NOT reused — they're re-generated in the new one.
   */
  language?: string;
  /**
   * Git commit hash the graph was built at (when the repo is a git checkout).
   * Powers the time dimension: two snapshots from different commits can be
   * diffed ({@link GraphDiff}) to show which relationships changed between a
   * "known-good" commit and a "broken" one — a localisation hint for bug fixing
   * (NOT a bug detector; git-bisect + tests find the breaking commit).
   */
  commitHash?: string;
  /** Whether the node set was capped (very large repo). */
  truncated: boolean;
  /** Number of files represented. */
  fileCount: number;
};

/** A single article in the generated wiki (Karpathy-pattern). */
export type WikiArticle = {
  /** Stable slug id (kebab-case). */
  id: string;
  /** Human title. */
  title: string;
  /** Markdown body (may contain `[[wiki]]` links to other article titles). */
  body: string;
  /** Article slugs/titles this one links to (outgoing wikilinks). */
  links: string[];
  /** Category for clustering. */
  category: string;
};

/** The full generated wiki for a repo. */
export type RepoWiki = {
  rootPath: string;
  version: number;
  builtAt: number;
  articles: WikiArticle[];
};

/** A high-level project summary (the "teach me this codebase" intro). */
export type ProjectOverview = {
  /** One-sentence "what is this project" line. */
  tagline: string;
  /** A few short paragraphs (Markdown) explaining purpose, stack, how it runs. */
  description: string;
  /** Primary technologies / frameworks detected (short chips). */
  technologies: string[];
  /** 3–6 "where to start" entry-point file paths (node ids). */
  entryPoints: string[];
};

/** A detected command that helps run, build, test, or preview the project. */
export type ProjectRunCommand = {
  /** Human command name, usually a package script name. */
  name: string;
  /** Command line a user/agent can run from the repo root. */
  command: string;
  /** Relative manifest/path that defined the command. */
  cwd: string;
  /** Coarse command purpose. */
  kind: 'dev' | 'start' | 'build' | 'test' | 'preview' | 'other';
};

/** Structured run instructions detected during Understand build. */
export type ProjectRunbook = {
  /** Detected package manager when known. */
  packageManager?: string;
  /** Important commands, capped and ranked for agent use. */
  commands: ProjectRunCommand[];
  /** Environment variable names referenced by source/config files. */
  env: string[];
  /** Port numbers referenced by source/config files. */
  ports: number[];
};

/** A generated codebase diagram stored with the graph and renderable as Mermaid. */
export type KnowledgeDiagram = {
  /** Stable id for selection/rendering. */
  id: string;
  /** Human title. */
  title: string;
  /** Diagram family. */
  kind: 'c4-context' | 'flow' | 'runbook';
  /** Short description of what the diagram explains. */
  description: string;
  /** Mermaid source. */
  mermaid: string;
};

/** An aggregated module = a folder/group of files, the module-level graph unit. */
export type KnowledgeModule = {
  /** Stable id (the folder path, or layer name for flat repos). */
  id: string;
  /** Human label (folder name). */
  label: string;
  /** Dominant architectural layer of the files inside. */
  layer: ArchLayer;
  /** One-line plain-English role of this module (semantic pass, may be empty). */
  summary: string;
  /** Stable fingerprint of files + module relationships for incremental summary reuse. */
  fingerprint?: string;
  /** Number of files in the module. */
  fileCount: number;
  /** Node ids (file paths) belonging to this module. */
  files: string[];
  /** Parent module/folder id when this module is nested. */
  parentId?: string;
  /** Child module/folder ids directly nested below this module. */
  childModuleIds?: string[];
  /** Related module ids aggregated from import edges. */
  relatedModuleIds?: string[];
  /** Important files that anchor this folder/module. */
  entryFiles?: string[];
};

/** A directed edge between two modules (aggregated from file import edges). */
export type ModuleEdge = {
  from: string;
  to: string;
  /** How many underlying file imports this module edge aggregates (weight). */
  weight: number;
};

/** Result envelope shared by IDE-understand bridge channels (always resolves). */
export type UnderstandResult<T> = { ok: true; data: T } | { ok: false; error: string; code: 'no-model' | 'error' };

/**
 * C4-model abstraction levels (Simon Brown's C4) the knowledge graph can be
 * viewed at, from coarsest to finest:
 *  - `context`   — the system + its actors and external dependencies.
 *  - `container` — top-level deployable/source units (top folders / packages).
 *  - `component` — modules (folder groups) — the legible architecture.
 *  - `code`      — individual files (the raw structural graph).
 */
export type C4Level = 'context' | 'container' | 'component' | 'code';

/**
 * A live repo-change notification (realtime mode). Lists the relative paths
 * that were added/changed/removed since the last emit, debounced in the watcher.
 */
export type RepoChangeEvent = {
  /** Absolute repo root the change belongs to. */
  rootPath: string;
  /** Relative paths (forward-slash) that changed (added or modified). */
  changed: string[];
  /** Relative paths (forward-slash) that were removed. */
  removed: string[];
};

/**
 * The result of a diff-impact analysis: which nodes changed directly and which
 * are transitively affected because they (in)directly import a changed file.
 */
export type ImpactResult = {
  /** Node ids that changed directly. */
  changed: string[];
  /** Node ids transitively impacted (dependents of changed nodes). */
  impacted: string[];
};

/**
 * The difference between two knowledge-graph snapshots (an older "from" graph
 * and a newer "to" graph). Used as a localisation HINT during bug fixing: when
 * something worked at commit A but breaks at commit B, this shows which files +
 * relationships changed between them so the agent can focus, instead of reading
 * the whole repo. It is NOT a bug detector — git-bisect + tests find the
 * breaking commit; this narrows the suspects within it.
 */
export type GraphDiff = {
  /** `commitHash` of the older graph (or undefined when not a git checkout). */
  fromCommit?: string;
  /** `commitHash` of the newer graph. */
  toCommit?: string;
  /** Build timestamps of the two graphs. */
  fromBuiltAt: number;
  toBuiltAt: number;
  /** Node ids present in `to` but not `from` (files added). */
  addedNodes: string[];
  /** Node ids present in `from` but not `to` (files removed). */
  removedNodes: string[];
  /** Node ids present in both but whose content fingerprint changed. */
  changedNodes: string[];
  /** Edges (`from→to`) present in `to` but not `from` (new dependencies). */
  addedEdges: KnowledgeEdge[];
  /** Edges present in `from` but not `to` (removed dependencies). */
  removedEdges: KnowledgeEdge[];
};

/**
 * One slice of code selected for an agent's context — a file (or a trimmed
 * region of it) the Context Builder judged relevant to the request. The point
 * of the Context Builder is to hand the agent ONLY these slices (a few relevant
 * functions) instead of whole files, so the agent is both more accurate and far
 * cheaper in tokens.
 */
export type ContextSlice = {
  /** Relative path of the source file. */
  path: string;
  /** Architectural layer (for ordering / display). */
  layer: ArchLayer;
  /** Why this slice was included (for transparency / debugging the builder). */
  reason: 'seed' | 'dependency' | 'dependent' | 'changed' | 'entry';
  /** Relevance score (higher = more relevant); seeds rank highest. */
  score: number;
  /** Plain-English one-line summary of the file (from the graph, when present). */
  summary: string;
  /** Symbols in this slice (names + line numbers) the agent should look at. */
  symbols: CodeSymbol[];
  /** Source chunks that matched the request most closely, when semantic indexing is available. */
  chunks?: Array<{
    startLine: number;
    endLine: number;
    preview: string;
    score: number;
  }>;
};

/**
 * The assembled "context pack" the Context Builder produces for one agent
 * request. Deterministic given the same graph + request + budget. The renderer
 * attaches `renderedContext` to the conversation so the agent sees a compact,
 * pre-focused brief instead of the whole repo.
 */
export type ContextPack = {
  /** The user request the pack was built for. */
  request: string;
  /** Selected slices, most-relevant first. */
  slices: ContextSlice[];
  /** Project rules (from `.aionrules` etc.) prepended to the agent brief. */
  rules: string[];
  /** A ready-to-inject Markdown brief composed from the slices + rules. */
  renderedContext: string;
  /** Number of slices included (after the budget cap). */
  sliceCount: number;
  /** Whether the selection was capped by the budget. */
  truncated: boolean;
};
