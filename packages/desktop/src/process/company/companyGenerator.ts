/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main-process role-chart generator for the agent-company model (Requirement
 * 3.11). Produces a {@link GenerateFn} that asks the user's configured
 * provider/model to design a company from a free-text description.
 *
 * The provider list (with a usable `api_key`) is read from aioncore
 * (`GET /api/providers`). The chat call is issued **directly** against the
 * provider's OpenAI-compatible `/chat/completions` endpoint via `fetch`, rather
 * than through `ClientFactory` — the shared `OpenAIRotatingClient` passes the
 * key as `api_key` (snake_case) instead of the SDK's required `apiKey`
 * (camelCase) and therefore throws "Missing credentials" outside the chat
 * pipeline. Calling the endpoint directly keeps this feature self-contained and
 * matches exactly what the provider health-check exercises (a plain
 * `POST {base_url}/chat/completions`).
 *
 * Nothing is hardcoded: if no usable provider/model is configured the generator
 * throws a clear error which the bridge surfaces as a friendly message (never a
 * hang).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import type { GenerateFn } from './companyConfig';

/** Timeout for the role-chart design call (ms). Design is a single short turn. */
const GENERATE_TIMEOUT_MS = 120_000;

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider + the specific model chosen to act as the company designer. */
type SelectedModel = { provider: IProvider; model: string };

/**
 * Pick the best provider + model to use as the company designer.
 *
 * Preference order:
 * 1. A model previously health-checked `healthy` on an enabled provider.
 * 2. The first enabled model on the first enabled provider with a key + base URL.
 *
 * Returns `null` when nothing usable is configured.
 */
const pickProviderModel = (providers: IProvider[]): SelectedModel | null => {
  const usable = providers.filter(
    (p) => p.enabled !== false && p.api_key && p.base_url && Array.isArray(p.models) && p.models.length > 0
  );

  for (const provider of usable) {
    const healthy = provider.models.find(
      (m) => isModelEnabled(provider, m) && provider.model_health?.[m]?.status === 'healthy'
    );
    if (healthy) return { provider, model: healthy };
  }

  for (const provider of usable) {
    const model = provider.models.find((m) => isModelEnabled(provider, m)) ?? provider.models[0];
    if (model) return { provider, model };
  }

  return null;
};

/**
 * Resolve the OpenAI-compatible chat endpoint for a provider.
 *
 * When `is_full_url` is set the stored `base_url` IS the complete endpoint;
 * otherwise the standard `/chat/completions` suffix is appended to the base
 * (trailing slashes normalized). This mirrors the app's own "Full URL" toggle.
 */
const resolveChatUrl = (provider: IProvider): string => {
  const base = provider.base_url.replace(/\/+$/, '');
  if (provider.is_full_url) return base;
  return `${base}/chat/completions`;
};

/** First non-empty API key (the field may hold several, comma/newline-separated). */
const firstApiKey = (apiKeys: string): string =>
  apiKeys
    .split(/[,\n]/)
    .map((k) => k.trim())
    .find((k) => k.length > 0) ?? '';

/**
 * Resolve the id of the model that would power this company's agents, or
 * `undefined` when none is configured. Used by the bridge to label the
 * structure with a "powered by" hint (display only).
 */
export const resolveCompanyModelId = async (): Promise<string | undefined> => {
  const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];
  return pickProviderModel(providers)?.model;
};

/**
 * Build a {@link GenerateFn} backed by the user's configured provider/model.
 *
 * The function resolves the provider lazily on each call (so a model configured
 * after startup is picked up without a restart) and throws a clear error when no
 * usable provider exists — the bridge converts that into a friendly result, so
 * the renderer never hangs.
 */
export const createCompanyGenerator = (): GenerateFn => {
  return async (prompt: string): Promise<string> => {
    const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];
    const selected = pickProviderModel(providers);
    if (!selected) {
      throw new Error('No usable model is configured. Open Settings → Model and add a provider/model, then try again.');
    }

    const url = resolveChatUrl(selected.provider);
    const apiKey = firstApiKey(selected.provider.api_key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: selected.model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Model request failed (HTTP ${response.status}). ${detail.slice(0, 300)}`);
      }

      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim().length === 0) {
        throw new Error('The model returned an empty response while designing the company.');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  };
};
