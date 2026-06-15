/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Provider-backed chat for the pipeline's planning/summary steps (spec
 * agent-company-pipeline, Task 7.2).
 *
 * The recursive orchestrator uses a model to make each role *decide* (delegate
 * vs execute) and to *summarise* children's results. That reasoning call goes
 * through the user's configured provider/model over the OpenAI-compatible
 * `/chat/completions` endpoint — the same call style as
 * `process/browser/providerChat.ts`, but renderer-side (it reads providers via
 * `ipcBridge.mode.listProviders`, which is a renderer API).
 *
 * This is ONLY the lightweight reasoning channel. The heavy, real work (reading
 * a codebase, writing code, running tests) is done by `roleExecutor`, which
 * drives a real CLI/assistant conversation — not this.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { ipcBridge } from '@/common';
import type { IProvider } from '@/common/config/storage';

/** A chat call: messages in, assistant text out. */
export type PipelineChat = (params: {
  /** Preferred model id (optional; the resolver falls back to the first usable). */
  model?: string;
  /** OpenAI-style message list. */
  messages: Array<{ role: string; content: string }>;
  /** Cancellation signal. */
  signal?: AbortSignal;
}) => Promise<string>;

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider configured enough to issue a chat call. */
const isUsable = (p: IProvider): boolean =>
  p.enabled !== false && Boolean(p.api_key) && Boolean(p.base_url) && Array.isArray(p.models) && p.models.length > 0;

/** Resolve the OpenAI-compatible chat endpoint for a provider. */
const resolveChatUrl = (provider: IProvider): string => {
  const base = (provider.base_url ?? '').replace(/\/+$/, '');
  return provider.is_full_url ? base : `${base}/chat/completions`;
};

/** First non-empty API key (the field may hold several, comma/newline-separated). */
const firstApiKey = (apiKeys: string): string =>
  apiKeys
    .split(/[,\n]/)
    .map((k) => k.trim())
    .find((k) => k.length > 0) ?? '';

/** Pick the provider owning `model` (preferring enabled), else any usable provider/model. */
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
 * Build a {@link PipelineChat} backed by the user's configured provider/model.
 * Resolves the provider lazily on each call so a model configured after startup
 * is picked up without a restart. Throws a clear error when nothing usable is
 * configured (the orchestrator turns it into a `run-error` event).
 */
export const createPipelineChat = (): PipelineChat => {
  return async ({ model, messages, signal }) => {
    const providers = (await ipcBridge.mode.listProviders.invoke().catch(() => [] as IProvider[])) ?? [];
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
