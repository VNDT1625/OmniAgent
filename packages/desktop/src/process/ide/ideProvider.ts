/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared provider-chat plumbing for the IDE repo-intelligence bridges
 * (`ideExplainBridge.ts` + `ideWikiBridge.ts`).
 *
 * The renderer cannot call model providers directly (CORS / `webSecurity`), so —
 * exactly like the Studio chat bridge — IDE completions are issued from the Main
 * process against the user's configured provider over the OpenAI-compatible
 * `/chat/completions` endpoint. Both IDE features ("explain a codebase" and
 * "generate a wiki") share the same provider resolution + single-shot chat call,
 * so that logic lives here once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import { runAgentChatMessages } from '@process/services/agentChat';

/** One chat message exchanged with the model provider. */
export type IdeChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

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
 * Resolve a usable, non-CLI model id for fire-and-forget IDE calls (e.g. inline
 * completion) where the caller has not picked a model. Prefers the first
 * enabled model of the first usable provider; returns `null` when none exists.
 */
export const resolveDefaultModel = async (): Promise<string | null> => {
  const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];
  const picked = pickForModel(providers, '');
  return picked ? picked.model : null;
};

/** Detect the "no usable model" case so the UI can show a targeted hint. */
export const classifyModelError = (error: unknown): 'no-model' | 'error' => {
  const message = error instanceof Error ? error.message : String(error);
  return /no usable model|no model|requires a generator/i.test(message) ? 'no-model' : 'error';
};

/**
 * Issue one non-streaming completion against the user's configured provider.
 * Resolves the provider lazily (per call) so a model added after startup is
 * picked up without a restart. Throws on failure; callers wrap into a result.
 */
const runProviderChat = async (model: string, messages: IdeChatMessage[], signal?: AbortSignal): Promise<string> => {
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

/**
 * Run one IDE completion, routing a `cli:<agentId>` model id to a CLI agent
 * (Claude Code, Codex, Gemini CLI…) and any other model id to the provider path.
 */
export const runIdeChat = async (model: string, messages: IdeChatMessage[], signal?: AbortSignal): Promise<string> => {
  return runAgentChatMessages((m, msgs, s) => runProviderChat(m, msgs as IdeChatMessage[], s), model, messages, signal);
};
