/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Studio chat IPC bridge — powers the document AI side-panel in the Studio
 * editor (the "ask the assistant to edit this file" panel).
 *
 * The renderer cannot call model providers directly (CORS / `webSecurity`), so —
 * exactly like the web-agent (`process/browser/providerChat.ts`) and the company
 * generator — the request is issued from the Main process against the user's
 * configured provider over the OpenAI-compatible `/chat/completions` endpoint.
 *
 * One channel: `studio.chat` — a single, non-streaming completion. The renderer
 * sends the picked model id, the conversation messages, and (optionally) the
 * current document so the assistant can answer about / rewrite it. Returns a
 * {@link StudioResult} envelope so a failure is observable instead of hanging
 * the renderer (the platform bridge swallows rejected promises).
 *
 * The global bootstrap (Task 15.x) calls {@link registerStudioChatBridge} once;
 * this module does not wire itself in (mirrors `companyBridge.ts`).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import { stripTokenWatermarkNotice } from '@/common/chat/chatLib';
import { runAgentChatMessages } from '@process/services/agentChat';

/** IPC channel names for the Studio surface (renderer-safe contract). */
export const STUDIO_CHANNELS = {
  chat: 'studio.chat',
} as const;

/** One chat message exchanged with the document assistant. */
export type StudioChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

/** Request for {@link STUDIO_CHANNELS.chat}. */
export type StudioChatRequest = {
  /** Model id the user picked in the panel. */
  model: string;
  /** The running conversation (user/assistant turns). */
  messages: StudioChatMessage[];
  /** Absolute workspace selected by the user for document creation. */
  workspace?: string;
};

/**
 * Result envelope — always resolves (never rejects), so the renderer can branch
 * on `ok`. `code: 'no-model'` flags the "no usable model configured" case.
 */
export type StudioResult<T> = { ok: true; data: T } | { ok: false; error: string; code: 'no-model' | 'error' };

/** Typed Studio channels. Exported for bootstrap registration wiring. */
export const studioChannels = {
  chat: bridge.buildProvider<StudioResult<string>, StudioChatRequest>(STUDIO_CHANNELS.chat),
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

/** Detect the "no usable model" case so the UI can show a targeted hint. */
const classify = (error: unknown): 'no-model' | 'error' => {
  const message = error instanceof Error ? error.message : String(error);
  return /no usable model|no model|requires a generator/i.test(message) ? 'no-model' : 'error';
};

/**
 * Issue one non-streaming completion against the user's configured provider.
 * Resolves the provider lazily so a model added after startup is picked up
 * without a restart. Throws on failure; the caller wraps it into a result.
 */
const runProviderChat = async (model: string, messages: StudioChatRequest['messages']): Promise<string> => {
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
  const raw = json.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('The model returned an empty response.');
  }
  return stripTokenWatermarkNotice(raw).trim();
};

/**
 * Run one completion, routing a `cli:<agentId>` model id to a CLI agent (Claude
 * Code, Codex, Gemini CLI…) and any other model id to the provider path above.
 */
const runChat = async (req: StudioChatRequest): Promise<string> => {
  return runAgentChatMessages(
    (model, messages) => runProviderChat(model, messages as StudioChatRequest['messages']),
    req.model,
    req.messages,
    undefined,
    { workspace: req.workspace, surface: 'office', permissionMode: 'read-only' }
  );
};

/**
 * Register the Studio chat IPC handler. Idempotent (re-registration replaces the
 * bound handler). Intended to be called once during Main-process bootstrap.
 */
export function registerStudioChatBridge(): void {
  studioChannels.chat.provider(async (req): Promise<StudioResult<string>> => {
    try {
      return { ok: true, data: await runChat(req) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[StudioChatBridge] chat failed:', error);
      return { ok: false, error: message, code: classify(error) };
    }
  });
}
