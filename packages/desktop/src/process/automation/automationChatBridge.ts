/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Automation Chat IPC bridge — powers the "AI Workflow Designer" panel where
 * users describe, modify, or ask questions about workflows in natural language
 * and the AI generates / edits / explains them.
 *
 * One channel: `automation.chat` — a single, non-streaming completion. The
 * renderer sends the model id, conversation messages, optional current workflow
 * context, and an intent hint. Returns an {@link AutomationChatResult} envelope
 * so a failure is observable instead of hanging the renderer (the platform
 * bridge swallows rejected promises).
 *
 * When the AI response contains a ```json fence with a valid {@link Workflow}
 * object, the bridge automatically upserts it into the automation store and
 * returns the persisted workflow alongside the reply text.
 *
 * Provider routing follows the same pattern as `studioChatBridge` and
 * `makeVideoBridge`: `runAgentChatMessages` handles `cli:<agentId>` model ids
 * transparently; all other ids go through the user's configured OpenAI-
 * compatible provider (the renderer cannot reach providers directly due to
 * CORS / `webSecurity`).
 *
 * The global bootstrap calls {@link registerAutomationChatBridge} once; this
 * module does not wire itself in.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import { runAgentChatMessages } from '@process/services/agentChat';
import type { ChatMessageInput } from '@process/browser/webAgentRunner';
import { createAutomationStore, type IAutomationStore } from './automationStore';
import type { Workflow } from './automationTypes';

// ---------------------------------------------------------------------------
// Channel names (renderer-safe contract)
// ---------------------------------------------------------------------------

/** IPC channel names for the Automation Chat surface. Safe to import from the renderer. */
export const AUTOMATION_CHAT_CHANNELS = {
  chat: 'automation.chat',
} as const;

// ---------------------------------------------------------------------------
// Request / result types
// ---------------------------------------------------------------------------

/**
 * Result envelope — always resolves (never rejects), so the renderer can branch
 * on `ok`. `code: 'no-model'` flags the "no usable model configured" case.
 */
export type AutomationChatResult<T> = { ok: true; data: T } | { ok: false; error: string; code: 'no-model' | 'error' };

/** One chat message exchanged with the workflow AI assistant. */
export type AutomationChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

/** Request for {@link AUTOMATION_CHAT_CHANNELS.chat}. */
export type AutomationChatRequest = {
  /** Model id the user picked in the panel. */
  model: string;
  /** The running conversation (system/user/assistant turns). */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Workflow currently open in the editor (context for the AI). */
  currentWorkflow?: import('./automationTypes').Workflow | null;
  /** Existing workflows so the AI can avoid duplicate names. */
  existingWorkflows?: Array<{ id: string; name: string }>;
  /** Intent hint: 'create' | 'modify' | 'explain' | 'fix' | 'chat' */
  intent?: string;
};

/** Payload returned inside a successful {@link AutomationChatResult}. */
export type AutomationChatReply = {
  /** The AI's text reply (may contain a ```json fence for create/modify). */
  reply: string;
  /** Parsed + persisted workflow when the AI returned a valid JSON workflow. */
  workflow?: Workflow;
};

