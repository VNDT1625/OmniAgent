/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node executors for the Automation engine — one async function per
 * {@link WorkflowNodeKind}. Each executor receives the node, the run context
 * (the previous node's output as `ctx.input`) and an {@link AbortSignal}, and
 * returns the value passed on to the next node.
 *
 * The provider-backed AI completion is injected as `chat` so the executor map
 * stays pure and unit-testable (no real network / providers in tests). The
 * production `chat` is built by {@link createProviderChat}, which — exactly like
 * `studioChatBridge` and the web-agent's `providerChat` — issues the call from
 * the Main process against the user's configured OpenAI-compatible provider
 * (the renderer cannot reach providers directly due to CORS / `webSecurity`).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import type {
  AiNodeConfig,
  BrowserNodeConfig,
  CloudUploadNodeConfig,
  CodeNodeConfig,
  CompanyNodeConfig,
  ConversationNodeConfig,
  CronNodeConfig,
  DelayNodeConfig,
  EditorNodeConfig,
  EmailNodeConfig,
  FacebookNodeConfig,
  FilesystemNodeConfig,
  HttpNodeConfig,
  MakeVideoNodeConfig,
  ManagerNodeConfig,
  NodeContext,
  NotifyNodeConfig,
  SetNodeConfig,
  SubworkflowNodeConfig,
  TiktokNodeConfig,
  TransformNodeConfig,
  WorkflowNode,
  WorkflowNodeKind,
} from './automationTypes';
import { artifactFromInput } from './connectors/artifacts';
import { createCloudUploader } from './connectors/cloudUpload';
import { createEmailSender } from './connectors/emailSend';
import { createFacebookPublisher } from './connectors/facebookPost';
import { createTiktokPublisher } from './connectors/tiktokPost';
import {
  createEditorAction,
  createMakeVideoAction,
  type EditorActionDeps,
  type MakeVideoActionDeps,
} from './connectors/appActions';
import { createCompanyAction, type CompanyActionDeps } from './connectors/companyAction';
import { createFilesystemAction, runCode, runSet, type FilesystemFs } from './connectors/dataActions';
import { createAppReuseActions, type AppReuseDeps } from './connectors/appReuse';

/** A single executor: run `node` with the given context + cancellation signal. */
export type NodeExecutor = (node: WorkflowNode, ctx: NodeContext, signal?: AbortSignal) => Promise<unknown>;

/** Node kinds the engine interprets itself (no executor map entry). */
export type ControlNodeKind =
  | 'control.if'
  | 'control.switch'
  | 'control.loop'
  | 'control.parallel'
  | 'control.tryCatch'
  | 'control.filter'
  | 'control.merge'
  | 'control.stop';

/** Leaf node kinds — every kind except the engine-interpreted control nodes. */
export type LeafNodeKind = Exclude<WorkflowNodeKind, ControlNodeKind>;

/** The complete executor table — exactly one entry per leaf node kind. */
export type NodeExecutorMap = Record<LeafNodeKind, NodeExecutor>;

/** Cap on the HTTP response body captured into a node's output (chars). */
const MAX_HTTP_BODY_CHARS = 100_000;

/** Dependencies for {@link createNodeExecutors} (all injectable for tests). */
export type NodeExecutorDeps = {
  /** Provider-backed completion. Injected so tests can stub it. */
  chat: (model: string, prompt: string, signal?: AbortSignal) => Promise<string>;
  /** `fetch` implementation for the HTTP node. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Clock (reserved for future timestamping). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Make Video collaborators for the `action.app.makeVideo` node. When omitted,
   * the node throws a clear "not wired" error rather than silently no-op.
   */
  makeVideo?: MakeVideoActionDeps;
  /** Optional fs override for the `action.app.editor` node. */
  editor?: EditorActionDeps;
  /**
   * Agent Company collaborators for the `action.company` node. When omitted, the
   * node throws a clear "not wired" error rather than silently no-op.
   */
  company?: CompanyActionDeps;
  /** Optional fs override for the `action.filesystem` node. */
  filesystemFs?: FilesystemFs;
  /** App-reuse capabilities (notify/manager/browser/conversation/cron/subworkflow). */
  appReuse?: AppReuseDeps;
  /**
   * Resolve a stored credential's decrypted fields by id (Main process only).
   * When set, nodes carrying a `credentialId` merge those fields into their
   * config before running, so secrets never live in the workflow JSON.
   */
  resolveCredential?: (id: string) => Promise<Record<string, string> | undefined>;
};

// ---------------------------------------------------------------------------
// Config readers (defensive — node config is an open record)
// ---------------------------------------------------------------------------

const asString = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const asRecord = (v: unknown): Record<string, string> => {
  if (typeof v !== 'object' || v === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
};

/** Substitute every `{{input}}` occurrence with the stringified context input. */
const substituteInput = (template: string, input: unknown): string =>
  template.replace(/\{\{input\}\}/g, String(input ?? ''));

/** A `setTimeout` that rejects promptly if the signal aborts. */
const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms)
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Build the executor table. Triggers and the log node simply pass `ctx.input`
 * through; action nodes do their work and return their result.
 */
export const createNodeExecutors = (deps: NodeExecutorDeps): NodeExecutorMap => {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const passthrough: NodeExecutor = (_node, ctx) => Promise.resolve(ctx.input);

  // Build the cloud/social/email connectors once, sharing the injected fetch.
  const cloudUploader = createCloudUploader({ fetchImpl });
  const emailSender = createEmailSender();
  const facebookPublisher = createFacebookPublisher({ fetchImpl });
  const tiktokPublisher = createTiktokPublisher({ fetchImpl });
  const editorAction = createEditorAction(deps.editor);
  const filesystemAction = createFilesystemAction(deps.filesystemFs);
  const appReuse = createAppReuseActions(deps.appReuse ?? {});

  /**
   * Merge a stored credential's decrypted fields into a node's config when the
   * node carries a `credentialId`. Inline config values win over credential
   * fields (so a user can override a single field). Returns the original config
   * untouched when there is no credentialId or no resolver.
   */
  const withCredential = async (config: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const credentialId = typeof config.credentialId === 'string' ? config.credentialId.trim() : '';
    if (credentialId.length === 0 || !deps.resolveCredential) return config;
    const fields = await deps.resolveCredential(credentialId);
    if (!fields) return config;
    // Credential fields first, then inline config overrides them.
    return { ...fields, ...config };
  };

  return {
    'trigger.manual': passthrough,
    'trigger.schedule': passthrough,
    'trigger.webhook': passthrough,
    'action.log': passthrough,

    'action.http': async (node, _ctx, signal) => {
      const config = node.config as Partial<HttpNodeConfig>;
      const method = config.method ?? 'GET';
      const url = asString(config.url);
      if (url.length === 0) throw new Error(`HTTP node "${node.name}" is missing a url.`);
      const headers = asRecord(config.headers);
      const body = typeof config.body === 'string' ? config.body : undefined;

      let response: Response;
      try {
        response = await fetchImpl(url, { method, headers, body, signal });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`HTTP request to ${url} failed: ${message}`, { cause: error });
      }
      const text = await response.text().catch(() => '');
      return { status: response.status, body: text.slice(0, MAX_HTTP_BODY_CHARS) };
    },

    'action.ai': async (node, ctx, signal) => {
      const config = node.config as Partial<AiNodeConfig>;
      const model = asString(config.model);
      if (model.length === 0) throw new Error(`AI node "${node.name}" is missing a model.`);
      const prompt = substituteInput(asString(config.prompt), ctx.input);
      return deps.chat(model, prompt, signal);
    },

    'action.transform': (node, ctx) => {
      const config = node.config as Partial<TransformNodeConfig>;
      const expression = asString(config.expression);
      return Promise.resolve(substituteInput(expression, ctx.input));
    },

    'action.delay': async (node, ctx, signal) => {
      const config = node.config as Partial<DelayNodeConfig>;
      const ms = typeof config.ms === 'number' && Number.isFinite(config.ms) ? config.ms : 0;
      await delay(ms, signal);
      return ctx.input;
    },

    // --- Data nodes ---

    'action.set': (node, ctx) => Promise.resolve(runSet(node.config as unknown as SetNodeConfig, ctx.input)),

    'action.code': (node, ctx) => Promise.resolve(runCode(node.config as unknown as CodeNodeConfig, ctx.input)),

    'action.filesystem': (node, ctx) =>
      filesystemAction.run(node.config as unknown as FilesystemNodeConfig, ctx.input, node.name),

    // --- App-reuse nodes (drive existing AionUi features) ---

    'action.notify': (node, ctx) => appReuse.notify(node.config as unknown as NotifyNodeConfig, ctx.input, node.name),

    'action.manager': (node, ctx) =>
      appReuse.manager(node.config as unknown as ManagerNodeConfig, ctx.input, node.name),

    'action.browser': (node, ctx) =>
      appReuse.browser(node.config as unknown as BrowserNodeConfig, ctx.input, node.name),

    'action.conversation': (node, ctx) =>
      appReuse.conversation(node.config as unknown as ConversationNodeConfig, ctx.input, node.name),

    'action.cron': (node, ctx) => appReuse.cron(node.config as unknown as CronNodeConfig, ctx.input, node.name),

    'action.subworkflow': (node, ctx) =>
      appReuse.subworkflow(node.config as unknown as SubworkflowNodeConfig, ctx.input, node.name),

    // --- App-function nodes: produce an artifact from an AionUi sub-app ---

    'action.app.makeVideo': async (node, _ctx) => {
      if (!deps.makeVideo) {
        throw new Error(`"${node.name}" is not available: the Make Video service is not wired.`);
      }
      const action = createMakeVideoAction(deps.makeVideo);
      const result = await action.run(node.config as unknown as MakeVideoNodeConfig, _ctx.input, node.name);
      // Surface the artifact so downstream cloud/social nodes can find it.
      return { artifact: result.artifact, projectId: result.projectId, sceneCount: result.sceneCount };
    },

    'action.app.editor': async (node, ctx) => {
      const result = await editorAction.run(node.config as unknown as EditorNodeConfig, ctx.input, node.name);
      return { artifact: result.artifact, path: result.path, bytes: result.bytes };
    },

    // --- Cloud storage ---

    'action.cloud.upload': async (node, ctx, signal) => {
      const config = await withCredential(node.config);
      const result = await cloudUploader.upload(
        config as unknown as CloudUploadNodeConfig,
        ctx.input,
        node.name,
        signal
      );
      // Re-emit the source artifact enriched with the hosted URL when available.
      const artifact = artifactFromInput(ctx.input);
      const enriched = artifact ? { ...artifact, url: result.url ?? artifact.url ?? null } : null;
      return { artifact: enriched, url: result.url, key: result.key, provider: result.provider };
    },

    // --- Email + social publishers ---

    'action.email.send': async (node, ctx) => {
      const config = await withCredential(node.config);
      const result = await emailSender.send(config as unknown as EmailNodeConfig, ctx.input, node.name);
      return { ...result, input: ctx.input };
    },

    'action.social.facebook': async (node, ctx, signal) => {
      const config = await withCredential(node.config);
      const result = await facebookPublisher.post(
        config as unknown as FacebookNodeConfig,
        ctx.input,
        node.name,
        signal
      );
      return { ...result, input: ctx.input };
    },

    'action.social.tiktok': async (node, ctx, signal) => {
      const config = await withCredential(node.config);
      const result = await tiktokPublisher.post(config as unknown as TiktokNodeConfig, ctx.input, node.name, signal);
      return { ...result, input: ctx.input };
    },

    // --- Agent Company: delegate to a multi-agent company ---

    'action.company': async (node, ctx) => {
      if (!deps.company) {
        throw new Error(`"${node.name}" is not available: the Agent Company service is not wired.`);
      }
      const action = createCompanyAction(deps.company);
      const result = await action.run(node.config as unknown as CompanyNodeConfig, ctx.input, node.name);
      // The company's output (new id, or the President's summary) becomes the
      // pipeline value for the next step.
      return { mode: result.mode, companyId: result.companyId, output: result.output, text: result.output };
    },
  };
};

// ---------------------------------------------------------------------------
// Provider-backed chat (production `chat` for the AI node)
// ---------------------------------------------------------------------------

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider configured enough to issue a chat call. */
const isUsable = (p: IProvider): boolean =>
  p.enabled !== false && Boolean(p.api_key) && Boolean(p.base_url) && Array.isArray(p.models) && p.models.length > 0;

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

/**
 * Build the production `chat` function backing the `action.ai` node. Resolves
 * the provider lazily so a model added after startup is picked up without a
 * restart. Throws clear errors on misconfiguration / HTTP failure / empty reply.
 */
export const createProviderChat = (): ((model: string, prompt: string, signal?: AbortSignal) => Promise<string>) => {
  return async (model, prompt, signal) => {
    const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];
    const selected = pickForModel(providers, model);
    if (!selected) {
      throw new Error('No usable model is configured. Open Settings → Model and add a provider/model, then try again.');
    }

    const url = resolveChatUrl(selected.provider);
    const apiKey = firstApiKey(selected.provider.api_key);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: selected.model, messages: [{ role: 'user', content: prompt }], stream: false }),
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
};
