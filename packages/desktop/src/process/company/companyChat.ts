/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider-backed chat for the company conversation engine (Requirement 3 —
 * boss ↔ employee dialogue).
 *
 * Builds a {@link CompanyChat} that calls the user's configured provider/model
 * over the OpenAI-compatible `/chat/completions` endpoint. The call style
 * mirrors `browser/providerChat.ts` and `company/companyGenerator.ts`: the
 * provider list (with a usable `api_key`) is read from the native Tomny provider store and the request is issued directly via `fetch` (not
 * through `ClientFactory`, which expects a camelCase `apiKey` and throws outside
 * the chat pipeline).
 *
 * When the engine passes a specific `model` id (e.g. a role's assigned model) we
 * resolve the provider that owns it; otherwise — and as a fallback when the
 * model was removed — we use the first usable provider/model so the company
 * still runs. A clear error is thrown only when nothing usable is configured;
 * the engine converts it into a `run-error` event so the UI never hangs.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { IProvider } from '@/common/config/storage';
import { getReadyProviderStore } from '@process/services/tomnyProviderBridge';
import { isCliModelId, runAgentChatMessages } from '@process/services/agentChat';
import type { CompanyChat } from './companyConversation';

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider that is configured enough to issue a chat call. */
const isUsable = (p: IProvider): boolean =>
  p.enabled !== false && Boolean(p.api_key) && Boolean(p.base_url) && Array.isArray(p.models) && p.models.length > 0;

/** Resolve the OpenAI-compatible chat endpoint for a provider. */
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

/** Find the provider owning `model` (preferring enabled), else any usable provider/model. */
const pick = (providers: IProvider[], model?: string): { provider: IProvider; model: string } | null => {
  const usable = providers.filter(isUsable);
  if (model) {
    const owner = usable.find((p) => p.models.includes(model) && isModelEnabled(p, model));
    if (owner) return { provider: owner, model };
  }
  for (const provider of usable) {
    const fallback = provider.models.find((m) => isModelEnabled(provider, m)) ?? provider.models[0];
    if (fallback) return { provider, model: fallback };
  }
  return null;
};

/**
 * Build a {@link CompanyChat} backed by the user's configured provider/model.
 * Resolves the provider lazily on each call so a model configured after startup
 * is picked up without a restart.
 */
export const createCompanyChat = (): CompanyChat => {
  return async ({ model, messages, signal }) => {
    if (model && isCliModelId(model)) {
      return runAgentChatMessages(
        async () => {
          throw new Error('CLI routing unexpectedly fell through to the provider transport.');
        },
        model,
        messages,
        signal,
        { surface: 'chat', permissionMode: 'workspace-write' }
      );
    }
    const providers = await (await getReadyProviderStore()).list();
    const selected = pick(providers, model);
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
    if (typeof content !== 'string') {
      throw new Error('The model returned an empty response.');
    }
    return content;
  };
};