/** Typed Automation Chat channels. Exported for bootstrap registration wiring. */
export const automationChatChannels = {
  chat: bridge.buildProvider<AutomationChatResult<AutomationChatReply>, AutomationChatRequest>(
    AUTOMATION_CHAT_CHANNELS.chat
  ),
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Build the system prompt injected before the user's conversation. The prompt
 * teaches the AI the full node catalogue and the expected output format for
 * each intent.
 */
const buildSystemPrompt = (req: AutomationChatRequest): string => {
  const nodeKindDocs = `
## Available node kinds

### Trigger nodes (start a workflow)
- trigger.manual     — started by the user on demand; no config required.
- trigger.schedule   — cron-based schedule; config: { cron?: string, everyMinutes?: number }.
- trigger.webhook    — HTTP webhook; config: { path: string }.

### Action nodes
- action.http        — HTTP request; config: { method: 'GET'|'POST'|'PUT'|'DELETE', url, headers?, body? }.
- action.ai          — LLM completion; config: { model: string, prompt: string } ({{input}} placeholder).
- action.transform   — template expression; config: { expression: string } ({{input}} placeholder).
- action.delay       — pause; config: { ms: number }.
- action.log         — log current value; config: { label?: string }.
- action.set         — build/extend an object; config: { keepInput?: boolean, fields: [{key,value}] }.
- action.code        — template expression with optional JSON parse; config: { template: string, parseJson?: boolean }.
- action.filesystem  — read/write/append/list a file; config: { operation, path, content? }.

### Control-flow nodes (use "branches" for child pipelines)
- control.if         — branches: { then: WorkflowNode[], else: WorkflowNode[] }; config: { condition: string }.
- control.switch     — branches: { "case:<value>": WorkflowNode[], default?: WorkflowNode[] }; config: { value: string }.
- control.loop       — branches: { body: WorkflowNode[] }; config: { mode?: 'forEach'|'times', times?, itemsPath? }.
- control.parallel   — branches: { "branch:0": WorkflowNode[], "branch:1": WorkflowNode[], ... }.
- control.tryCatch   — branches: { try: WorkflowNode[], catch: WorkflowNode[] }.
- control.filter     — keep items matching condition; config: { condition: string }.
- control.merge      — merge parallel branch outputs into an array; no config.
- control.stop       — stop the run immediately; no config.

### App-function nodes
- action.app.makeVideo — generate a video; config: { topic, style, language, scriptModel, imageModel, sceneCount, renderVideo?, secondsPerScene? }.
- action.app.editor    — create/append a document; config: { path, operation: 'create'|'append', content }.

### App-reuse nodes (drive existing AionUi features)
- action.notify      — desktop notification; config: { title, body }.
- action.manager     — create task/note/event in Personal Manager; config: { entity: 'task'|'note'|'event', title, detail?, at? }.
- action.browser     — web-agent task; config: { task, url?, model? }.
- action.conversation — send message to an agent; config: { message, model? }.
- action.cron        — create a scheduled job; config: { cron, prompt, name? }.
- action.subworkflow — run another workflow; config: { workflowId: string }.

### Cloud / social nodes
- action.cloud.upload  — upload artifact to S3/WebDAV; config: { provider: 's3'|'webdav', sourcePath?, destination?, ...credentials }.
- action.email.send    — send email via SMTP; config: { host, port, secure?, username?, password?, from, to, subject, body, attachArtifact? }.
- action.social.facebook — post to Facebook Page; config: { pageId, accessToken, message, attachArtifact?, link? }.
- action.social.tiktok   — upload video to TikTok; config: { accessToken, caption, videoPath?, privacy? }.

### Agent Company node
- action.company     — delegate to a multi-agent company; config: { mode: 'create'|'goal'|'tasks', companyId?, description?, goal?, roleId?, task?, model?, maxDelegations?, autoApprove? }.
`.trim();

  const workflowSchema = `
## Workflow JSON schema (for create / modify responses)

\`\`\`typescript
type Workflow = {
  id: string;          // keep existing id when modifying; use "" for new workflows
  name: string;        // short, unique display name
  description?: string;
  nodes: WorkflowNode[];
  enabled: boolean;
  createdAt: number;   // epoch ms — keep existing value when modifying
  updatedAt: number;   // epoch ms — use Date.now() value
};

type WorkflowNode = {
  id: string;          // short unique id within the workflow, e.g. "n1", "n2"
  kind: WorkflowNodeKind;
  name: string;        // human-friendly label
  config: Record<string, unknown>;
  branches?: Record<string, WorkflowNode[]>;  // control-flow nodes only
  onError?: { retries?: number; retryDelayMs?: number; continueOnError?: boolean };
};
\`\`\`
`.trim();

  const intentInstructions = (() => {
    const intent = req.intent ?? 'chat';
    if (intent === 'create') {
      return `
## Your task: CREATE a new workflow
- Design a complete workflow that fulfils the user's request.
- Return the workflow as a JSON object inside a \`\`\`json fence.
- After the fence, add a short plain-text explanation of what the workflow does.
- Choose a unique name that does not clash with existing workflows.
- Use "" for the id field (the bridge will assign a real id on save).
`.trim();
    }
    if (intent === 'modify') {
      return `
## Your task: MODIFY the current workflow
- Edit the provided workflow to fulfil the user's request.
- Return the COMPLETE updated workflow as a JSON object inside a \`\`\`json fence.
- Preserve the existing id, name (unless the user asks to rename), and createdAt.
- After the fence, add a short plain-text explanation of what changed.
`.trim();
    }
    if (intent === 'fix') {
      return `
## Your task: FIX the current workflow
- Identify and correct errors or misconfigurations in the provided workflow.
- Return the COMPLETE fixed workflow as a JSON object inside a \`\`\`json fence.
- After the fence, explain what was wrong and what you fixed.
`.trim();
    }
    if (intent === 'explain') {
      return `
## Your task: EXPLAIN the current workflow
- Describe what the workflow does in plain language, step by step.
- Do NOT return a JSON fence — plain text only.
`.trim();
    }
    // 'chat' or unknown
    return `
## Your task: CHAT about workflows
- Answer the user's question about workflows, nodes, or automation in general.
- If the user asks you to create or modify a workflow, return the workflow JSON inside a \`\`\`json fence.
- Otherwise, respond in plain text.
`.trim();
  })();

  const contextSection = (() => {
    const parts: string[] = [];
    if (req.currentWorkflow) {
      parts.push(`## Current workflow (context)\n\`\`\`json\n${JSON.stringify(req.currentWorkflow, null, 2)}\n\`\`\``);
    }
    if (req.existingWorkflows && req.existingWorkflows.length > 0) {
      const names = req.existingWorkflows.map((w) => `- ${w.name} (id: ${w.id})`).join('\n');
      parts.push(`## Existing workflow names (avoid duplicates)\n${names}`);
    }
    return parts.join('\n\n');
  })();

  return [
    'You are an expert AI Workflow Designer for AionUi — a desktop automation platform.',
    'You help users create, modify, explain, and fix automation workflows using natural language.',
    '',
    nodeKindDocs,
    '',
    workflowSchema,
    '',
    intentInstructions,
    contextSection ? `\n${contextSection}` : '',
  ]
    .join('\n')
    .trim();
};

// ---------------------------------------------------------------------------
// Provider chat (mirrors studioChatBridge pattern)
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
 * Issue one non-streaming completion against the user's configured provider.
 * Resolves the provider lazily so a model added after startup is picked up
 * without a restart. Throws on failure; the caller wraps it into a result.
 */
const runProviderChat = async (model: string, messages: ChatMessageInput[]): Promise<string> => {
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
    body: JSON.stringify({ model: selected.model, messages, stream: false }),
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
// JSON workflow extraction + store upsert
// ---------------------------------------------------------------------------

/**
 * Extract the first ```json ... ``` fence from the AI reply and attempt to
 * parse it as a {@link Workflow}. Returns `null` when no valid fence is found.
 */
const extractWorkflowJson = (reply: string): (Partial<Workflow> & { name: string }) | null => {
  const match = /```json\s*([\s\S]*?)```/i.exec(reply);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'name' in parsed &&
      typeof (parsed as Record<string, unknown>).name === 'string'
    ) {
      return parsed as Partial<Workflow> & { name: string };
    }
  } catch {
    // Malformed JSON — ignore silently.
  }
  return null;
};

