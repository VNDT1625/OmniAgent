/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE "Understand Anything" knowledge-graph IPC bridge — turns a folder on disk
 * into a navigable knowledge graph by fusing a DETERMINISTIC
 * structural pass with a SEMANTIC LLM pass ({@link createKnowledgeGraphBuilder}),
 * driven by the user's configured cloud model.
 *
 * Channels:
 *   - `ide.kg-build` — run the builder for a repo. Streams per-phase progress
 *     through the `ide.kg-event` emitter (the {@link KnowledgeBuildPhase} payload
 *     is BOXED in an `{ event }` envelope, the same trick `codeAgentBridge` uses
 *     to keep the platform `buildEmitter<Params>` conditional non-distributive).
 *     Returns an always-resolving {@link UnderstandResult} and persists the built
 *     graph to `userData/ide-knowledge/<hash>.json` (atomic tmp+rename).
 *   - `ide.kg-get` — load a previously-persisted graph for a repo (or `null`).
 *
 * The renderer cannot call model providers directly (CORS / `webSecurity`), so —
 * exactly like `ideExplainBridge` / `studioChatBridge` — completions are issued
 * from the Main process against the user's configured provider over the
 * OpenAI-compatible `/chat/completions` endpoint (resolved lazily per call so a
 * model added after startup is picked up without a restart). File discovery uses
 * Node `fs` injected into {@link collectRepoFiles}.
 *
 * The global bootstrap calls {@link registerKnowledgeGraphBridge} once; this
 * module does not wire itself in (mirrors `ideWikiBridge.ts`).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import { hasSpecificModelCapability } from '@/common/utils/modelCapabilities';
import { runAgentChatMessages } from '@process/services/agentChat';
import type { ChatMessageInput } from '@process/browser/webAgentRunner';
import { collectRepoFiles } from './repoGraph';
import {
  createKnowledgeGraphBuilder,
  KNOWLEDGE_GRAPH_VERSION,
  detectLanguage,
  enrichSymbolRangesAndCalls,
  extractSymbols,
  fingerprintOf,
  inferLayer,
  type KnowledgeBuildContext,
  type KnowledgeGraphBuilderDeps,
} from './knowledgeGraphBuilder';
import { createRepoWatcher, type FsWatcherHandle, type RawWatchEventType } from './repoWatcher';
import { diffGraphs } from './graphSnapshot';
import { assessGraphFreshness, type GraphFreshness } from './graphFreshness';
import { createContextBuilder } from './contextBuilder';
import {
  buildVectorIndex,
  createVectorRanker,
  isVectorIndexFresh,
  type Embedder,
  type VectorIndex,
} from './vectorIndex';
import type {
  ContextPack,
  GraphDiff,
  KnowledgeBuildPhase,
  KnowledgeGraph,
  KnowledgeNode,
  RepoChangeEvent,
  UnderstandResult,
} from './understandTypes';
import { execFile } from 'node:child_process';

/** IPC channel names for the IDE knowledge-graph surface (renderer-safe contract). */
export const KNOWLEDGE_CHANNELS = {
  build: 'ide.kg-build',
  status: 'ide.kg-status',
  get: 'ide.kg-get',
  event: 'ide.kg-event',
  watchStart: 'ide.kg-watch-start',
  watchStop: 'ide.kg-watch-stop',
  changed: 'ide.kg-changed',
  diff: 'ide.kg-diff',
  context: 'ide.kg-context',
  refreshFile: 'ide.kg-refresh-file',
} as const;

/** Request for {@link KNOWLEDGE_CHANNELS.build}. */
export type KnowledgeBuildRequest = {
  /** Absolute path of the folder to analyse. */
  rootPath: string;
  /** Model id the user picked in the panel. */
  model: string;
  /** Display language tag (e.g. `vi-VN`) the semantic text should be written in. */
  language?: string;
  /** Build without reusing the previous persisted graph. */
  forceFresh?: boolean;
};

/** Request for {@link KNOWLEDGE_CHANNELS.status}. */
export type KnowledgeStatusRequest = {
  /** Absolute path of the folder whose active build status should be returned. */
  rootPath: string;
};

/** Snapshot of a currently-running background knowledge-graph build. */
export type KnowledgeBuildStatus = {
  /** Whether a build is running for this repo. */
  running: boolean;
  /** Whether another build request is coalesced and will run after the active one. */
  queued?: boolean;
  /** Current phase of the active build. */
  phase: KnowledgeBuildPhase;
  /** Optional human detail for the current phase. */
  detail?: string;
  /** Phase history recorded by the Main process so renderers can reattach after reload. */
  events: Array<{ phase: KnowledgeBuildPhase; detail?: string; at: number }>;
  /** Freshness of the persisted graph when no build is running. */
  freshness?: GraphFreshness;
};

