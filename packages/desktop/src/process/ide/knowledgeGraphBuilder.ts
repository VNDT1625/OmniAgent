/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Knowledge-graph builder for the IDE "Understand Anything" feature — an in-app
 * adaptation of the Understand-Anything approach (github.com/Lum1104/
 * Understand-Anything, MIT): a **deterministic structural pass** fused with a
 * **semantic LLM pass** to produce a navigable knowledge graph,
 * driven by the user's configured cloud model.
 *
 * The build runs as a five-phase pipeline:
 *   1. `scanning`      — collect the repo's files (injected `collectFiles`).
 *   2. `parsing`       — DETERMINISTIC: extract symbols + language per file and
 *                        reuse {@link buildGraphFromFiles} for the intra-repo
 *                        import graph, then compute each node's in-degree
 *                        (`importedBy`) and a heuristic architectural `layer`.
 *   3. `summarizing`   — SEMANTIC: ask the model (batched, strict-JSON) for a
 *                        plain-English summary + tags + refined layer per file,
 *                        capped to the most-imported files to bound cost.
 *   4. `overview`      — SEMANTIC: one model call writes the project overview.
 *   5. `done`.
 *
 * Everything is dependency-injected (`chat`, `collectFiles`, `now`) so the
 * builder is pure/portable and unit-testable with fakes — no fs, no network, no
 * wasm/tree-sitter. The structural pass is REGEX-based on purpose: web-tree-
 * sitter needs a wasm runtime, so we keep the deterministic extraction
 * dependency-light while still structured (kinds + line numbers).
 *
 * Defensive by contract: malformed model output never throws the whole build —
 * a file simply keeps an empty summary. `ctx.signal` aborts cleanly between
 * phases/batches and returns the partial graph built so far.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs at module scope.
 */

import { buildGraphFromFiles, extractExternals } from './repoGraph';
import { fallbackStringsFor, languageNameForPrompt } from './fallbackSummaryLocale';
import type {
  ArchLayer,
  CodeSymbol,
  ExternalDependency,
  KnowledgeBuildPhase,
  KnowledgeEdge,
  KnowledgeGraph,
  KnowledgeDiagram,
  KnowledgeModule,
  KnowledgeNode,
  ModuleEdge,
  ProjectOverview,
  ProjectRunCommand,
  ProjectRunbook,
} from './understandTypes';

/**
 * Persisted knowledge-graph schema version.
 *
 * v2 added per-node `fingerprint` + `summarySource` (incremental rebuilds + a
 * deterministic fallback summary) and graph-level `externals` (the C4 "Context"
 * level). A v1 graph is still loadable; it simply can't be reused incrementally
 * (every node is treated as changed) until the next full build upgrades it.
 * v3 changes semantic target selection/retrieval scoring enough that older
 * persisted summaries should not be reused for context packs.
 * v4 adds structured runbooks, stored Mermaid diagrams, and semantic module
 * summaries.
 * v5 adds folder relationships and intra-file symbol relationship hints.
 */
export const KNOWLEDGE_GRAPH_VERSION = 5;

/** Default file-context budget distributed across folder-first summary calls. */
const DEFAULT_SUMMARY_CAP = 480;

/** Basenames that usually anchor a project/module even when import degree is low. */
const DEFAULT_IMPORTANT_BASENAMES = new Set([
  'app',
  'application',
  'bootstrap',
  'cli',
  'config',
  'constants',
  'index',
  'main',
  'preload',
  'router',
  'routes',
  'server',
  'types',
]);

/** Path words that usually denote orchestration/entry contracts worth summarizing. */
const DEFAULT_IMPORTANT_PATH_WORDS = [
  'bridge',
  'controller',
  'entry',
  'handler',
  'manager',
  'provider',
  'service',
  'store',
  'workflow',
] as const;

/** Default number of files batched into a single summary model call. */
const DEFAULT_BATCH_SIZE = 12;

/** Default concurrent semantic summary calls during the module/file summary pass. */
const DEFAULT_SUMMARY_CONCURRENCY = 4;

/** Default timeout for one semantic folder-summary batch. */
const DEFAULT_SUMMARY_BATCH_TIMEOUT_MS = 180_000;

/** Maximum per-file character budget when injecting source into a folder summary prompt. */
const PER_FILE_SUMMARY_BUDGET = 1500;

/** Minimum source characters shown for lower-priority files in a folder summary prompt. */
const MIN_FOLDER_FILE_BUDGET = 420;

/** Maximum files from one folder/module included in a folder summary prompt. */
const MAX_FOLDER_CONTEXT_FILES = 14;

/** Maximum module nodes before the architecture map becomes noisy for agents. */
const MAX_LEGIBLE_MODULES = 96;

/** Max symbols retained per file node (keeps the graph payload bounded). */
const MAX_SYMBOLS_PER_FILE = 200;

/** Every architectural layer value (for runtime validation of model output). */
const ARCH_LAYERS: readonly ArchLayer[] = ['api', 'service', 'data', 'ui', 'util', 'config', 'test', 'unknown'];

// ---------------------------------------------------------------------------
// Public types (dependency injection + call surface)
// ---------------------------------------------------------------------------

/** Injected collaborators for {@link createKnowledgeGraphBuilder}. */
export type KnowledgeGraphBuilderDeps = {
  /** Single-shot model call returning the raw completion text. */
  chat: (model: string, system: string, user: string, signal?: AbortSignal) => Promise<string>;
  /** File discovery: returns each repo file's relative path + text content. */
  collectFiles: (rootPath: string) => Promise<Array<{ relPath: string; content: string }>>;
  /** Clock (injected for deterministic tests); defaults to `Date.now`. */
  now?: () => number;
};

/** Tuning knobs for a single {@link KnowledgeGraphBuilder.build} run. */
export type KnowledgeBuildOptions = {
  /** Cap on files sent to the semantic summary pass (default {@link DEFAULT_SUMMARY_CAP}). */
  summaryCap?: number;
  /** Files per summary model call (default {@link DEFAULT_BATCH_SIZE}). */
  batchSize?: number;
  /** Concurrent summary model calls (default {@link DEFAULT_SUMMARY_CONCURRENCY}). */
  summaryConcurrency?: number;
  /** Timeout for one semantic summary batch before falling back deterministically. */
  summaryBatchTimeoutMs?: number;
  /**
   * A previously-built graph to reuse incrementally. Nodes whose file content
   * fingerprint is unchanged AND which already carry an LLM-authored summary are
   * reused verbatim (no model call); only new/changed files are re-analysed.
   * When the project overview can be carried over (no meaningful change), that
   * model call is skipped too.
   */
  previous?: KnowledgeGraph | null;
  /**
   * Display language tag (e.g. `vi-VN`) the semantic text should be written in.
   * Threaded from the renderer's i18n language so summaries/overview match
   * the UI. Incremental reuse only keeps prior summaries when this matches the
   * previous graph's `language`. Defaults to English when omitted.
   */
  language?: string;
};

/** Progress + cancellation hooks for a build. */
export type KnowledgeBuildContext = {
  /** Phase progress callback (UI progress). */
  onPhase?: (phase: KnowledgeBuildPhase, detail?: string) => void;
  /** Abort signal — checked between phases/batches to return a partial graph. */
  signal?: AbortSignal;
};

/** The builder surface returned by {@link createKnowledgeGraphBuilder}. */
export type KnowledgeGraphBuilder = {
  build: (
    rootPath: string,
    model: string,
    opts?: KnowledgeBuildOptions,
    ctx?: KnowledgeBuildContext
  ) => Promise<KnowledgeGraph>;
};

/** One entry parsed from a semantic summary batch reply. */
export type ParsedSummaryEntry = {
  /** File path the entry refers to (matched against node ids when present). */
  path?: string;
  /** Plain-English summary (empty when the model omitted it). */
  summary: string;
  /** Up to 4 topic tags. */
  tags: string[];
  /** Refined architectural layer (only when a valid value was returned). */
  layer?: ArchLayer;
};

// ---------------------------------------------------------------------------
// Deterministic structural pass — language + symbol extraction (regex-based)
// ---------------------------------------------------------------------------

/** Map a relative path's extension to a coarse language id (carries tsx/jsx). */
export const detectLanguage = (relPath: string): string => {
  const lower = relPath.toLowerCase();
  if (lower.endsWith('.tsx')) return 'typescriptreact';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.jsx')) return 'javascriptreact';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.css') || lower.endsWith('.scss') || lower.endsWith('.less')) return 'css';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  const dot = lower.lastIndexOf('.');
  return dot > 0 ? lower.slice(dot + 1) : 'unknown';
};

/** Whether a language id belongs to the JS/TS family (the parsed family). */
const isJsFamily = (language: string): boolean =>
  language.startsWith('typescript') || language.startsWith('javascript');

/** Whether a language id denotes a React (tsx/jsx) file. */
const isReactLanguage = (language: string): boolean => language.endsWith('react');

/** Words that look like a method declaration but are control flow / keywords. */
const NON_METHOD_NAMES = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'do',
  'else',
  'with',
  'await',
  'typeof',
  'new',
  'delete',
  'void',
  'yield',
  'case',
  'super',
]);

