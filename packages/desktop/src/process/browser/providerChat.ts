/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider-backed chat for the web-agent runner (Requirement 1, criterion 1.2).
 *
 * Builds an {@link AgentChat} that calls the user's configured provider/model
 * over the OpenAI-compatible `/chat/completions` endpoint. The call style
 * mirrors `company/companyGenerator.ts`: the provider list (with a usable
 * `api_key`) is read from aioncore (`GET /api/providers`) and the request is
 * issued directly via `fetch` (not through `ClientFactory`, which expects a
 * camelCase `apiKey` and throws outside the chat pipeline).
 *
 * Unlike the company generator, the browser agent has a **specific model id the
 * user picked** in the UI (criterion 1.2). We resolve the provider that owns
 * that model; if it is not found (model removed, etc.) we fall back to the first
 * usable provider/model so the agent still runs, and throw a clear error only
 * when nothing usable is configured (the chat surfaces it as an error event).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import type { AgentChat } from './webAgentRunner';

/**
 * Upper bound (ms) for a single completion request. A stalled endpoint or an
 * over-large multimodal payload must fail cleanly rather than hang the caller
 * forever. 90s comfortably covers a vision call on a large image while still
 * surfacing a friendly timeout if the model never replies.
 */
const PROVIDER_CHAT_TIMEOUT_MS = 90_000;

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider that is configured enough to issue a chat call. */
const isUsable = (p: IProvider): boolean =>
  p.enabled !== false && Boolean(p.api_key) && Boolean(p.base_url) && Array.isArray(p.models) && p.models.length > 0;

/** Resolve the OpenAI-compatible chat endpoint for a provider (mirrors the app's "Full URL" toggle). */
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

/** Find the provider that owns `model`, preferring enabled ones; else any usable provider/model. */
const pickForModel = (providers: IProvider[], model: string): { provider: IProvider; model: string } | null => {
  const usable = providers.filter(isUsable);
  const owner = usable.find((p) => p.models.includes(model) && isModelEnabled(p, model));
  if (owner) return { provider: owner, model };
  // Fall back to the first usable provider/model so the agent still runs.
  for (const provider of usable) {
    const fallback = provider.models.find((m) => isModelEnabled(provider, m)) ?? provider.models[0];
    if (fallback) return { provider, model: fallback };
  }
  return null;
};

/**
 * Build an {@link AgentChat} backed by the user's configured provider/model.
 *
 * Resolves the provider lazily on each call so a model configured after startup
 * is picked up without a restart. Throws a clear error when no usable provider
 * exists; the runner converts that into an `error` event so the chat never hangs.
 */
export const createProviderChat = (): AgentChat => {
  return async ({ model, messages, signal }) => {
    const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];
    const selected = pickForModel(providers, model);
    if (!selected) {
      throw new Error('No usable model is configured. Open Settings → Model and add a provider/model, then try again.');
    }

    const url = resolveChatUrl(selected.provider);
    const apiKey = firstApiKey(selected.provider.api_key);

    // Enforce an upper bound on the request so a stalled endpoint fails cleanly
    // instead of hanging forever. When the caller passes its own `signal`, we
    // chain it so an explicit cancel still aborts the in-flight request.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), PROVIDER_CHAT_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) timeout.abort();
      else signal.addEventListener('abort', () => timeout.abort(), { once: true });
    }

    let response: Awaited<ReturnType<typeof fetch>>;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: selected.model, messages, stream: false }),
        signal: timeout.signal,
      });
    } catch (error) {
      if (timeout.signal.aborted && !(signal?.aborted ?? false)) {
        throw new Error(
          `The model did not respond within ${Math.round(PROVIDER_CHAT_TIMEOUT_MS / 1000)}s. ` +
            'Try a smaller input (or a faster model), then retry.',
          { cause: error }
        );
      }
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timer);
    }

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