/** Request for {@link KNOWLEDGE_CHANNELS.get}. */
export type KnowledgeGetRequest = {
  /** Absolute path of the folder whose persisted graph to load. */
  rootPath: string;
};

/** Request for {@link KNOWLEDGE_CHANNELS.watchStart}. */
export type KnowledgeWatchStartRequest = {
  /** Absolute path of the folder to watch for live changes. */
  rootPath: string;
  /** Deprecated: Live mode no longer spends model tokens automatically. */
  model?: string | null;
  /** Deprecated: semantic language is only used by explicit build requests. */
  language?: string;
};

/** Request for {@link KNOWLEDGE_CHANNELS.watchStop}. */
export type KnowledgeWatchStopRequest = {
  /** Absolute path of the folder to stop watching (informational). */
  rootPath: string;
};

/**
 * Envelope wrapping a streamed repo-change event (Live mode). Boxed for the same
 * non-distributive `buildEmitter` reason as {@link KnowledgeEventEnvelope}.
 */
export type KnowledgeChangedEnvelope = {
  /** The debounced batch of changed/removed relative paths. */
  event: RepoChangeEvent;
};

/** Request for {@link KNOWLEDGE_CHANNELS.diff}: diff the two most recent snapshots. */
export type KnowledgeDiffRequest = {
  /** Absolute repo path whose snapshot history to diff. */
  rootPath: string;
};

/** Request for {@link KNOWLEDGE_CHANNELS.context}: build a focused context pack. */
export type KnowledgeContextRequest = {
  /** Absolute repo path (loads its persisted graph). */
  rootPath: string;
  /** The user request to focus the pack on. */
  request: string;
  /** Project rules to prepend (e.g. from `.aionrules`). Optional. */
  rules?: string[];
  /** Include the latest regression diff as changed-boost context. Default true. */
  includeDiff?: boolean;
};

/**
 * Request for {@link KNOWLEDGE_CHANNELS.refreshFile}: deterministically refresh
 * ONE file's structural node (symbols/language/fingerprint) in the persisted
 * graph after an edit — no model call, so it is free to run on every save.
 */
export type KnowledgeRefreshFileRequest = {
  /** Absolute repo path (the persisted graph to patch). */
  rootPath: string;
  /** Repo-relative path (forward-slash) of the edited file. */
  relPath: string;
  /** The file's current text content. */
  content: string;
  /** When true, also regenerate the file's semantic summary via the model. */
  summarize?: boolean;
  /** Model id to use when `summarize` is true (falls back to a usable default). */
  model?: string;
};

/**
 * Envelope wrapping a streamed build-phase event. Boxing the payload keeps the
 * platform `buildEmitter<Params>` conditional non-distributive (same reason as
 * `codeAgentBridge.CodeAgentEventEnvelope`).
 */
export type KnowledgeEventEnvelope = {
  /** The streamed phase-progress event. */
  event: { phase: KnowledgeBuildPhase; detail?: string; rootPath?: string };
};

/** Typed knowledge-graph channels. Exported for bootstrap registration wiring. */
export const knowledgeChannels = {
  build: bridge.buildProvider<UnderstandResult<KnowledgeGraph>, KnowledgeBuildRequest>(KNOWLEDGE_CHANNELS.build),
  status: bridge.buildProvider<UnderstandResult<KnowledgeBuildStatus>, KnowledgeStatusRequest>(
    KNOWLEDGE_CHANNELS.status
  ),
  get: bridge.buildProvider<UnderstandResult<KnowledgeGraph | null>, KnowledgeGetRequest>(KNOWLEDGE_CHANNELS.get),
  event: bridge.buildEmitter<KnowledgeEventEnvelope>(KNOWLEDGE_CHANNELS.event),
  watchStart: bridge.buildProvider<UnderstandResult<boolean>, KnowledgeWatchStartRequest>(
    KNOWLEDGE_CHANNELS.watchStart
  ),
  watchStop: bridge.buildProvider<UnderstandResult<boolean>, KnowledgeWatchStopRequest>(KNOWLEDGE_CHANNELS.watchStop),
  changed: bridge.buildEmitter<KnowledgeChangedEnvelope>(KNOWLEDGE_CHANNELS.changed),
  diff: bridge.buildProvider<UnderstandResult<GraphDiff | null>, KnowledgeDiffRequest>(KNOWLEDGE_CHANNELS.diff),
  context: bridge.buildProvider<UnderstandResult<ContextPack | null>, KnowledgeContextRequest>(
    KNOWLEDGE_CHANNELS.context
  ),
  refreshFile: bridge.buildProvider<UnderstandResult<KnowledgeNode | null>, KnowledgeRefreshFileRequest>(
    KNOWLEDGE_CHANNELS.refreshFile
  ),
};

