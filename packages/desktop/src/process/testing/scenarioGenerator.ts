/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scenario generator for the Testing layer (Yêu cầu 2b — UX).
 *
 * Turns a plain-language description ("mở example.com và kiểm tra có chữ Example
 * Domain") into a concrete {@link TestScenario} the orchestrator can run — so a
 * user never has to learn the `goto`/`assertText` step grammar by hand.
 *
 * It asks the user's configured provider/model over the OpenAI-compatible
 * `/chat/completions` endpoint, mirroring `company/companyGenerator.ts` and
 * `browser/providerChat.ts`: the provider list (with a usable `api_key`) is read
 * from aioncore (`GET /api/providers`) and the request is issued directly via
 * `fetch` (not `ClientFactory`, which expects camelCase `apiKey`). The model is
 * told the exact step grammar the web script-engine understands and must reply
 * with strict JSON, which we parse defensively.
 *
 * Nothing is hardcoded: when no usable model is configured it throws a clear
 * error the bridge surfaces as a friendly message (never a hang).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import { runAgentChatMessages } from '@process/services/agentChat';
import type { GenerateProgressFn, TestPlatform, TestScenario, TestStep } from './testingTypes';

/** Timeout for the generation call (ms). Kept short so a stuck model fails fast. */
const GENERATE_TIMEOUT_MS = 45_000;

/** Phrases a routed model returns instead of answering (treated as unusable here). */
const ROUTER_BLOCK_HINTS = ['use claude code', 'claude code cli', 'please use claude'];

/** Whether a model reply is a router/proxy refusal rather than a real answer. */
const isRouterBlock = (text: string): boolean => {
  const low = text.toLowerCase();
  return ROUTER_BLOCK_HINTS.some((h) => low.includes(h));
};

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider that is configured enough to issue a chat call. */
const isUsable = (p: IProvider): boolean =>
  p.enabled !== false && Boolean(p.api_key) && Boolean(p.base_url) && Array.isArray(p.models) && p.models.length > 0;

/** A provider + the specific model chosen to generate the scenario. */
type SelectedModel = { provider: IProvider; model: string };

/** Pick a usable provider+model, preferring a health-checked one (mirrors companyGenerator). */
const pickProviderModel = (providers: IProvider[], preferred?: string): SelectedModel | null => {
  const usable = providers.filter(isUsable);
  if (preferred) {
    const owner = usable.find((p) => p.models.includes(preferred) && isModelEnabled(p, preferred));
    if (owner) return { provider: owner, model: preferred };
  }
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

/** Resolve the OpenAI-compatible chat endpoint for a provider (honours the "Full URL" toggle). */
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

/** A platform-specific note about what the steps can do today. */
const platformNote = (platform: TestPlatform, appUrl?: string): string => {
  if (platform === 'web') {
    return appUrl
      ? `Target: web (an embedded browser). The app under test is at ${appUrl} — the FIRST step MUST be \`goto ${appUrl}\` (do NOT use any other URL like example.com).`
      : 'Target: web (an embedded browser). The app URL is UNKNOWN unless the user names one in their description.';
  }
  return `Target: ${platform}. Keep steps high-level and describe user actions; this platform's runner may be limited.`;
};

/** The exact grammar the web script-engine understands (one directive per step). */
const GRAMMAR = [
  'goto <url>            — navigate (https assumed if no scheme). Always the first step for web.',
  'wait <ms>             — pause for the given milliseconds.',
  'assertText <text>     — pass if the page text contains <text> (case-insensitive).',
  'assertTitle <text>    — pass if the document title contains <text>.',
  'click <css-selector>  — click the first matching element.',
  'type <css-selector> => <text>  — set a field value and fire input/change.',
].join('\n');

/** Build the system+user prompt asking for strict-JSON scenario steps. */
const buildPrompt = (description: string, platform: TestPlatform, appUrl?: string): string =>
  `You are a test designer for a multi-platform UI testing tool. Convert the user's plain-language
goal into a short, concrete test scenario.

${platformNote(platform, appUrl)}

Each step MUST be ONE line using EXACTLY this grammar (no other verbs):
${GRAMMAR}

Rules:
- "name" MUST be a short, clean scenario title. NEVER put a question, a URL, or parentheses asking
  for input in the name.
- Prefer a few meaningful assertions over many trivial ones (2–6 steps is typical). Do NOT pad with
  empty assertions (e.g. \`assertTitle\` with no text, or \`assertText html\`).
${
  platform === 'web' && !appUrl
    ? `- You do NOT know the app's URL. If the user's description does NOT contain a concrete URL or
  domain (e.g. "localhost:5173" or "mysite.com"), DO NOT invent one (never use example.com or
  localhost:3000). Instead reply with EXACTLY: {"needsUrl": true}
- Only if the description itself names a URL/domain, use that in the first \`goto\` step.`
    : appUrl
      ? `- The app URL is ${appUrl}; the FIRST step MUST be \`goto ${appUrl}\`. NEVER use example.com or any other URL.`
      : '- Use only the URL the user names; do not invent a placeholder.'
}
- Use only information the user gave; do not invent specific selectors you cannot know — prefer
  assertText/assertTitle/goto when unsure.
- Reply with STRICT JSON only, no prose, no code fences:
  {"name": "<short scenario name>", "steps": ["<step line>", "<step line>", ...]}

User goal:
${description}`;

/** Strip ```json fences and surrounding prose, returning the inner JSON text. */
const extractJson = (raw: string): string => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
};