/** Regex forms for the structural pass. Group 1 (or the noted group) is the name. */
const CLASS_RE = /(?:^|[\s;])(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g;
const INTERFACE_RE = /(?:^|[\s;])(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g;
const TYPE_RE = /(?:^|[\s;])(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/g;
const ENUM_RE = /(?:^|[\s;])(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g;
const FUNCTION_RE = /(?:^|[\s;])(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
/** Const declarations: 1=`export`?, 2=name, 3=RHS head. */
const CONST_RE = /(?:^|[\s;])(export\s+)?(?:default\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^\n]*)/g;
/** Class methods (indented; modifier-prefixed; `name(...) {`). */
const METHOD_RE =
  /^[ \t]+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|abstract\s+|async\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^={;]+)?\{/gm;

// --- Polyglot structural patterns (best-effort; deterministic) -------------
// Python: `def name(`, `async def name(`, `class Name`.
const PY_DEF_RE = /^[ \t]*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm;
const PY_CLASS_RE = /^[ \t]*class\s+([A-Za-z_]\w*)/gm;
// Rust: `fn name`, `pub fn name`, `struct Name`, `enum Name`, `trait Name`.
const RUST_FN_RE = /(?:^|\s)(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm;
const RUST_STRUCT_RE = /(?:^|\s)(?:pub\s+)?struct\s+([A-Za-z_]\w*)/gm;
const RUST_ENUM_RE = /(?:^|\s)(?:pub\s+)?enum\s+([A-Za-z_]\w*)/gm;
const RUST_TRAIT_RE = /(?:^|\s)(?:pub\s+)?trait\s+([A-Za-z_]\w*)/gm;
// Go: `func name(`, `func (recv) name(`, `type Name struct/interface`.
const GO_FUNC_RE = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm;
const GO_TYPE_RE = /^type\s+([A-Za-z_]\w*)\s+(struct|interface)\b/gm;
// Java: `class Name`, `interface Name`, `enum Name`, methods `modifiers ret name(`.
const JAVA_CLASS_RE = /(?:^|\s)(?:public\s+|final\s+|abstract\s+)*class\s+([A-Za-z_]\w*)/gm;
const JAVA_INTERFACE_RE = /(?:^|\s)(?:public\s+)?interface\s+([A-Za-z_]\w*)/gm;
const JAVA_ENUM_RE = /(?:^|\s)(?:public\s+)?enum\s+([A-Za-z_]\w*)/gm;
const JAVA_METHOD_RE =
  /^[ \t]+(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+|native\s+)+[A-Za-z_][\w<>[\],.\s]*\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws[^{;]+)?\{/gm;

/** Iterate every match of `re` over `content`, guarding zero-length loops. */
const eachMatch = (re: RegExp, content: string, fn: (match: RegExpExecArray) => void): void => {
  re.lastIndex = 0;
  let match = re.exec(content);
  while (match !== null) {
    fn(match);
    if (match.index === re.lastIndex) {
      re.lastIndex += 1;
    }
    match = re.exec(content);
  }
};

/** 1-based line number of a character offset within `content`. */
const lineAt = (content: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
};

const lineCountOf = (content: string): number => (content.length === 0 ? 0 : content.split(/\n/).length);

const lineStartOffsets = (content: string): number[] => {
  const offsets = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) {
      offsets.push(i + 1);
    }
  }
  return offsets;
};

const lineRangeText = (content: string, startLine: number, endLine: number): string => {
  const starts = lineStartOffsets(content);
  const start = starts[Math.max(0, startLine - 1)] ?? 0;
  const end = starts[Math.max(0, endLine)] ?? content.length;
  return content.slice(start, end);
};

export const enrichSymbolRangesAndCalls = (content: string, rawSymbols: CodeSymbol[]): CodeSymbol[] => {
  const totalLines = lineCountOf(content);
  const sorted = rawSymbols.toSorted((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return sorted.map((symbol, index) => {
    const next = sorted[index + 1];
    const endLine = Math.max(symbol.line, (next?.line ?? totalLines + 1) - 1);
    const body = lineRangeText(content, symbol.line, endLine);
    const calls = sorted
      .filter((candidate) => candidate.name !== symbol.name)
      .filter((candidate) => new RegExp(`\\b${escapeRegExp(candidate.name)}\\b`).test(body))
      .map((candidate) => candidate.name)
      .filter((name, nameIndex, names) => names.indexOf(name) === nameIndex)
      .slice(0, 24);
    return {
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      endLine,
      calls,
    };
  });
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a const's RHS head looks like a function (arrow / function / HOC). */
const isFunctionishRhs = (rhs: string): boolean =>
  /^(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(rhs) ||
  /^(async\s+)?function\b/.test(rhs) ||
  /^(?:React\.)?(?:memo|forwardRef)\b/.test(rhs);

/**
 * Extract declared symbols from a non-JS/TS file (Python, Rust, Go, Java) using
 * best-effort language-specific regexes. Deterministic and dependency-free —
 * coarser than tree-sitter but enough to give polyglot repos real symbols
 * instead of empty nodes. De-duplicates by kind+name+line.
 */
const extractPolyglotSymbols = (content: string, language: string): CodeSymbol[] => {
  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: CodeSymbol['kind'], index: number): void => {
    const line = lineAt(content, index);
    const key = `${kind}:${name}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    symbols.push({ name, kind, line });
  };

  if (language === 'python') {
    eachMatch(PY_CLASS_RE, content, (m) => add(m[1], 'class', m.index));
    eachMatch(PY_DEF_RE, content, (m) => add(m[1], 'function', m.index));
  } else if (language === 'rust') {
    eachMatch(RUST_STRUCT_RE, content, (m) => add(m[1], 'class', m.index));
    eachMatch(RUST_ENUM_RE, content, (m) => add(m[1], 'enum', m.index));
    eachMatch(RUST_TRAIT_RE, content, (m) => add(m[1], 'interface', m.index));
    eachMatch(RUST_FN_RE, content, (m) => add(m[1], 'function', m.index));
  } else if (language === 'go') {
    eachMatch(GO_TYPE_RE, content, (m) => add(m[1], m[2] === 'interface' ? 'interface' : 'class', m.index));
    eachMatch(GO_FUNC_RE, content, (m) => add(m[1], 'function', m.index));
  } else if (language === 'java') {
    eachMatch(JAVA_CLASS_RE, content, (m) => add(m[1], 'class', m.index));
    eachMatch(JAVA_INTERFACE_RE, content, (m) => add(m[1], 'interface', m.index));
    eachMatch(JAVA_ENUM_RE, content, (m) => add(m[1], 'enum', m.index));
    eachMatch(JAVA_METHOD_RE, content, (m) => {
      if (!NON_METHOD_NAMES.has(m[1])) add(m[1], 'method', m.index);
    });
  }

  symbols.sort((a, b) => a.line - b.line);
  return enrichSymbolRangesAndCalls(
    content,
    symbols.length > MAX_SYMBOLS_PER_FILE ? symbols.slice(0, MAX_SYMBOLS_PER_FILE) : symbols
  );
};

/**
 * Extract declared symbols from `content` for the given `language`. Regex-based
 * (the deterministic pass — see file header for why we avoid tree-sitter). The
 * JS/TS family is parsed in depth; Python/Rust/Go/Java get a coarser polyglot
 * pass ({@link extractPolyglotSymbols}); other languages yield no symbols.
 * Results are de-duplicated by kind+name+line, sorted by line, and capped.
 */
export const extractSymbols = (content: string, language: string): CodeSymbol[] => {
  if (content.length === 0) {
    return [];
  }
  if (!isJsFamily(language)) {
    return extractPolyglotSymbols(content, language);
  }

  const reactFile = isReactLanguage(language);
  const symbols: CodeSymbol[] = [];
  const seen = new Set<string>();

  const add = (name: string, kind: CodeSymbol['kind'], index: number): void => {
    const line = lineAt(content, index);
    const key = `${kind}:${name}:${line}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    symbols.push({ name, kind, line });
  };

  eachMatch(CLASS_RE, content, (m) => add(m[1], 'class', m.index));
  eachMatch(INTERFACE_RE, content, (m) => add(m[1], 'interface', m.index));
  eachMatch(TYPE_RE, content, (m) => add(m[1], 'type', m.index));
  eachMatch(ENUM_RE, content, (m) => add(m[1], 'enum', m.index));

  eachMatch(FUNCTION_RE, content, (m) => {
    const name = m[1];
    const isComponent = reactFile && /^[A-Z]/.test(name);
    add(name, isComponent ? 'component' : 'function', m.index);
  });

  eachMatch(CONST_RE, content, (m) => {
    const exported = typeof m[1] === 'string' && m[1].length > 0;
    const name = m[2];
    const rhs = (m[3] ?? '').trim();
    const functionish = isFunctionishRhs(rhs);
    const looksLikeComponent =
      /^[A-Z]/.test(name) &&
      functionish &&
      (reactFile || /(?:React\.)?(?:memo|forwardRef)/.test(rhs) || /<[A-Za-z]/.test(rhs));
    if (looksLikeComponent) {
      add(name, 'component', m.index);
    } else if (exported) {
      add(name, 'constant', m.index);
    }
  });

  eachMatch(METHOD_RE, content, (m) => {
    const name = m[1];
    if (NON_METHOD_NAMES.has(name)) {
      return;
    }
    add(name, 'method', m.index);
  });

  symbols.sort((a, b) => a.line - b.line);
  return enrichSymbolRangesAndCalls(
    content,
    symbols.length > MAX_SYMBOLS_PER_FILE ? symbols.slice(0, MAX_SYMBOLS_PER_FILE) : symbols
  );
};

// ---------------------------------------------------------------------------
// Deterministic content fingerprint (pure — no node:crypto, so the builder stays
// portable/unit-testable). FNV-1a over the UTF-16 code units, salted with length.
// ---------------------------------------------------------------------------

/**
 * A stable, fast content hash used for incremental rebuilds. Pure and
 * dependency-free (no `node:crypto`) so {@link createKnowledgeGraphBuilder}
 * remains testable with fakes. Collisions are astronomically unlikely for the
 * "did this file change?" use case; on the off chance two versions of a file
 * collide, the only cost is a stale summary until the next full rebuild.
 */
export const fingerprintOf = (content: string): string => {
  // FNV-1a 32-bit, then fold the length in to widen the effective space.
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= content.charCodeAt(i) >>> 8;
    hash = Math.imul(hash, 0x01000193);
  }
  const h = (hash >>> 0).toString(36);
  return `${content.length.toString(36)}-${h}`;
};

const parsePositiveInteger = (value: string | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const resolveSummaryConcurrency = (model: string, requested?: number): number => {
  if (requested !== undefined) {
    return Math.max(1, Math.min(12, Math.floor(requested)));
  }
  const env = parsePositiveInteger(process.env.AIONUI_UNDERSTAND_SUMMARY_CONCURRENCY);
  if (env !== null) {
    return Math.max(1, Math.min(12, env));
  }
  const normalized = model.toLowerCase();
  if (/\b(opus|o1|o3|reasoning|r1)\b/.test(normalized)) {
    return 3;
  }
  if (/\b(flash|mini|haiku|deepseek|qwen|gemini)\b/.test(normalized)) {
    return 6;
  }
  return DEFAULT_SUMMARY_CONCURRENCY;
};

export const resolveEffectiveSummaryConcurrency = (batchCount: number, concurrencyLimit: number): number => {
  if (batchCount <= 0) {
    return 0;
  }
  const scaled = Math.ceil(batchCount / 3);
  return Math.max(1, Math.min(concurrencyLimit, batchCount, scaled));
};

export const resolveSummaryBatchSize = (requested?: number): number => {
  if (requested !== undefined) {
    return Math.max(1, Math.min(24, Math.floor(requested)));
  }
  const env = parsePositiveInteger(process.env.AIONUI_UNDERSTAND_SUMMARY_BATCH_SIZE);
  return env === null ? DEFAULT_BATCH_SIZE : Math.max(1, Math.min(24, env));
};

const resolveSummaryBatchTimeoutMs = (requested?: number): number => {
  if (requested !== undefined) {
    return Math.max(1_000, Math.min(600_000, Math.floor(requested)));
  }
  const env = parsePositiveInteger(process.env.AIONUI_UNDERSTAND_SUMMARY_BATCH_TIMEOUT_MS);
  return env === null ? DEFAULT_SUMMARY_BATCH_TIMEOUT_MS : Math.max(1_000, Math.min(600_000, env));
};

// ---------------------------------------------------------------------------
// Deterministic structural pass — heuristic architectural layer
// ---------------------------------------------------------------------------

/**
 * Infer an architectural {@link ArchLayer} from a file's path/name. Heuristic,
 * checked most-specific first (test → config → api → data → service → ui →
 * util → unknown) so e.g. a `*.test.tsx` resolves to `test`, not `ui`.
 */
export const inferLayer = (relPath: string): ArchLayer => {
  const p = relPath.replace(/\\/g, '/').toLowerCase();
  const base = p.slice(p.lastIndexOf('/') + 1);
  const segs = p.split('/');
  const hasSeg = (...names: string[]): boolean => names.some((name) => segs.includes(name));

  if (
    /\.(test|spec)\.[a-z0-9]+$/.test(base) ||
    /(?:^|[^a-z])(test|spec)(?:[^a-z]|$)/.test(base) ||
    hasSeg('test', 'tests', '__tests__', 'spec', '__mocks__')
  ) {
    return 'test';
  }
  if (
    /\.config\.[a-z0-9]+$/.test(base) ||
    /^\..*rc(\.[a-z]+)?$/.test(base) ||
    /(tsconfig|webpack|vite\.config|rollup|babel|eslint|prettier|jest|vitest)/.test(base) ||
    hasSeg('config', 'configs')
  ) {
    return 'config';
  }
  if (
    /(?:^|[^a-z])(api|route|router|controller|endpoint|handler)/.test(base) ||
    hasSeg('bridge', 'bridges', 'preload') ||
    hasSeg('api', 'apis', 'routes', 'route', 'controllers', 'endpoints', 'handlers')
  ) {
    return 'api';
  }
  if (
    /(?:^|[^a-z])(model|schema|entity|repository|repo|store|dao)/.test(base) ||
    hasSeg(
      'db',
      'database',
      'models',
      'model',
      'stores',
      'store',
      'repository',
      'repositories',
      'entities',
      'schema',
      'schemas',
      'dao',
      'migrations'
    )
  ) {
    return 'data';
  }
  if (
    /(?:^|[^a-z])(service|usecase|use-case|manager|provider|logic|domain)/.test(base) ||
    hasSeg('process', 'services', 'service', 'usecases', 'use-cases', 'managers', 'providers', 'logic', 'domain')
  ) {
    return 'service';
  }
  if (
    base.endsWith('.tsx') ||
    base.endsWith('.jsx') ||
    /(?:^|[^a-z])(component|page|view|screen|widget|layout)/.test(base) ||
    hasSeg(
      'renderer',
      'components',
      'component',
      'pages',
      'page',
      'views',
      'view',
      'ui',
      'screens',
      'widgets',
      'layouts'
    )
  ) {
    return 'ui';
  }
  if (
    /(?:^|[^a-z])(util|helper|format)/.test(base) ||
    hasSeg('utils', 'util', 'helpers', 'helper', 'lib', 'libs', 'common', 'shared', 'types')
  ) {
    return 'util';
  }
  return 'unknown';
};

// ---------------------------------------------------------------------------
// Deterministic fallback summary — so a file the semantic pass never reached
// reads as explained (name + layer + symbols), not as a blank card. Localized
// to the user's display language (see ./fallbackSummaryLocale).
// ---------------------------------------------------------------------------

/** The most prominent declared symbols, ordered by kind then line (names only). */
const prominentSymbolNames = (symbols: CodeSymbol[]): { names: string[]; more: number } => {
  if (symbols.length === 0) {
    return { names: [], more: 0 };
  }
  const order: CodeSymbol['kind'][] = [
    'component',
    'class',
    'function',
    'interface',
    'type',
    'enum',
    'method',
    'constant',
  ];
  const sorted = [...symbols].toSorted((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.line - b.line);
  const names = sorted.slice(0, 3).map((s) => s.name);
  return { names, more: symbols.length - names.length };
};

/**
 * Compose a deterministic summary for a node from its name, architectural layer,
 * and declared symbols — in the user's display `lang` (English when omitted).
 * Used as a fallback for files the semantic (LLM) pass never reached, so every
 * node reads as explained (and in the right language) rather than blank. Pure.
 */
export const fallbackSummary = (
  node: Pick<KnowledgeNode, 'label' | 'layer' | 'language' | 'symbols' | 'importedBy'>,
  lang?: string
): string => {
  const strings = fallbackStringsFor(lang);
  const langWord = node.language && node.language !== 'unknown' ? `${node.language} ` : '';
  const role = strings.role[node.layer] ?? strings.role.unknown;
  const base = strings.base(node.label, langWord, role);
  const { names, more } = prominentSymbolNames(node.symbols);
  const syms = names.length > 0 ? strings.declares(names, more) : '';
  const imported = node.importedBy > 0 ? strings.importedBy(node.importedBy) : '';
  return `${base}${syms}${imported}`;
};

// ---------------------------------------------------------------------------
// Semantic pass — defensive parsing of model output
// ---------------------------------------------------------------------------

/** Whether a value is a valid {@link ArchLayer}. */
const isArchLayer = (value: unknown): value is ArchLayer =>
  typeof value === 'string' && (ARCH_LAYERS as readonly string[]).includes(value);

/**
 * Best-effort extraction of a JSON array from a model reply. Strips a ```json
 * fence when present, then slices from the first `[` to the last `]`. Returns
 * `null` (never throws) when nothing parseable is found.
 */
const extractJsonArray = (reply: string): unknown => {
  let text = reply.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && typeof fence[1] === 'string') {
    text = fence[1].trim();
  }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

/**
 * Parse a semantic summary batch reply into {@link ParsedSummaryEntry}s.
 * Tolerant of fenced code blocks and surrounding garbage — returns `[]` rather
 * than throwing so a malformed batch never fails the whole build.
 */
export const parseSummaryBatch = (reply: string): ParsedSummaryEntry[] => {
  const arr = extractJsonArray(reply);
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: ParsedSummaryEntry[] = [];
  for (const item of arr) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    const tags: string[] = Array.isArray(obj.tags)
      ? obj.tags.filter((t): t is string => typeof t === 'string').slice(0, 4)
      : [];
    const path = typeof obj.path === 'string' ? obj.path : undefined;
    const layer = isArchLayer(obj.layer) ? obj.layer : undefined;
    out.push({ path, summary, tags, layer });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Semantic pass — prompt composition
// ---------------------------------------------------------------------------

/** Clip text to `budget` chars with a truncation marker. */
const clip = (text: string, budget: number): string =>
  text.length > budget ? `${text.slice(0, budget)}\n[truncated]` : text;

/**
 * A one-line instruction telling the model which natural language to WRITE its
 * output in (summaries/notes/descriptions). Code identifiers, paths, JSON keys,
 * and enum values stay as-is — only the prose is localized. Empty for English
 * (the prompts already default to English).
 */
const langDirective = (lang?: string): string => {
  const name = languageNameForPrompt(lang);
  if (name === 'English') return '';
  return `IMPORTANT: Write every human-readable text value (summaries, notes, descriptions, taglines) in ${name}. Keep all code identifiers, file paths, JSON keys, and enum/layer values exactly as given (do not translate them).\n\n`;
};

const basenameWithoutExtension = (relPath: string): string => {
  const base = relPath.split('/').pop() ?? relPath;
  const dot = base.indexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
};

const pathDepth = (relPath: string): number => relPath.split('/').filter((part) => part.length > 0).length;

const isDefaultImportantFile = (node: KnowledgeNode): boolean => {
  if (node.layer === 'test') {
    return false;
  }
  const pathText = node.id.toLowerCase();
  const base = basenameWithoutExtension(node.id);
  return DEFAULT_IMPORTANT_BASENAMES.has(base) || DEFAULT_IMPORTANT_PATH_WORDS.some((word) => pathText.includes(word));
};

// ---------------------------------------------------------------------------
// Module aggregation (deterministic) — the legible, module-level architecture
// ---------------------------------------------------------------------------

/**
 * Derive the "module" a file belongs to from its path. A module is the file's
 * containing folder up to a sensible depth (so `src/renderer/pages/x/y.ts` →
 * `src/renderer/pages/x`), which keeps the module-level graph to a few dozen
 * nodes instead of hundreds of files. Root files become the `(root)` module.
 */
const moduleIdFor = (relPath: string, depth: number): string => {
  const parts = relPath.split('/');
  if (parts.length <= 1) return '(root)';
  return parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
};

const semanticModuleIdFor = (relPath: string): string => {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length <= 1) return '(root)';
  const fileLess = parts.slice(0, -1);
  const at = (value: string): number => parts.indexOf(value);
  const packagesAt = parts[0] === 'packages' && parts.length >= 4 ? 3 : -1;
  const srcAt = packagesAt >= 0 && parts[packagesAt] === 'src' ? packagesAt : at('src');
  if (srcAt >= 0) {
    const area = parts[srcAt + 1];
    const domain = parts[srcAt + 2];
    const feature = parts[srcAt + 3];
    if (area === 'process') {
      if (domain === 'services' && feature) {
        return parts.slice(0, Math.min(srcAt + 4, parts.length - 1)).join('/');
      }
      if (domain) {
        return parts.slice(0, Math.min(srcAt + 3, parts.length - 1)).join('/');
      }
    }
    if (area === 'renderer') {
      if ((domain === 'pages' || domain === 'components') && feature) {
        return parts.slice(0, Math.min(srcAt + 4, parts.length - 1)).join('/');
      }
      if (domain) {
        return parts.slice(0, Math.min(srcAt + 3, parts.length - 1)).join('/');
      }
    }
    if ((area === 'common' || area === 'preload') && domain) {
      return parts.slice(0, Math.min(srcAt + 3, parts.length - 1)).join('/');
    }
    if (area) {
      return parts.slice(0, Math.min(srcAt + 2, parts.length - 1)).join('/');
    }
  }
  if (parts[0] === 'packages' && parts.length >= 4) {
    return parts.slice(0, Math.min(4, parts.length - 1)).join('/');
  }
  return fileLess.slice(0, Math.min(3, fileLess.length)).join('/') || '(root)';
};

/** The most common layer among a set of nodes (ties broken by layer order). */
const dominantLayer = (nodes: KnowledgeNode[]): ArchLayer => {
  const counts = new Map<ArchLayer, number>();
  for (const node of nodes) counts.set(node.layer, (counts.get(node.layer) ?? 0) + 1);
  let best: ArchLayer = 'unknown';
  let bestCount = -1;
  for (const [layer, count] of counts) {
    if (count > bestCount) {
      best = layer;
      bestCount = count;
    }
  }
  return best;
};

const parentModuleIdFor = (id: string, knownIds: Set<string>): string | undefined => {
  if (id === '(root)') {
    return undefined;
  }
  const parts = id.split('/');
  for (let length = parts.length - 1; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join('/');
    if (knownIds.has(candidate)) {
      return candidate;
    }
  }
  return knownIds.has('(root)') ? '(root)' : undefined;
};

const moduleEntryScore = (node: KnowledgeNode): number =>
  (isDefaultImportantFile(node) ? 100 : 0) + node.importedBy * 6 + (node.symbols.length > 0 ? 2 : 0);

const isTestOnlyModule = (mod: KnowledgeModule, byId: Map<string, KnowledgeNode>): boolean =>
  mod.files.length > 0 && mod.files.every((file) => byId.get(file)?.layer === 'test');

const moduleUnsummarizedCount = (mod: KnowledgeModule, byId: Map<string, KnowledgeNode>): number =>
  mod.files.filter((file) => byId.get(file)?.summarySource !== 'llm').length;

const moduleSourceFileCount = (mod: KnowledgeModule, byId: Map<string, KnowledgeNode>): number =>
  mod.files.filter((file) => byId.get(file)?.layer !== 'test').length;

const moduleEntryWeight = (mod: KnowledgeModule, byId: Map<string, KnowledgeNode>): number =>
  (mod.entryFiles ?? [])
    .map((file) => byId.get(file))
    .filter((node): node is KnowledgeNode => Boolean(node))
    .reduce((score, node) => score + moduleEntryScore(node), 0);

const semanticModuleScore = (id: string, nodes: KnowledgeNode[]): number =>
  nodes.length * 2 +
  nodes.reduce((sum, node) => sum + Math.min(node.importedBy, 12), 0) +
  nodes.filter(isDefaultImportantFile).length * 8 +
  nodes.filter((node) => node.summarySource === 'llm').length * 4 +
  (/\/src\/(process|renderer\/pages|renderer\/components|common|preload)(?:\/|$)/.test(`/${id}`) ? 24 : 0);

const moduleSummaryScore = (
  mod: KnowledgeModule,
  moduleEdges: ModuleEdge[],
  byId: Map<string, KnowledgeNode>
): number => {
  const relationship = moduleEdgeWeight(mod, moduleEdges);
  const unsummarized = moduleUnsummarizedCount(mod, byId);
  const sourceFiles = moduleSourceFileCount(mod, byId);
  const entryWeight = moduleEntryWeight(mod, byId);
  const related = (mod.relatedModuleIds ?? []).length;
  const childCount = (mod.childModuleIds ?? []).length;
  const testPenalty = isTestOnlyModule(mod, byId) ? 80 : 0;
  return (
    relationship * 8 +
    Math.log2(mod.fileCount + 1) * 18 +
    Math.sqrt(unsummarized) * 24 +
    sourceFiles * 3 +
    entryWeight +
    related * 4 +
    childCount * 2 -
    testPenalty
  );
};

const entryFilesForModule = (nodes: KnowledgeNode[]): string[] =>
  nodes
    .toSorted((a, b) => {
      const important = Number(isDefaultImportantFile(b)) - Number(isDefaultImportantFile(a));
      if (important !== 0) {
        return important;
      }
      const relation = moduleEntryScore(b) - moduleEntryScore(a);
      if (relation !== 0) {
        return relation;
      }
      const depth = pathDepth(a.id) - pathDepth(b.id);
      if (depth !== 0) {
        return depth;
      }
      return a.id.localeCompare(b.id);
    })
    .slice(0, 6)
    .map((node) => node.id);

const fingerprintForModule = (
  mod: Pick<KnowledgeModule, 'id' | 'files' | 'parentId' | 'childModuleIds' | 'relatedModuleIds' | 'entryFiles'>,
  byNode: Map<string, KnowledgeNode>,
  moduleEdges: ModuleEdge[]
): string => {
  const fileParts = mod.files
    .map((file) => {
      const node = byNode.get(file);
      return `${file}:${node?.fingerprint ?? ''}`;
    })
    .toSorted();
  const edgeParts = moduleEdges
    .filter((edge) => edge.from === mod.id || edge.to === mod.id)
    .map((edge) => `${edge.from}->${edge.to}:${edge.weight}`)
    .toSorted();
  return fingerprintOf(
    JSON.stringify({
      id: mod.id,
      files: fileParts,
      parentId: mod.parentId ?? null,
      childModuleIds: mod.childModuleIds ?? [],
      relatedModuleIds: mod.relatedModuleIds ?? [],
      entryFiles: mod.entryFiles ?? [],
      edges: edgeParts,
    })
  );
};

/**
 * Aggregate file nodes + import edges into a MODULE-level graph (folder groups),
 * choosing a folder depth that yields a readable number of modules. Pure.
 */
export const aggregateModules = (
  nodes: KnowledgeNode[],
  edges: KnowledgeEdge[]
): { modules: KnowledgeModule[]; moduleEdges: ModuleEdge[] } => {
  const semanticGroups = new Map<string, KnowledgeNode[]>();
  for (const node of nodes) {
    const semanticId = semanticModuleIdFor(node.id);
    const group = semanticGroups.get(semanticId) ?? [];
    group.push(node);
    semanticGroups.set(semanticId, group);
  }
  const keepSemanticIds =
    semanticGroups.size <= MAX_LEGIBLE_MODULES
      ? new Set(semanticGroups.keys())
      : new Set(
          Array.from(semanticGroups.entries())
            .map(([id, group]) => ({ id, score: semanticModuleScore(id, group) }))
            .filter((entry) => entry.score >= 8)
            .toSorted((a, b) => b.score - a.score || a.id.localeCompare(b.id))
            .slice(0, Math.max(12, MAX_LEGIBLE_MODULES - 8))
            .map((entry) => entry.id)
        );
  const moduleOf = new Map<string, string>();
  const byModule = new Map<string, KnowledgeNode[]>();
  for (const node of nodes) {
    const semanticId = semanticModuleIdFor(node.id);
    const mid = keepSemanticIds.has(semanticId) ? semanticId : moduleIdFor(node.id, 1);
    moduleOf.set(node.id, mid);
    const list = byModule.get(mid) ?? [];
    list.push(node);
    byModule.set(mid, list);
  }

  const modules: KnowledgeModule[] = Array.from(byModule.entries())
    .map(([id, group]): KnowledgeModule => {
      const label = id === '(root)' ? '(root)' : (id.split('/').pop() ?? id);
      return {
        id,
        label,
        layer: dominantLayer(group),
        summary: '',
        fileCount: group.length,
        files: group.map((n) => n.id),
      };
    })
    .toSorted((a, b) => b.fileCount - a.fileCount);

  // Aggregate file edges into weighted module edges (drop self-loops).
  const edgeWeights = new Map<string, number>();
  for (const edge of edges) {
    const from = moduleOf.get(edge.from);
    const to = moduleOf.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    edgeWeights.set(key, (edgeWeights.get(key) ?? 0) + 1);
  }
  const moduleEdges: ModuleEdge[] = Array.from(edgeWeights.entries()).map(([key, weight]) => {
    const [from, to] = key.split('\u0000');
    return { from, to, weight };
  });

  const moduleIds = new Set(modules.map((mod) => mod.id));
  const childrenByParent = new Map<string, string[]>();
  for (const mod of modules) {
    const parentId = parentModuleIdFor(mod.id, moduleIds);
    if (!parentId) {
      continue;
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(mod.id);
    childrenByParent.set(parentId, children);
  }
  const relatedByModule = new Map<string, string[]>();
  const addRelated = (from: string, to: string): void => {
    const related = relatedByModule.get(from) ?? [];
    related.push(to);
    relatedByModule.set(from, related);
  };
  for (const edge of moduleEdges) {
    addRelated(edge.from, edge.to);
    addRelated(edge.to, edge.from);
  }

  const byNodeId = new Map(nodes.map((node) => [node.id, node] as const));
  const enrichedModules = modules.map((mod): KnowledgeModule => {
    const group = byModule.get(mod.id) ?? [];
    const parentId = parentModuleIdFor(mod.id, moduleIds);
    const enriched: KnowledgeModule = {
      id: mod.id,
      label: mod.label,
      summary: mod.summary,
      files: mod.files,
      fileCount: mod.fileCount,
      layer: mod.layer,
      parentId,
      childModuleIds: Array.from(new Set(childrenByParent.get(mod.id) ?? [])).toSorted(),
      relatedModuleIds: Array.from(new Set(relatedByModule.get(mod.id) ?? [])).toSorted(),
      entryFiles: entryFilesForModule(group),
    };
    enriched.fingerprint = fingerprintForModule(enriched, byNodeId, moduleEdges);
    return enriched;
  });

  return { modules: enrichedModules, moduleEdges };
};

// ---------------------------------------------------------------------------
// Project overview (semantic, LLM) — the "teach me this project" intro
// ---------------------------------------------------------------------------

const OVERVIEW_SYSTEM_PROMPT =
  'You are a staff engineer onboarding a new teammate to a codebase. From the provided file summaries, ' +
  'manifest/readme excerpts, and module list, write a project overview. Respond with STRICT JSON only: ' +
  '{ "tagline": string, "description": string, "technologies": string[], "entryPoints": string[] }. ' +
  '"tagline" is one sentence on what the project is. "description" is 2-4 short Markdown paragraphs covering ' +
  'its purpose, how it is structured, and how it runs. "technologies" are the main frameworks/languages (max 8). ' +
  '"entryPoints" are up to 6 file paths (from the provided list) a newcomer should read first. No prose outside the JSON.';

/** Parse the overview reply defensively into a {@link ProjectOverview} or null. */
export const parseOverview = (reply: string, knownIds: Set<string>): ProjectOverview | null => {
  let text = reply.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && typeof fence[1] === 'string') text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const tagline = typeof obj.tagline === 'string' ? obj.tagline.trim() : '';
  const description = typeof obj.description === 'string' ? obj.description.trim() : '';
  const technologies = Array.isArray(obj.technologies)
    ? obj.technologies.filter((t): t is string => typeof t === 'string').slice(0, 8)
    : [];
  const entryPoints = Array.isArray(obj.entryPoints)
    ? obj.entryPoints
        .filter((p): p is string => typeof p === 'string' && (knownIds.size === 0 || knownIds.has(normalizeRel(p))))
        .map(normalizeRel)
        .slice(0, 6)
    : [];
  if (tagline.length === 0 && description.length === 0) return null;
  return { tagline, description, technologies, entryPoints };
};

/** Compose the overview user message (top summaries + modules + manifest/readme hints). */
const buildOverviewUser = (
  nodes: KnowledgeNode[],
  modules: KnowledgeModule[],
  contentByPath: Map<string, string>,
  lang?: string
): string => {
  const topFiles = [...nodes].toSorted((a, b) => b.importedBy - a.importedBy).slice(0, 24);
  const fileLines = topFiles.map((n) => `- ${n.id} (${n.layer})${n.summary.length > 0 ? `: ${n.summary}` : ''}`);
  const moduleLines = modules.slice(0, 20).map((m) => `- ${m.id} [${m.layer}] (${m.fileCount} files)`);
  // Include README + package.json-ish manifests verbatim-ish (clipped) for grounding.
  const manifestNames = new Set(['readme.md', 'package.json', 'cargo.toml', 'pyproject.toml', 'go.mod', 'pom.xml']);
  const manifests: string[] = [];
  for (const [path, content] of contentByPath) {
    const base = path.toLowerCase().split('/').pop() ?? '';
    if (manifestNames.has(base) && content.length > 0) {
      manifests.push(`### ${path}\n${clip(content, 1500)}`);
      if (manifests.length >= 3) break;
    }
  }
  return [
    langDirective(lang).trimEnd(),
    `Modules:\n${moduleLines.join('\n')}`,
    `\nKey files:\n${fileLines.join('\n')}`,
    manifests.length > 0 ? `\nManifests / docs:\n${manifests.join('\n\n')}` : '',
  ]
    .filter((s) => s.length > 0)
    .join('\n');
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Normalize a relative path the same way {@link buildGraphFromFiles} does. */
const normalizeRel = (relPath: string): string => relPath.replace(/\\/g, '/').replace(/^\.\//, '');

const dirnameRel = (relPath: string): string => {
  const normalized = normalizeRel(relPath);
  const slash = normalized.lastIndexOf('/');
  return slash > 0 ? normalized.slice(0, slash) : '(root)';
};

const commandKindOf = (name: string): ProjectRunCommand['kind'] => {
  const lower = name.toLowerCase();
  if (lower === 'dev' || lower.includes('dev')) return 'dev';
  if (lower === 'start' || lower.includes('start')) return 'start';
  if (lower.includes('build')) return 'build';
  if (lower.includes('test') || lower.includes('spec')) return 'test';
  if (lower.includes('preview')) return 'preview';
  return 'other';
};

const commandRank = (command: ProjectRunCommand): number => {
  const rank: Record<ProjectRunCommand['kind'], number> = {
    dev: 0,
    start: 1,
    test: 2,
    build: 3,
    preview: 4,
    other: 5,
  };
  return rank[command.kind];
};

const detectPackageManager = (contentByPath: Map<string, string>): string | undefined => {
  for (const [relPath, packageJson] of contentByPath) {
    if (!normalizeRel(relPath).endsWith('package.json')) continue;
    try {
      const parsed = JSON.parse(packageJson) as { packageManager?: unknown };
      if (typeof parsed.packageManager === 'string' && parsed.packageManager.length > 0) {
        return parsed.packageManager.split('@')[0];
      }
    } catch {
      /* malformed package.json — continue with lockfile heuristics */
    }
  }
  const basenames = new Set(Array.from(contentByPath.keys(), (relPath) => normalizeRel(relPath).split('/').pop()));
  if (basenames.has('bun.lock') || basenames.has('bun.lockb')) return 'bun';
  if (basenames.has('pnpm-lock.yaml')) return 'pnpm';
  if (basenames.has('yarn.lock')) return 'yarn';
  if (basenames.has('package-lock.json')) return 'npm';
  return undefined;
};

const commandForScript = (packageManager: string | undefined, script: string): string => {
  const pm = packageManager ?? 'npm';
  if (pm === 'bun' && script === 'start') return 'bun start';
  if (pm === 'npm') return script === 'start' ? 'npm start' : `npm run ${script}`;
  return `${pm} run ${script}`;
};

export const buildRunbook = (contentByPath: Map<string, string>): ProjectRunbook => {
  const packageManager = detectPackageManager(contentByPath);
  const commands: ProjectRunCommand[] = [];
  const env = new Set<string>();
  const ports = new Set<number>();

  for (const [relPath, content] of contentByPath) {
    const normalized = normalizeRel(relPath);
    if (normalized.endsWith('package.json')) {
      try {
        const parsed = JSON.parse(content) as { scripts?: unknown };
        const scripts = parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {};
        for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
          if (typeof value !== 'string') continue;
          const cwd = dirnameRel(normalized);
          commands.push({
            name,
            command: commandForScript(packageManager, name),
            cwd,
            kind: commandKindOf(name),
          });
        }
      } catch {
        /* malformed package.json — skip scripts */
      }
    }

    const envPatterns = [
      /process\.env\.([A-Z][A-Z0-9_]*)/g,
      /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
      /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
    ];
    for (const pattern of envPatterns) {
      for (const match of content.matchAll(pattern)) {
        if (match[1]) env.add(match[1]);
      }
    }

    for (const match of content.matchAll(/\b(?:PORT|port|listen|localhost|127\.0\.0\.1)\D{0,24}([1-9][0-9]{2,4})\b/g)) {
      const port = Number(match[1]);
      if (port >= 100 && port <= 65535) ports.add(port);
    }
  }

  return {
    ...(packageManager ? { packageManager } : {}),
    commands: commands.toSorted((a, b) => commandRank(a) - commandRank(b) || a.cwd.localeCompare(b.cwd)).slice(0, 16),
    env: Array.from(env).toSorted().slice(0, 32),
    ports: Array.from(ports)
      .toSorted((a, b) => a - b)
      .slice(0, 16),
  };
};

type ParsedModuleSummary = {
  id: string;
  summary: string;
  fileSummaries: ParsedSummaryEntry[];
};

const MODULE_SYSTEM_PROMPT =
  'You are summarizing codebase folders for an AI coding agent. For each folder/module, write a compact folder summary ' +
  'that explains its responsibility, key files, and relationships. Also write short summaries for the provided files so ' +
  'agents can answer file-level questions without another model call. Respond with STRICT JSON only: an array of objects ' +
  '{ "id": string, "summary": string, "fileSummaries": [{ "path": string, "summary": string, "tags": string[], ' +
  '"layer": "api"|"service"|"data"|"ui"|"util"|"config"|"test"|"unknown" }] }. No markdown or commentary.';

const parseModuleSummaryBatch = (reply: string): ParsedModuleSummary[] => {
  const arr = extractJsonArray(reply);
  if (!Array.isArray(arr)) return [];
  const out: ParsedModuleSummary[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? normalizeRel(obj.id).trim() : '';
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    const fileSummaries = Array.isArray(obj.fileSummaries)
      ? parseSummaryBatch(JSON.stringify(obj.fileSummaries)).filter((entry) => entry.path && entry.summary.length > 0)
      : [];
    if (id.length > 0 && summary.length > 0) {
      out.push({ id, summary, fileSummaries });
    }
  }
  return out;
};

const moduleEdgeWeight = (mod: KnowledgeModule, moduleEdges: ModuleEdge[]): number =>
  moduleEdges
    .filter((edge) => edge.from === mod.id || edge.to === mod.id)
    .reduce((total, edge) => total + edge.weight, 0);

const moduleContextFileLimit = (mod: KnowledgeModule, moduleEdges: ModuleEdge[]): number => {
  const relationship = moduleEdgeWeight(mod, moduleEdges);
  const sizeWeight = Math.log2(mod.fileCount + 1);
  return Math.max(2, Math.min(MAX_FOLDER_CONTEXT_FILES, Math.ceil(2 + sizeWeight + Math.sqrt(relationship))));
};

const moduleFileBudget = (mod: KnowledgeModule, moduleEdges: ModuleEdge[]): number => {
  const relationship = moduleEdgeWeight(mod, moduleEdges);
  const budget = MIN_FOLDER_FILE_BUDGET + Math.round(Math.sqrt(Math.max(1, mod.fileCount + relationship)) * 120);
  return Math.min(PER_FILE_SUMMARY_BUDGET, budget);
};

const selectModuleSummaryTargets = (
  modules: KnowledgeModule[],
  nodes: KnowledgeNode[],
  moduleEdges: ModuleEdge[],
  summaryCap: number
): KnowledgeModule[] => {
  if (summaryCap <= 0) {
    return [];
  }
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const needsSummary = (mod: KnowledgeModule): boolean =>
    mod.summary.length === 0 || mod.files.some((file) => byId.get(file)?.summarySource !== 'llm');
  const sorted = modules.filter(needsSummary).toSorted((a, b) => {
    const score = moduleSummaryScore(b, moduleEdges, byId) - moduleSummaryScore(a, moduleEdges, byId);
    if (score !== 0) return score;
    const unsummarized = moduleUnsummarizedCount(b, byId) - moduleUnsummarizedCount(a, byId);
    if (unsummarized !== 0) return unsummarized;
    return a.id.localeCompare(b.id);
  });
  const selected: KnowledgeModule[] = [];
  let spent = 0;
  for (const mod of sorted) {
    const cost = moduleContextFileLimit(mod, moduleEdges);
    if (selected.length > 0 && spent + cost > summaryCap) {
      continue;
    }
    selected.push(mod);
    spent += cost;
  }
  return selected;
};

const buildModuleSummaryUser = (
  batch: KnowledgeModule[],
  nodes: KnowledgeNode[],
  moduleEdges: ModuleEdge[],
  contentByPath: Map<string, string>,
  summaryCap: number,
  lang?: string
): string => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const edgeLines = moduleEdges
    .filter((edge) => batch.some((mod) => mod.id === edge.from || mod.id === edge.to))
    .slice(0, 40)
    .map((edge) => `- ${edge.from} -> ${edge.to} (${edge.weight})`);
  const moduleBlocks = batch.map((mod) => {
    const perModuleCap = Math.max(1, Math.floor(Math.max(1, summaryCap) / Math.max(1, batch.length)));
    const fileLimit = Math.min(moduleContextFileLimit(mod, moduleEdges), perModuleCap);
    const charBudget = moduleFileBudget(mod, moduleEdges);
    const entryFiles = new Set(mod.entryFiles ?? []);
    const allFiles = mod.files.map((file) => byId.get(file)).filter((node): node is KnowledgeNode => Boolean(node));
    const unsummarizedFiles = allFiles.filter((node) => node.summarySource !== 'llm');
    const promptFileIds = new Set((unsummarizedFiles.length > 0 ? unsummarizedFiles : allFiles).map((node) => node.id));
    const promptEntryFiles = (mod.entryFiles ?? []).filter((file) => promptFileIds.has(file));
    const files = (unsummarizedFiles.length > 0 ? unsummarizedFiles : allFiles)
      .toSorted((a, b) => {
        const entry = Number(entryFiles.has(b.id)) - Number(entryFiles.has(a.id));
        if (entry !== 0) return entry;
        return b.importedBy - a.importedBy || a.id.localeCompare(b.id);
      })
      .slice(0, fileLimit)
      .map((node) => {
        const content = contentByPath.get(node.id) ?? '';
        const body = content.length > 0 ? clip(content, charBudget) : '[no content available]';
        const syms = node.symbols
          .slice(0, 12)
          .map((s) => `${s.kind} ${s.name}${s.calls && s.calls.length > 0 ? ` -> ${s.calls.join(',')}` : ''}`)
          .join(', ');
        return [
          `  - path: ${node.id}`,
          `    layer: ${node.layer}`,
          `    language: ${node.language}`,
          `    symbols: ${syms.length > 0 ? syms : 'none'}`,
          `    source:`,
          `\`\`\``,
          body,
          `\`\`\``,
        ].join('\n');
      });
    return [
      `id: ${mod.id}`,
      `layer: ${mod.layer}`,
      `fileCount: ${mod.fileCount}`,
      `sourceFileCount: ${moduleSourceFileCount(mod, byId)}`,
      `unsummarizedFileCount: ${moduleUnsummarizedCount(mod, byId)}`,
      `relationshipWeight: ${moduleEdgeWeight(mod, moduleEdges)}`,
      `summaryPriorityScore: ${Math.round(moduleSummaryScore(mod, moduleEdges, byId))}`,
      `parent: ${mod.parentId ?? 'none'}`,
      `children: ${(mod.childModuleIds ?? []).join(', ') || 'none'}`,
      `related: ${(mod.relatedModuleIds ?? []).join(', ') || 'none'}`,
      `entryFiles: ${promptEntryFiles.join(', ') || 'none'}`,
      `contextFileLimit: ${fileLimit}`,
      `perFileCharBudget: ${charBudget}`,
      'files:',
      files.join('\n') || '  - none',
    ].join('\n');
  });
  return [
    langDirective(lang).trimEnd(),
    `Modules:\n${moduleBlocks.join('\n\n')}`,
    edgeLines.length > 0 ? `\nModule edges:\n${edgeLines.join('\n')}` : '',
  ]
    .filter((part) => part.length > 0)
    .join('\n');
};

const fallbackModuleSummary = (mod: KnowledgeModule, nodes: KnowledgeNode[]): string => {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const entryFiles = (mod.entryFiles ?? []).slice(0, 3);
  const related = (mod.relatedModuleIds ?? []).slice(0, 3);
  const unsummarized = moduleUnsummarizedCount(mod, byId);
  const important = mod.files
    .map((file) => byId.get(file))
    .filter((node): node is KnowledgeNode => Boolean(node))
    .toSorted((a, b) => moduleEntryScore(b) - moduleEntryScore(a) || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((node) => node.label);
  const fileText = important.length > 0 ? ` Key files: ${important.join(', ')}.` : '';
  const entryText = entryFiles.length > 0 ? ` Entry paths: ${entryFiles.join(', ')}.` : '';
  const relatedText = related.length > 0 ? ` Related folders: ${related.join(', ')}.` : '';
  const coverageText =
    unsummarized > 0 ? ` ${unsummarized}/${mod.fileCount} files still use deterministic summaries.` : '';
  return `${mod.id} groups ${mod.fileCount} ${mod.layer} file${mod.fileCount === 1 ? '' : 's'}.${fileText}${entryText}${relatedText}${coverageText}`;
};

const mermaidLabel = (value: string): string => value.replace(/"/g, "'");

const mermaidId = (prefix: string, index: number): string => `${prefix}${index}`;

export const buildKnowledgeDiagrams = (
  graph: Pick<KnowledgeGraph, 'overview' | 'modules' | 'moduleEdges' | 'externals' | 'fileCount'>,
  runbook: ProjectRunbook
): KnowledgeDiagram[] => {
  const systemName = mermaidLabel(graph.overview?.tagline ?? 'Codebase');
  const externals = (graph.externals ?? []).slice(0, 6);
  const contextLines = [
    'C4Context',
    `title ${systemName} - System Context`,
    'Person(user, "User", "Uses the application")',
    `System(system, "${systemName}", "Analysed codebase")`,
    'Rel(user, system, "Uses")',
    ...externals.map((external, index) => {
      const id = mermaidId('ext', index);
      return `System_Ext(${id}, "${mermaidLabel(external.name)}", "External dependency used by ${external.usedBy} file(s)")`;
    }),
    ...externals.map((_external, index) => `Rel(system, ${mermaidId('ext', index)}, "Imports")`),
  ];

  const modules = (graph.modules ?? []).slice(0, 10);
  const moduleIds = new Map(modules.map((mod, index) => [mod.id, mermaidId('m', index)] as const));
  const flowLines = [
    'flowchart LR',
    ...modules.map((mod, index) => `${mermaidId('m', index)}["${mermaidLabel(mod.label)}<br/>${mod.fileCount} files"]`),
    ...(graph.moduleEdges ?? [])
      .filter((edge) => moduleIds.has(edge.from) && moduleIds.has(edge.to))
      .slice(0, 18)
      .map((edge) => `${moduleIds.get(edge.from)} -->|${edge.weight}| ${moduleIds.get(edge.to)}`),
  ];

  const commandLines =
    runbook.commands.length > 0
      ? runbook.commands.slice(0, 8).map((command, index) => {
          const id = mermaidId('cmd', index);
          return `${id}["${mermaidLabel(command.name)}<br/>${mermaidLabel(command.command)}"]`;
        })
      : ['noCommands["No run commands detected"]'];
  const runbookLines = ['flowchart TD', 'repo["Repo root"]', ...commandLines];
  for (let index = 0; index < Math.min(runbook.commands.length, 8); index += 1) {
    runbookLines.push(`repo --> ${mermaidId('cmd', index)}`);
  }

  return [
    {
      id: 'c4-context',
      title: 'C4 Context',
      kind: 'c4-context',
      description: 'System boundary, user actor, and top external dependencies.',
      mermaid: contextLines.join('\n'),
    },
    {
      id: 'module-flow',
      title: 'Module Flow',
      kind: 'flow',
      description: 'Top module dependencies aggregated from import edges.',
      mermaid: flowLines.join('\n'),
    },
    {
      id: 'runbook-flow',
      title: 'Runbook Flow',
      kind: 'runbook',
      description: 'Detected commands for running, testing, and building the project.',
      mermaid: runbookLines.join('\n'),
    },
  ];
};

/**
 * Create a knowledge-graph builder bound to the injected `deps`. The returned
 * {@link KnowledgeGraphBuilder.build} runs the deterministic + semantic pipeline
 * described in the file header.
 */
export const createKnowledgeGraphBuilder = (deps: KnowledgeGraphBuilderDeps): KnowledgeGraphBuilder => {
  const now = deps.now ?? ((): number => Date.now());

  const build = async (
    rootPath: string,
    model: string,
    opts?: KnowledgeBuildOptions,
    ctx?: KnowledgeBuildContext
  ): Promise<KnowledgeGraph> => {
    const emit = (phase: KnowledgeBuildPhase, detail?: string): void => ctx?.onPhase?.(phase, detail);
    const aborted = (): boolean => ctx?.signal?.aborted === true;
    const summaryCap = opts?.summaryCap ?? DEFAULT_SUMMARY_CAP;
    const batchSize = resolveSummaryBatchSize(opts?.batchSize);
    const summaryConcurrency = resolveSummaryConcurrency(model, opts?.summaryConcurrency);
    const summaryBatchTimeoutMs = resolveSummaryBatchTimeoutMs(opts?.summaryBatchTimeoutMs);
    const lang = opts?.language;

    const assemble = (
      nodes: KnowledgeNode[],
      edges: KnowledgeEdge[],
      truncated: boolean,
      fileCount: number,
      extra?: {
        modules?: KnowledgeModule[];
        moduleEdges?: ModuleEdge[];
        overview?: ProjectOverview;
        externals?: ExternalDependency[];
        runbook?: ProjectRunbook;
        diagrams?: KnowledgeDiagram[];
      }
    ): KnowledgeGraph => ({
      rootPath,
      version: KNOWLEDGE_GRAPH_VERSION,
      builtAt: now(),
      nodes,
      edges,
      tours: [],
      modules: extra?.modules,
      moduleEdges: extra?.moduleEdges,
      overview: extra?.overview,
      externals: extra?.externals,
      runbook: extra?.runbook,
      diagrams: extra?.diagrams,
      language: lang,
      truncated,
      fileCount,
    });

    // Index the previous graph (if any) for incremental reuse: id → node, and a
    // quick lookup of whether a node already carries an LLM-authored summary.
    // Reuse is only valid when the previous graph was generated in the SAME
    // language — a language switch must re-run the semantic pass.
    const languageMatches = (opts?.previous?.language ?? undefined) === (lang ?? undefined);
    const previousById = new Map<string, KnowledgeNode>();
    if (languageMatches) {
      for (const node of opts?.previous?.nodes ?? []) {
        previousById.set(node.id, node);
      }
    }
    const reusableLlm = (id: string, fingerprint: string): KnowledgeNode | null => {
      const prev = previousById.get(id);
      if (prev && prev.fingerprint === fingerprint && prev.summarySource === 'llm' && prev.summary.length > 0) {
        return prev;
      }
      return null;
    };

    // 1. scanning ----------------------------------------------------------
    emit('scanning');
    const files = await deps.collectFiles(rootPath);
    emit('scanning', `${files.length}/${files.length}`);
    const contentByPath = new Map<string, string>();
    for (const file of files) {
      const rel = normalizeRel(file.relPath);
      if (!contentByPath.has(rel)) {
        contentByPath.set(rel, file.content);
      }
    }
    const runbook = buildRunbook(contentByPath);
    if (aborted()) {
      return assemble([], [], false, 0);
    }

    // 2. parsing (structural, deterministic) -------------------------------
    emit('parsing', `0/${files.length}`);
    const structural = buildGraphFromFiles(rootPath, files);
    const inDegree = new Map<string, number>();
    for (const edge of structural.edges) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
    // Track which nodes were reused from the previous graph (their LLM summary
    // carried over) vs which are new/changed and still need the semantic pass.
    let reusedCount = 0;
    const nodes: KnowledgeNode[] = structural.nodes.map((node): KnowledgeNode => {
      const content = contentByPath.get(node.id) ?? '';
      const language = detectLanguage(node.id);
      const fingerprint = fingerprintOf(content);
      const importedBy = inDegree.get(node.id) ?? 0;
      const reuse = reusableLlm(node.id, fingerprint);
      if (reuse) {
        reusedCount += 1;
        // Carry the expensive LLM fields; refresh the cheap structural ones.
        return {
          id: node.id,
          label: node.label,
          group: node.group,
          layer: reuse.layer,
          summary: reuse.summary,
          summarySource: 'llm',
          tags: reuse.tags,
          symbols: extractSymbols(content, language),
          language,
          importedBy,
          fingerprint,
        };
      }
      return {
        id: node.id,
        label: node.label,
        group: node.group,
        layer: inferLayer(node.id),
        summary: '',
        tags: [],
        symbols: extractSymbols(content, language),
        language,
        importedBy,
        fingerprint,
      };
    });
    emit('parsing', `${nodes.length}/${files.length}`);
    const edges: KnowledgeEdge[] = structural.edges.map((edge) => ({ from: edge.from, to: edge.to }));
    const truncated = structural.truncated;
    const externals: ExternalDependency[] = extractExternals(files);

    if (reusedCount > 0) {
      emit('reusing', `${reusedCount}/${nodes.length}`);
    }

    // Module aggregation (deterministic): the legible, module-level architecture.
    const { modules, moduleEdges } = aggregateModules(nodes, edges);
    const previousModulesById = new Map(
      (languageMatches ? (opts?.previous?.modules ?? []) : []).map((mod) => [mod.id, mod])
    );
    let reusedModuleCount = 0;
    for (const mod of modules) {
      const previousModule = previousModulesById.get(mod.id);
      if (
        previousModule?.fingerprint === mod.fingerprint &&
        typeof previousModule.summary === 'string' &&
        previousModule.summary.length > 0
      ) {
        mod.summary = previousModule.summary;
        reusedModuleCount += 1;
      }
    }
    if (reusedModuleCount > 0) {
      emit('reusing', `${reusedCount}/${nodes.length} files · ${reusedModuleCount}/${modules.length} folders`);
    }

    if (aborted()) {
      return assemble(nodes, edges, truncated, structural.fileCount, { modules, moduleEdges, externals, runbook });
    }

    // 3. modules (semantic, LLM) — folder-first summaries with per-file mini summaries.
    const byNodeId = new Map(nodes.map((node) => [node.id, node] as const));
    const moduleTargets = selectModuleSummaryTargets(modules, nodes, moduleEdges, summaryCap).filter(
      (mod) => mod.summary.length === 0 || moduleUnsummarizedCount(mod, byNodeId) > 0
    );
    const moduleBatches: KnowledgeModule[][] = [];
    for (let i = 0; i < moduleTargets.length; i += batchSize) {
      moduleBatches.push(moduleTargets.slice(i, i + batchSize));
    }
    const summaryWorkerCount = resolveEffectiveSummaryConcurrency(moduleBatches.length, summaryConcurrency);
    emit('summarizing', `0/${moduleBatches.length} batches · ${summaryWorkerCount} workers`);
    let completedSummaryBatches = 0;
    const applyModuleSummaryBatch = (batch: KnowledgeModule[], parsed: ParsedModuleSummary[]): void => {
      const byId = new Map(parsed.map((entry) => [entry.id, entry] as const));
      for (const mod of batch) {
        const entry = byId.get(mod.id);
        if (!entry) {
          continue;
        }
        mod.summary = entry.summary;
        for (const fileSummary of entry.fileSummaries) {
          if (!fileSummary.path) {
            continue;
          }
          const node = byNodeId.get(normalizeRel(fileSummary.path));
          if (!node) {
            continue;
          }
          node.summary = fileSummary.summary;
          node.summarySource = 'llm';
          if (fileSummary.tags.length > 0) {
            node.tags = fileSummary.tags.slice(0, 4);
          }
          if (fileSummary.layer) {
            node.layer = fileSummary.layer;
          }
        }
      }
    };
    const summarizeModuleBatch = async (batch: KnowledgeModule[]): Promise<void> => {
      if (aborted()) {
        return;
      }
      const first = batch[0];
      const batchLabel = first?.id ?? 'unknown';
      const runningDetail = first
        ? `${completedSummaryBatches}/${moduleBatches.length} batches · ${first.id}`
        : `${completedSummaryBatches}/${moduleBatches.length} batches`;
      emit('summarizing', runningDetail);
      const controller = new AbortController();
      const externalSignal = ctx?.signal;
      const abortFromExternal = (): void => controller.abort(externalSignal?.reason);
      if (externalSignal?.aborted) {
        controller.abort(externalSignal.reason);
      } else {
        externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
      }
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const reply = await Promise.race([
          deps.chat(
            model,
            MODULE_SYSTEM_PROMPT,
            buildModuleSummaryUser(batch, nodes, moduleEdges, contentByPath, summaryCap, lang),
            controller.signal
          ),
          new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
              controller.abort();
              reject(new Error(`summary batch timed out after ${summaryBatchTimeoutMs}ms`));
            }, summaryBatchTimeoutMs);
          }),
        ]);
        const parsed = parseModuleSummaryBatch(reply);
        applyModuleSummaryBatch(batch, parsed);
      } catch (error) {
        const message = error instanceof Error && error.message.length > 0 ? error.message : 'summary batch failed';
        if (!aborted()) {
          emit('summarizing', `Summary CLI failed for ${batchLabel}: ${message}; using fallback summaries`);
        }
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        externalSignal?.removeEventListener('abort', abortFromExternal);
        completedSummaryBatches += 1;
        emit('summarizing', `${completedSummaryBatches}/${moduleBatches.length} batches`);
      }
    };
    let nextSummaryBatch = 0;
    const runSummaryWorker = (): Promise<void> => {
      if (aborted()) {
        return Promise.resolve();
      }
      const batch = moduleBatches[nextSummaryBatch];
      nextSummaryBatch += 1;
      if (!batch) {
        return Promise.resolve();
      }
      return summarizeModuleBatch(batch).then(runSummaryWorker);
    };
    const summaryWorkers = Array.from({ length: summaryWorkerCount }, runSummaryWorker);
    await Promise.all(summaryWorkers);
    if (aborted()) {
      return assemble(nodes, edges, truncated, structural.fileCount, { modules, moduleEdges, externals, runbook });
    }

    // Deterministic FALLBACK: any file the folder-first pass did not fill gets a
    // summary derived from its structural metadata, so no node is blank.
    for (const node of nodes) {
      if (node.summary.length === 0) {
        node.summary = fallbackSummary(node, lang);
        node.summarySource = 'fallback';
      }
    }

    // 4. modules fallback/composition.
    emit('modules', `0/${modules.length}`);
    for (const mod of modules) {
      if (mod.summary.length === 0) {
        mod.summary = fallbackModuleSummary(mod, nodes);
      }
    }
    emit('modules', `${modules.length}/${modules.length}`);
    if (aborted()) {
      return assemble(nodes, edges, truncated, structural.fileCount, { modules, moduleEdges, externals, runbook });
    }

    // 5. overview (semantic, LLM) — the "teach me this project" intro -------
    // Carry the previous overview over when nothing semantically changed.
    let overview: ProjectOverview | undefined = moduleTargets.length === 0 ? opts?.previous?.overview : undefined;
    if (!overview) {
      emit('overview', `${modules.length}/${nodes.length}`);
      try {
        const reply = await deps.chat(
          model,
          OVERVIEW_SYSTEM_PROMPT,
          buildOverviewUser(nodes, modules, contentByPath, lang),
          ctx?.signal
        );
        overview = parseOverview(reply, new Set(nodes.map((n) => n.id))) ?? undefined;
      } catch {
        overview = undefined;
      }
    }

    const diagrams = buildKnowledgeDiagrams(
      { overview, modules, moduleEdges, externals, fileCount: structural.fileCount },
      runbook
    );

    // 6. done --------------------------------------------------------------
    emit('done');
    return assemble(nodes, edges, truncated, structural.fileCount, {
      modules,
      moduleEdges,
      overview,
      externals,
      runbook,
      diagrams,
    });
  };

  return { build };
};