// ---------------------------------------------------------------------------
// Provider chat (copied from studioChatBridge's helper pattern)
// ---------------------------------------------------------------------------

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider configured enough to issue a chat call. */
const isUsable = (p: IProvider): boolean =>
  p.enabled !== false && Boolean(p.api_key) && Boolean(p.base_url) && Array.isArray(p.models) && p.models.length > 0;

/** Load configured model providers from the backend. */
const loadProviders = (): Promise<IProvider[]> =>
  httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[]);

/** Resolve the OpenAI-compatible chat endpoint for a provider (honours "Full URL"). */
const resolveChatUrl = (provider: IProvider): string => {
  const base = provider.base_url.replace(/\/+$/, '');
  return provider.is_full_url ? base : `${base}/chat/completions`;
};

/** First non-empty API key (the field may hold several, comma/newline-separated). */
const firstApiKey = (apiKeys: string): string =>
  apiKeys
    .split(/[,\n]/)
    .map((k) => k.trim())
    .find((k) => k.length > 0) ?? '';

/** Find the provider owning `model` (preferring enabled); else any usable provider/model. */
const pickForModel = (providers: IProvider[], model: string): { provider: IProvider; model: string } | null => {
  const usable = providers.filter(isUsable);
  const owner = usable.find((p) => p.models.includes(model) && isModelEnabled(p, model));
  if (owner) return { provider: owner, model };
  for (const provider of usable) {
    const fallback = provider.models.find((m) => isModelEnabled(provider, m)) ?? provider.models[0];
    if (fallback) return { provider, model: fallback };
  }
  return null;
};

/** Detect the "no usable model" case so the UI can show a targeted hint. */
const classify = (error: unknown): 'no-model' | 'error' => {
  const message = error instanceof Error ? error.message : String(error);
  return /no usable model|no model|requires a generator/i.test(message) ? 'no-model' : 'error';
};

/**
 * Issue one non-streaming completion against the user's configured provider.
 * Resolves the provider lazily so a model added after startup is picked up
 * without a restart. Throws on failure (caller wraps into a result / swallows).
 */
const defaultChat = async (model: string, system: string, user: string, signal?: AbortSignal): Promise<string> => {
  return runAgentChatMessages(
    (providerModel, messages, providerSignal) => runProviderChat(providerModel, messages, providerSignal),
    model,
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    signal
  );
};