/** Parse the model reply into a name + step descriptions, defensively. */
const parseScenario = (raw: string): { name: string; steps: string[] } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    throw new Error('The model did not return valid scenario JSON. Try rephrasing your description.');
  }
  const obj = parsed as { name?: unknown; steps?: unknown; needsUrl?: unknown };
  // The model signals it cannot know the app URL — guide the user instead of
  // fabricating one (which would just fail with connection-refused).
  if (obj.needsUrl === true) {
    throw new Error(
      'I don\'t know your app\'s address. Click "Detect from source" to point at your project, or open Advanced and enter the dev URL (e.g. http://localhost:5173).'
    );
  }
  const steps = Array.isArray(obj.steps)
    ? obj.steps.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
    : [];
  if (steps.length === 0) {
    throw new Error('The model returned no usable steps. Try describing the test more concretely.');
  }
  const name = typeof obj.name === 'string' && obj.name.trim().length > 0 ? obj.name.trim() : 'Generated test';
  return { name, steps };
};

/** Request to generate a scenario from a description. */
export type GenerateScenarioRequest = {
  /** Plain-language description of what to test. */
  description: string;
  /** Target platform. */
  platform: TestPlatform;
  /** Optional preferred model id (else the best usable one is chosen). */
  model?: string;
  /**
   * Optional URL of the app under test (web). When given, the generated steps
   * navigate here instead of a placeholder like example.com.
   */
  appUrl?: string;
  /**
   * Optional progress sink. Called with each phase update (preparing → thinking
   * → parsing → done) so the caller can surface a live status bar instead of a
   * bare button spinner.
   */
  onProgress?: GenerateProgressFn;
};

/** A generated scenario draft (steps are editable in the UI before running). */
export type GeneratedScenario = {
  /** Suggested scenario name. */
  name: string;
  /** Ordered steps in the script grammar. */
  steps: TestStep[];
};

/** Generates a {@link TestScenario} draft from a description. */
export type IScenarioGenerator = {
  generate: (request: GenerateScenarioRequest) => Promise<GeneratedScenario>;
};

/**
 * Create a scenario generator backed by the user's configured provider/model.
 *
 * Resolves the provider lazily on each call (so a model configured after startup
 * is picked up without a restart) and throws a clear error when none is usable.
 *
 * @returns A generator turning a description into an editable scenario draft.
 */
export const createScenarioGenerator = (): IScenarioGenerator => {
  const generate = async ({
    description,
    platform,
    model,
    appUrl,
    onProgress,
  }: GenerateScenarioRequest): Promise<GeneratedScenario> => {
    // Surface a terminal `error` phase if anything below throws, so the UI's
    // status bar reflects the failure instead of just snapping back to idle.
    const fail = (message: string): Error => {
      onProgress?.({ phase: 'error', message });
      return new Error(message);
    };

    const trimmed = description.trim();
    if (trimmed.length === 0) throw fail('Describe what you want to test first.');

    onProgress?.({ phase: 'preparing', message: trimmed.slice(0, 120), percent: 10 });
    const prompt = buildPrompt(trimmed, platform, appUrl?.trim() || undefined);

    // Provider-backed completion (used unless the user picked a CLI agent).
    const providerRun = async (selectedModel: string): Promise<string> => {
      const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];
      const selected = pickProviderModel(providers, selectedModel);
      if (!selected) {
        throw new Error(
          'No usable model is configured. Open Settings → Model and add a provider/model, then try again.'
        );
      }

      const url = resolveChatUrl(selected.provider);
      const apiKey = firstApiKey(selected.provider.api_key);

      // Now that the model is resolved, tell the UI which model is "thinking".
      onProgress?.({ phase: 'thinking', message: selected.model, percent: 45 });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
          throw new Error('The model returned an empty response while designing the test.');
        }
        if (isRouterBlock(content)) {
          throw new Error(
            `The selected model ("${selected.model}") can't be called directly (it routed you to a CLI). Pick a CLI agent or a different model in the box above the AI button, then try again.`
          );
        }
        return content;
      } finally {
        clearTimeout(timer);
      }
    };

    // `cli:<agentId>` → CLI agent; any other model id → provider path above.
    // Emit a `thinking` update up front (the provider path refines it with the
    // resolved model id); CLI agents don't hit `providerRun`, so this is their
    // only signal.
    onProgress?.({ phase: 'thinking', message: model || 'auto', percent: 40 });
    let content: string;
    try {
      content = await runAgentChatMessages(
        () => providerRun(model ?? ''),
        model ?? '',
        [{ role: 'user', content: prompt }],
        undefined
      );
    } catch (error) {
      throw fail(error instanceof Error ? error.message : 'Generation failed.');
    }

    onProgress?.({ phase: 'parsing', message: '', percent: 85 });
    let draft: { name: string; steps: string[] };
    try {
      draft = parseScenario(content);
    } catch (error) {
      throw fail(error instanceof Error ? error.message : 'Could not parse the generated test.');
    }
    const { name, steps } = draft;
    const result: GeneratedScenario = {
      name,
      steps: steps.map((line, index) => ({ id: `s${index + 1}`, description: line })),
    };
    onProgress?.({ phase: 'done', message: String(result.steps.length), percent: 100 });
    return result;
  };

  return { generate };
};

/** Assemble a runnable {@link TestScenario} from a generated draft + platform. */
export const scenarioFromDraft = (
  draft: GeneratedScenario,
  platform: TestPlatform,
  viewport?: TestScenario['viewport']
): TestScenario => ({
  id: `scn-${Date.now()}`,
  name: draft.name,
  platform,
  steps: draft.steps,
  viewport,
});
