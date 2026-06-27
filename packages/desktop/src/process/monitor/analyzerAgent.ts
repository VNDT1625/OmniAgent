/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `analyzerAgent` — the provider-backed {@link AnalyzerAgent} for the bug
 * monitor (Yêu cầu 6, criterion 6.3). Given a {@link BugReport} + relevant code
 * snippets, it asks the user's configured provider/model to return a structured
 * analysis: root cause, a fix explanation, a unified diff, and a risk level.
 *
 * The provider call mirrors `company/companyGenerator.ts` exactly: the provider
 * list (with a usable `api_key`) is read from aioncore (`GET /api/providers`)
 * and the request is issued directly against the OpenAI-compatible
 * `/chat/completions` endpoint via `fetch` (not through `ClientFactory`, which
 * expects camelCase `apiKey` and throws outside the chat pipeline). Nothing is
 * hardcoded; when no usable provider exists it throws a clear error that the
 * caller surfaces (the report is still stored, only the proposal is skipped).
 *
 * The model is told to answer with a single fenced JSON object; the parser is
 * defensive (strips fences, tolerates extra prose) and clamps the risk to a
 * known value. Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import type { AgentAnalysis, AnalyzerAgent } from './rootCauseAnalyzer';

/** Timeout for a single analysis call (ms). One short turn. */
const ANALYZE_TIMEOUT_MS = 120_000;

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider + the specific model chosen to act as the analyzer. */
type SelectedModel = { provider: IProvider; model: string };

/** Pick the best usable provider/model (prefers a health-checked model). */
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

/** The system instruction defining the analyzer's job + strict output shape. */
const SYSTEM_PROMPT = [
  'You are a senior software engineer analysing a bug report from an Electron + TypeScript desktop app (Tomni Agentic, a fork of AionUi).',
  'Given the error and the relevant source snippets, identify the ROOT CAUSE and propose a MINIMAL, safe fix.',
  'Respond with exactly ONE JSON object (optionally inside a ```json fenced block) and nothing else, with this shape:',
  '{',
  '  "rootCause": "one or two sentences, plain language",',
  '  "explanation": "what the fix changes and why it is safe",',
  '  "diff": "a unified diff (--- a/… +++ b/…) applying ONLY to files shown in the context; empty string if you cannot propose one",',
  '  "risk": "low" | "medium" | "high"',
  '}',
  'Rules: prefer the smallest change that fixes the cause; never invent file paths not present in the context; set risk honestly (low = localised/obvious, high = broad/uncertain).',
].join('\n');

/** Risk classification, clamped to the allowed set. */
const clampRisk = (value: unknown): AgentAnalysis['risk'] => {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return 'high'; // unknown → most conservative (forces review, never auto-applies)
};

/** Strip ```json fences / surrounding prose and parse the first JSON object. */
export const parseAnalysisResponse = (raw: string): AgentAnalysis => {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // If there is leading/trailing prose, isolate the outermost JSON object.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) text = text.slice(firstBrace, lastBrace + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('The analyzer model did not return valid JSON.');
  }

  const rootCause = typeof parsed.rootCause === 'string' ? parsed.rootCause : '';
  const explanation = typeof parsed.explanation === 'string' ? parsed.explanation : '';
  const diff = typeof parsed.diff === 'string' ? parsed.diff : '';
  if (!rootCause && !explanation) {
    throw new Error('The analyzer model returned an empty analysis.');
  }
  return { rootCause, explanation, diff, risk: clampRisk(parsed.risk) };
};

/** Build the user message: the error + breadcrumbs + code snippets. */
const buildUserPrompt = (input: Parameters<AnalyzerAgent['analyze']>[0]): string => {
  const { report, code } = input;
  const parts: string[] = [];
  parts.push(`# Error\nTitle: ${report.title}\nMessage: ${report.message}`);
  if (report.stack) parts.push(`# Stack\n${report.stack}`);
  if (report.breadcrumbs.length > 0) parts.push(`# Recent actions\n${report.breadcrumbs.slice(-20).join('\n')}`);
  if (report.description) parts.push(`# User description\n${report.description}`);
  if (code.length > 0) {
    const snippets = code.map((c) => `## ${c.path}\n\`\`\`\n${c.content}\n\`\`\``).join('\n\n');
    parts.push(`# Relevant source\n${snippets}`);
  } else {
    parts.push('# Relevant source\n(no source snippets could be gathered from the stack)');
  }
  return parts.join('\n\n');
};

/**
 * Create an {@link AnalyzerAgent} backed by the user's configured provider/model.
 * Resolves the provider lazily on each call so a model configured after startup
 * is picked up without a restart.
 */
export const createAnalyzerAgent = (): AnalyzerAgent => {
  return {
    analyze: async (input) => {
      const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];
      const selected = pickProviderModel(providers);
      if (!selected) {
        throw new Error(
          'No usable model is configured for bug analysis. Open Settings → Model and add a provider/model.'
        );
      }

      const url = resolveChatUrl(selected.provider);
      const apiKey = firstApiKey(selected.provider.api_key);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: selected.model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: buildUserPrompt(input) },
            ],
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`Analyzer request failed (HTTP ${response.status}). ${detail.slice(0, 300)}`);
        }
        const json = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new Error('The analyzer model returned an empty response.');
        }
        return parseAnalysisResponse(content);
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