const runProviderChat = async (model: string, messages: ChatMessageInput[], signal?: AbortSignal): Promise<string> => {
  const providers = await loadProviders();
  const selected = pickForModel(providers, model);
  if (!selected) {
    throw new Error('No usable model is configured. Open Settings → Model and add a provider/model, then try again.');
  }

  const url = resolveChatUrl(selected.provider);
  const apiKey = firstApiKey(selected.provider.api_key);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: selected.model,
      messages,
      stream: false,
    }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Model request failed (HTTP ${response.status}). ${detail.slice(0, 300)}`);
  }

  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('The model returned an empty response.');
  }
  return content;
};

// ---------------------------------------------------------------------------
// Embedding provider wiring (best-effort semantic retrieval)
// ---------------------------------------------------------------------------

type EmbeddingResponse = {
  data?: Array<{ index?: number; embedding?: unknown }>;
};

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));

const resolveEmbeddingUrl = (provider: IProvider): string => {
  const base = provider.base_url.replace(/\/+$/, '');
  if (!provider.is_full_url) {
    return `${base}/embeddings`;
  }
  return `${base.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '')}/embeddings`;
};

const modelHasEmbeddingCapability = (provider: IProvider, model: string): boolean => {
  if (hasSpecificModelCapability(provider, model, 'embedding') === true) {
    return true;
  }
  return (
    provider.capabilities?.some(
      (capability) => capability.type === 'embedding' && capability.isUserSelected !== false
    ) ?? false
  );
};

const pickEmbeddingModel = (providers: IProvider[]): { provider: IProvider; model: string } | null => {
  const usable = providers.filter(isUsable);
  for (const provider of usable) {
    const model = provider.models.find(
      (candidate) => isModelEnabled(provider, candidate) && modelHasEmbeddingCapability(provider, candidate)
    );
    if (model) {
      return { provider, model };
    }
  }
  return null;
};

const parseEmbeddingVectors = (json: EmbeddingResponse, expected: number): number[][] => {
  const vectors: number[][] = Array.from({ length: expected }, (): number[] => []);
  for (const item of json.data ?? []) {
    const index = item.index ?? vectors.findIndex((vector) => vector.length === 0);
    if (index < 0 || index >= vectors.length || !isNumberArray(item.embedding)) {
      continue;
    }
    vectors[index] = item.embedding;
  }
  if (vectors.some((vector) => vector.length === 0)) {
    throw new Error('Embedding provider returned incomplete vectors.');
  }
  return vectors;
};

export const createDefaultEmbedder = async (): Promise<Embedder | null> => {
  const selected = pickEmbeddingModel(await loadProviders());
  if (!selected) {
    return null;
  }
  return {
    providerId: selected.provider.id,
    model: selected.model,
    embed: async (texts, signal) => {
      const response = await fetch(resolveEmbeddingUrl(selected.provider), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${firstApiKey(selected.provider.api_key)}`,
        },
        body: JSON.stringify({ model: selected.model, input: texts }),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Embedding request failed (HTTP ${response.status}). ${detail.slice(0, 300)}`);
      }
      return parseEmbeddingVectors((await response.json()) as EmbeddingResponse, texts.length);
    },
  };
};

// ---------------------------------------------------------------------------
// File discovery (Node fs injected into repoGraph's walker)
// ---------------------------------------------------------------------------

/** Collect a repo's files via {@link collectRepoFiles} with Node `fs` injected. */
const defaultCollectFiles = (rootPath: string): Promise<Array<{ relPath: string; content: string }>> =>
  collectRepoFiles(rootPath, {
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
  });

// ---------------------------------------------------------------------------
// Persistence (userData/ide-knowledge/<hash>.json, atomic tmp+rename)
// ---------------------------------------------------------------------------

/** Directory holding persisted per-repo knowledge graphs. */
const resolveStorageDir = (): string => path.join(app.getPath('userData'), 'ide-knowledge');

/** Stable filesystem-safe filename for a repo root (sha-256 of the path). */
const graphFileName = (rootPath: string): string =>
  `${createHash('sha256').update(rootPath).digest('hex').slice(0, 32)}.json`;

/** Stable filesystem-safe filename for a repo's vector index. */
const vectorFileName = (rootPath: string): string =>
  `${createHash('sha256').update(rootPath).digest('hex').slice(0, 32)}.vectors.json`;

/** Oldest graph schema whose LLM summaries are safe to reuse for a current rebuild. */
const MIN_REUSABLE_GRAPH_VERSION = 4;

/** Whether an error is a "file not found" Node error. */
const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** Persist a built graph atomically (write tmp, then rename over the target). */
const persistGraph = async (graph: KnowledgeGraph): Promise<void> => {
  const dir = resolveStorageDir();
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, graphFileName(graph.rootPath));
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(graph), 'utf-8');
  await fsp.rename(tmp, target);
};

const exportRepoSummary = async (graph: KnowledgeGraph): Promise<void> => {
  const dir = path.join(graph.rootPath, '.aionui', 'understand');
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, 'summary.json');
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    version: 2,
    rootPath: graph.rootPath,
    graphVersion: graph.version,
    builtAt: graph.builtAt,
    language: graph.language,
    commitHash: graph.commitHash,
    overview: graph.overview ?? null,
    runbook: graph.runbook ?? null,
    modules: (graph.modules ?? []).map((mod) => ({
      id: mod.id,
      label: mod.label,
      layer: mod.layer,
      summary: mod.summary,
      fingerprint: mod.fingerprint ?? null,
      fileCount: mod.fileCount,
      files: mod.files,
      parentId: mod.parentId ?? null,
      childModuleIds: mod.childModuleIds ?? [],
      relatedModuleIds: mod.relatedModuleIds ?? [],
      entryFiles: mod.entryFiles ?? [],
    })),
    moduleEdges: graph.moduleEdges ?? [],
    files: graph.nodes.map((node) => ({
      path: node.id,
      label: node.label,
      group: node.group,
      layer: node.layer,
      summary: node.summary,
      summarySource: node.summarySource ?? null,
      tags: node.tags,
      symbols: node.symbols,
      language: node.language,
      importedBy: node.importedBy,
      fingerprint: node.fingerprint ?? null,
    })),
  };
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  await fsp.rename(tmp, target);
  await fsp.rm(path.join(dir, 'stale.json'), { force: true }).catch((): undefined => undefined);
};

/** Load a previously-persisted graph for a repo root, or `null` when absent. */
const loadGraph = async (
  rootPath: string,
  options?: { allowReusableVersion?: boolean }
): Promise<KnowledgeGraph | null> => {
  const target = path.join(resolveStorageDir(), graphFileName(rootPath));
  try {
    const text = await fsp.readFile(target, 'utf-8');
    const graph = JSON.parse(text) as KnowledgeGraph;
    if (graph.version === KNOWLEDGE_GRAPH_VERSION) {
      return graph;
    }
    if (options?.allowReusableVersion === true && graph.version >= MIN_REUSABLE_GRAPH_VERSION) {
      return graph;
    }
    return null;
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }
    throw error;
  }
};

/** Persist a semantic vector index atomically (write tmp, then rename). */
const persistVectorIndex = async (index: VectorIndex): Promise<void> => {
  const dir = resolveStorageDir();
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, vectorFileName(index.rootPath));
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(index), 'utf-8');
  await fsp.rename(tmp, target);
};

/** Load a persisted vector index, or `null` when absent. */
const loadVectorIndex = async (rootPath: string): Promise<VectorIndex | null> => {
  const target = path.join(resolveStorageDir(), vectorFileName(rootPath));
  try {
    return JSON.parse(await fsp.readFile(target, 'utf-8')) as VectorIndex;
  } catch (error) {
    if (isFileNotFound(error)) {
      return null;
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Snapshot history (the TIME dimension) + git commit resolution
// ---------------------------------------------------------------------------

/** How many recent graph snapshots to keep per repo (Git is the full history). */
const MAX_SNAPSHOTS = 5;

/** Filename of the rolling snapshot history for a repo (newest-last JSON array). */
const historyFileName = (rootPath: string): string =>
  `${createHash('sha256').update(rootPath).digest('hex').slice(0, 32)}.history.json`;

/** Resolve the current git commit hash of `rootPath` (or undefined when not a repo). */
const resolveCommitHash = (rootPath: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile('git', ['-C', rootPath, 'rev-parse', 'HEAD'], { timeout: 4000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const hash = stdout.trim();
      resolve(hash.length > 0 ? hash : undefined);
    });
  });

/** Append a built graph to the repo's rolling snapshot history (keep newest N). */
const appendSnapshot = async (graph: KnowledgeGraph): Promise<void> => {
  const dir = resolveStorageDir();
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, historyFileName(graph.rootPath));
  let history: KnowledgeGraph[] = [];
  try {
    history = JSON.parse(await fsp.readFile(target, 'utf-8')) as KnowledgeGraph[];
    if (!Array.isArray(history)) history = [];
  } catch (error) {
    if (!isFileNotFound(error)) history = [];
  }
  history.push(graph);
  if (history.length > MAX_SNAPSHOTS) history = history.slice(history.length - MAX_SNAPSHOTS);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(history), 'utf-8');
  await fsp.rename(tmp, target);
};

/** Load the repo's snapshot history (oldest-first), or `[]` when absent. */
const loadHistory = async (rootPath: string): Promise<KnowledgeGraph[]> => {
  const target = path.join(resolveStorageDir(), historyFileName(rootPath));
  try {
    const parsed = JSON.parse(await fsp.readFile(target, 'utf-8')) as unknown;
    return Array.isArray(parsed) ? (parsed as KnowledgeGraph[]) : [];
  } catch {
    return [];
  }
};

type ActiveBuild = KnowledgeBuildStatus & {
  promise: Promise<UnderstandResult<KnowledgeGraph>>;
  queuedRequest?: KnowledgeBuildRequest;
};

const activeBuilds = new Map<string, ActiveBuild>();
const activeVectorIndexBuilds = new Map<string, Promise<void>>();

const pushBuildEvent = (job: ActiveBuild, rootPath: string, phase: KnowledgeBuildPhase, detail?: string): void => {
  job.phase = phase;
  job.detail = detail;
  const last = job.events.at(-1);
  if (last?.phase !== phase || last.detail !== detail) {
    job.events.push({ phase, detail, at: Date.now() });
  }
  knowledgeChannels.event.emit({ event: detail === undefined ? { phase, rootPath } : { phase, detail, rootPath } });
};

const vectorIndexBuildKey = (rootPath: string, embedder: Embedder): string =>
  `${rootPath}\u0000${embedder.providerId}\u0000${embedder.model}`;

// ---------------------------------------------------------------------------
// Builder wiring
// ---------------------------------------------------------------------------

/** Build the default builder dependencies (real provider chat + Node fs walker). */
const defaultDeps = (): KnowledgeGraphBuilderDeps => ({ chat: defaultChat, collectFiles: defaultCollectFiles });

/**
 * Register the IDE knowledge-graph IPC handlers. Idempotent (re-registration
 * replaces the bound handlers). Intended to be called once during Main-process
 * bootstrap. The default `deps` issue real provider calls + walk the disk; tests
 * exercise {@link createKnowledgeGraphBuilder} directly with fakes.
 */
export function registerKnowledgeGraphBridge(deps: KnowledgeGraphBuilderDeps = defaultDeps()): void {
  const builder = createKnowledgeGraphBuilder(deps);

  const startBuild = (req: KnowledgeBuildRequest): Promise<UnderstandResult<KnowledgeGraph>> => {
    const rootPath = req.rootPath.trim();
    const existing = activeBuilds.get(rootPath);
    if (existing?.running) {
      existing.queued = true;
      existing.queuedRequest = { ...req, forceFresh: false };
      pushBuildEvent(
        existing,
        rootPath,
        existing.phase,
        `${existing.detail ?? ''}${existing.detail ? ' · ' : ''}queued`
      );
      return existing.promise;
    }

    const job: ActiveBuild = {
      running: true,
      phase: 'scanning',
      detail: undefined,
      events: [{ phase: 'scanning', at: Date.now() }],
      promise: Promise.resolve({ ok: false, error: 'Build did not start.', code: 'error' }),
    };
    activeBuilds.set(rootPath, job);

    const ctx: KnowledgeBuildContext = {
      onPhase: (phase, detail) => pushBuildEvent(job, rootPath, phase, detail),
    };
    job.promise = (async (): Promise<UnderstandResult<KnowledgeGraph>> => {
      try {
        // Incremental builds reuse unchanged summaries. A fresh build deliberately
        // ignores the persisted graph so users can rebuild from scratch.
        const previous = req.forceFresh
          ? null
          : await loadGraph(rootPath, { allowReusableVersion: true }).catch((): KnowledgeGraph | null => null);
        const graph = await builder.build(rootPath, req.model, { previous, language: req.language }, ctx);
        graph.commitHash = await resolveCommitHash(rootPath).catch((): undefined => undefined);
        await persistGraph(graph).catch((error) => {
          console.error('[KnowledgeGraphBridge] persist failed:', error);
        });
        await exportRepoSummary(graph).catch((error) => {
          console.error('[KnowledgeGraphBridge] summary export failed:', error);
        });
        await appendSnapshot(graph).catch((error) => {
          console.error('[KnowledgeGraphBridge] snapshot append failed:', error);
        });
        pushBuildEvent(job, rootPath, 'done');
        return { ok: true, data: graph };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[KnowledgeGraphBridge] build failed:', error);
        pushBuildEvent(job, rootPath, 'error', message);
        return { ok: false, error: message, code: classify(error) };
      } finally {
        const queued = job.queuedRequest;
        job.running = false;
        job.queued = false;
        job.queuedRequest = undefined;
        if (queued) {
          activeBuilds.delete(rootPath);
          void startBuild(queued);
        } else {
          setTimeout(() => {
            if (activeBuilds.get(rootPath) === job && !job.running) {
              activeBuilds.delete(rootPath);
            }
          }, 30000);
        }
      }
    })();
    return job.promise;
  };

  knowledgeChannels.build.provider(async (req): Promise<UnderstandResult<KnowledgeGraph>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath || rootPath.length === 0) {
      return { ok: false, error: 'A folder path is required.', code: 'error' };
    }
    return startBuild({ ...req, rootPath });
  });

  knowledgeChannels.status.provider(async (req): Promise<UnderstandResult<KnowledgeBuildStatus>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath || rootPath.length === 0) {
      return { ok: false, error: 'A folder path is required.', code: 'error' };
    }
    const job = activeBuilds.get(rootPath);
    if (!job) {
      const graph = await loadGraph(rootPath).catch((): KnowledgeGraph | null => null);
      const freshness = graph
        ? await assessGraphFreshness(graph, deps).catch((): GraphFreshness | undefined => undefined)
        : undefined;
      return { ok: true, data: { running: false, phase: 'idle', events: [], freshness } };
    }
    return {
      ok: true,
      data: {
        running: job.running,
        queued: job.queued,
        phase: job.phase,
        detail: job.detail,
        events: job.events,
      },
    };
  });

  knowledgeChannels.get.provider(async (req): Promise<UnderstandResult<KnowledgeGraph | null>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath || rootPath.length === 0) {
      return { ok: false, error: 'A folder path is required.', code: 'error' };
    }
    try {
      return { ok: true, data: await loadGraph(rootPath) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[KnowledgeGraphBridge] get failed:', error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  // Deterministic single-file structural refresh (no model call). Re-parses one
  // edited file's symbols and patches the persisted graph so hovers/relations
  // stay accurate as the single user edits — semantic summaries still come from
  // an explicit rebuild. Cheap enough to run on every save.
  knowledgeChannels.refreshFile.provider(async (req): Promise<UnderstandResult<KnowledgeNode | null>> => {
    const rootPath = req.rootPath?.trim();
    const relPath = req.relPath?.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rootPath || !relPath) {
      return { ok: false, error: 'rootPath and relPath are required.', code: 'error' };
    }
    try {
      const graph = await loadGraph(rootPath);
      if (!graph) return { ok: true, data: null };
      const language = detectLanguage(relPath);
      const symbols = enrichSymbolRangesAndCalls(req.content, extractSymbols(req.content, language));
      const fingerprint = fingerprintOf(req.content);
      const idx = graph.nodes.findIndex((node) => node.id === relPath);
      let node: KnowledgeNode;
      let nodeIndex: number;
      if (idx >= 0) {
        node = { ...graph.nodes[idx], symbols, fingerprint, language };
        graph.nodes[idx] = node;
        nodeIndex = idx;
      } else {
        const label = relPath.slice(relPath.lastIndexOf('/') + 1);
        const slash = relPath.indexOf('/');
        const group = slash > 0 ? relPath.slice(0, slash) : relPath;
        node = {
          id: relPath,
          label,
          group,
          layer: inferLayer(relPath),
          summary: '',
          summarySource: 'fallback',
          tags: [],
          symbols,
          language,
          importedBy: 0,
          fingerprint,
        };
        graph.nodes.push(node);
        graph.fileCount = graph.nodes.length;
        nodeIndex = graph.nodes.length - 1;
      }

      // Optional on-demand LLM re-summary of this one file (explicit user action).
      if (req.summarize) {
        try {
          const requested = req.model && !req.model.startsWith('cli:') ? req.model : undefined;
          let model = requested;
          if (!model) {
            model = pickForModel(await loadProviders(), '')?.model ?? undefined;
          }
          if (model) {
            const symbolNames = symbols
              .slice(0, 20)
              .map((s) => s.name)
              .filter(Boolean)
              .join(', ');
            const langLine =
              graph.language && !graph.language.startsWith('en') ? ` Write the summary in ${graph.language}.` : '';
            const system =
              'You summarize one source file for a codebase knowledge graph. Reply with ONE plain-English ' +
              `paragraph (2-3 sentences) describing what the file is for and its role. No preamble, no markdown.${langLine}`;
            const userMsg = `File: ${relPath}\nLanguage: ${language}\nSymbols: ${symbolNames || '(none)'}\n\nSource:\n${req.content.slice(0, 6000)}`;
            const reply = (await deps.chat(model, system, userMsg)).trim();
            if (reply.length > 0) {
              node = { ...node, summary: reply, summarySource: 'llm' };
              graph.nodes[nodeIndex] = node;
            }
          }
        } catch (error) {
          console.error('[KnowledgeGraphBridge] refresh-file summarize failed:', error);
          // Keep the structural patch; the previous summary stays.
        }
      }

      await persistGraph(graph).catch((error) => {
        console.error('[KnowledgeGraphBridge] refresh-file persist failed:', error);
      });
      return { ok: true, data: node };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  // -- Diff: compare the two most recent snapshots (time dimension). -----------
  knowledgeChannels.diff.provider(async (req): Promise<UnderstandResult<GraphDiff | null>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath || rootPath.length === 0) {
      return { ok: false, error: 'A folder path is required.', code: 'error' };
    }
    try {
      const history = await loadHistory(rootPath);
      if (history.length < 2) {
        // Not enough snapshots yet — return null (not an error; just no diff).
        return { ok: true, data: null };
      }
      const from = history[history.length - 2];
      const to = history[history.length - 1];
      return { ok: true, data: diffGraphs(from, to) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[KnowledgeGraphBridge] diff failed:', error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  // -- Context: build a focused context pack for an agent request. -----------
  const resolveSemanticContextBuilder = async (
    rootPath: string,
    graph: KnowledgeGraph
  ): Promise<ReturnType<typeof createContextBuilder>> => {
    const embedder = await createDefaultEmbedder();
    if (!embedder) {
      return createContextBuilder();
    }
    try {
      const index = await loadVectorIndex(rootPath).catch((): VectorIndex | null => null);
      if (!index || !isVectorIndexFresh(graph, index)) {
        const key = vectorIndexBuildKey(rootPath, embedder);
        if (!activeVectorIndexBuilds.has(key)) {
          const previous = index;
          const build = (async (): Promise<void> => {
            const files = await deps.collectFiles(rootPath);
            const nextIndex = await buildVectorIndex(graph, files, embedder, { previous });
            await persistVectorIndex(nextIndex);
          })()
            .catch((error) => {
              console.warn('[KnowledgeGraphBridge] vector index rebuild failed:', error);
            })
            .finally(() => {
              activeVectorIndexBuilds.delete(key);
            });
          activeVectorIndexBuilds.set(key, build);
        }
        return createContextBuilder();
      }
      if (!isVectorIndexFresh(graph, index)) {
        return createContextBuilder();
      }
      return createContextBuilder({ ranker: createVectorRanker(index, embedder.embed) });
    } catch (error) {
      console.warn('[KnowledgeGraphBridge] semantic context disabled:', error);
      return createContextBuilder();
    }
  };

  knowledgeChannels.context.provider(async (req): Promise<UnderstandResult<ContextPack | null>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath || rootPath.length === 0) {
      return { ok: false, error: 'A folder path is required.', code: 'error' };
    }
    try {
      const graph = await loadGraph(rootPath);
      if (!graph) {
        // No graph built yet — caller should build first.
        return { ok: true, data: null };
      }
      const freshness = await assessGraphFreshness(graph, deps);
      if (!freshness.fresh) {
        console.warn('[KnowledgeGraphBridge] context skipped stale graph:', freshness);
        return { ok: true, data: null };
      }
      // Optionally include the latest regression diff as changed-boost context.
      let diff: GraphDiff | null = null;
      if (req.includeDiff !== false) {
        const history = await loadHistory(rootPath).catch((): KnowledgeGraph[] => []);
        if (history.length >= 2) {
          diff = diffGraphs(history[history.length - 2], history[history.length - 1]);
        }
      }
      const contextBuilder = await resolveSemanticContextBuilder(rootPath, graph);
      const pack = await contextBuilder.build({
        request: req.request,
        graph,
        rules: req.rules ?? [],
        diff,
      });
      return { ok: true, data: pack };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[KnowledgeGraphBridge] context failed:', error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  // -- Live mode: a single repo watcher emits debounced change batches. -------
  // `fs.watch` recursive support is native on Windows + macOS; on Linux it is
  // best-effort. The watcher itself is debounced + filtered (see repoWatcher).
  const watcher = createRepoWatcher({
    watch: (rootPath, onEvent): FsWatcherHandle => {
      const fsWatcher = fs.watch(rootPath, { recursive: true }, (eventType, filename) => {
        if (typeof filename !== 'string' || filename.length === 0) {
          return;
        }
        onEvent(eventType as RawWatchEventType, filename);
      });
      return { close: (): void => fsWatcher.close() };
    },
    exists: (rootPath, relPath): boolean => {
      try {
        return fs.existsSync(path.join(rootPath, relPath));
      } catch {
        return false;
      }
    },
  });

  knowledgeChannels.watchStart.provider(async (req): Promise<UnderstandResult<boolean>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath || rootPath.length === 0) {
      return { ok: false, error: 'A folder path is required.', code: 'error' };
    }
    try {
      watcher.start(rootPath, (event) => {
        knowledgeChannels.changed.emit({ event });
      });
      return { ok: true, data: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[KnowledgeGraphBridge] watch-start failed:', error);
      return { ok: false, error: message, code: 'error' };
    }
  });

  knowledgeChannels.watchStop.provider(async (): Promise<UnderstandResult<boolean>> => {
    try {
      watcher.stop();
      return { ok: true, data: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[KnowledgeGraphBridge] watch-stop failed:', error);
      return { ok: false, error: message, code: 'error' };
    }
  });
}