// ---------------------------------------------------------------------------
// Classify error
// ---------------------------------------------------------------------------

/** Detect the "no usable model" case so the UI can show a targeted hint. */
const classify = (error: unknown): 'no-model' | 'error' => {
  const message = error instanceof Error ? error.message : String(error);
  return /no usable model|no model|requires a generator/i.test(message) ? 'no-model' : 'error';
};

// ---------------------------------------------------------------------------
// Core chat runner
// ---------------------------------------------------------------------------

/**
 * Run one automation chat completion. Injects the system prompt, routes through
 * `runAgentChatMessages` (handles CLI model ids transparently), then parses any
 * workflow JSON from the reply and upserts it into the store.
 */
const runAutomationChat = async (req: AutomationChatRequest, store: IAutomationStore): Promise<AutomationChatReply> => {
  const systemPrompt = buildSystemPrompt(req);

  // Prepend the system prompt as the first message if the conversation does not
  // already start with a system turn (avoids duplicating it on follow-up turns).
  const messages: ChatMessageInput[] =
    req.messages[0]?.role === 'system'
      ? (req.messages as ChatMessageInput[])
      : [{ role: 'system', content: systemPrompt }, ...(req.messages as ChatMessageInput[])];

  const reply = await runAgentChatMessages(
    (model, msgs, signal) => runProviderChat(model, msgs as ChatMessageInput[]),
    req.model,
    messages,
    undefined
  );

  // Attempt to extract and persist a workflow from the reply.
  const partial = extractWorkflowJson(reply);
  if (partial) {
    try {
      const saved = await store.save(partial);
      return { reply, workflow: saved };
    } catch (saveError) {
      // Log but do not fail the chat — the reply is still useful.
      console.error('[AutomationChatBridge] Failed to save extracted workflow:', saveError);
    }
  }

  return { reply };
};

// ---------------------------------------------------------------------------
// Lazy shared store
// ---------------------------------------------------------------------------

/** Lazily-built shared store (reuses the same userData file as automationBridge). */
let sharedStore: IAutomationStore | undefined;

const getSharedStore = (): IAutomationStore => {
  if (!sharedStore) sharedStore = createAutomationStore();
  return sharedStore;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Options for {@link registerAutomationChatBridge}. */
export type RegisterAutomationChatBridgeOptions = {
  /** Override the store (tests / advanced bootstrap). */
  store?: IAutomationStore;
};

/**
 * Register the Automation Chat IPC handler. Idempotent (re-registration
 * replaces the bound handler). Intended to be called once during Main-process
 * bootstrap.
 *
 * @param options Injected store (defaults to the shared production store).
 */
export function registerAutomationChatBridge(options: RegisterAutomationChatBridgeOptions = {}): void {
  const store = options.store ?? getSharedStore();

  automationChatChannels.chat.provider(async (req): Promise<AutomationChatResult<AutomationChatReply>> => {
    try {
      const data = await runAutomationChat(req, store);
      return { ok: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[AutomationChatBridge] chat failed:', error);
      return { ok: false, error: message, code: classify(error) };
    }
  });
}

/** Reset the lazily-built shared store (deterministic teardown for tests). */
export function disposeAutomationChatBridge(): void {
  sharedStore = undefined;
}
