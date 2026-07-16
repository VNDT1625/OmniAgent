/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Make Video IPC bridge — the Main-process backend for the AI movie/anime
 * factory. The whole pipeline runs against the user's configured cloud
 * providers: an LLM authors a scene-by-scene script, and a cloud image model
 * renders each scene.
 *
 * Like the Studio chat bridge (`process/studio/studioChatBridge.ts`), the
 * renderer cannot call model providers directly (CORS / `webSecurity`), so each
 * request is issued from the Main process against the OpenAI-compatible
 * `/chat/completions` endpoint (script) or via the shared image-generation core
 * (scene images). Provider resolution is lazy so a model added after startup is
 * picked up without a restart.
 *
 * Channels:
 * - `makevideo.list` / `makevideo.get` / `makevideo.save` / `makevideo.remove`
 *   proxy CRUD to a singleton {@link createMakeVideoStore}.
 * - `makevideo.generate-script` runs one non-streaming LLM completion and parses
 *   a strict JSON array of scenes out of the reply.
 * - `makevideo.generate-image` renders one scene via {@link executeImageGeneration}
 *   and persists the saved image path on the scene.
 *
 * Every channel resolves a {@link MakeVideoResult} envelope (never rejects) so a
 * failure is observable instead of hanging the renderer (the platform bridge
 * swallows rejected promises).
 *
 * The global bootstrap calls {@link registerMakeVideoBridge} once; this module
 * does not wire itself in (mirrors `studioChatBridge.ts` / `companyBridge.ts`).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { bridge } from '@office-ai/platform';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider, TProviderWithModel } from '@/common/config/storage';
import { executeImageGeneration } from '@/common/chat/imageGenCore';
import { runAgentChatMessages } from '@process/services/agentChat';
import { createMakeVideoStore, type IMakeVideoStore } from './makeVideoStore';
import { parseScenes } from './scriptParse';
import { isTransientError, withRetry, withStatus } from './retry';
import type {
  ExportFinalData,
  ExportFinalRequest,
  GenerateVideoClipData,
  GenerateVideoClipRequest,
  GenerateVoiceData,
  GenerateVoiceRequest,
  MakeVideoResult,
  Scene,
  ScriptRequest,
  VideoProject,
} from './makeVideoTypes';
import { generateVoice } from './voiceGen';
import { generateVideoClip } from './videoClipGen';
import { exportFinalVideo } from './finalExport';

/** IPC channel names for the Make Video surface (renderer-safe contract). */
export const MAKE_VIDEO_CHANNELS = {
  listProjects: 'makevideo.list',
  getProject: 'makevideo.get',
  saveProject: 'makevideo.save',
  removeProject: 'makevideo.remove',
  generateScript: 'makevideo.generate-script',
  generateImage: 'makevideo.generate-image',
  generateVoice: 'makevideo.generate-voice',
  generateVideoClip: 'makevideo.generate-video-clip',
  exportFinal: 'makevideo.export-final',
} as const;

/** Request for {@link MAKE_VIDEO_CHANNELS.getProject} / `removeProject`. */
export type ProjectIdRequest = { id: string };

/** Request for {@link MAKE_VIDEO_CHANNELS.generateImage}. */
export type GenerateImageRequest = {
  /** Project that owns the scene. */
  projectId: string;
  /** Scene to render an image for. */
  sceneId: string;
  /** The (English, visually detailed) image-generation prompt. */
  prompt: string;
  /** Image model id the renderer picked from the user's configured models. */
  model: string;
};

/** Result data for {@link MAKE_VIDEO_CHANNELS.generateImage}. */
export type GenerateImageData = {
  /** Absolute path to the saved scene image, or null when none was produced. */
  imagePath: string | null;
  /** Human-readable model response / description. */
  text: string;
};

/** Typed Make Video channels. Exported for bootstrap registration wiring. */
export const makeVideoChannels = {
  listProjects: bridge.buildProvider<MakeVideoResult<VideoProject[]>, void>(MAKE_VIDEO_CHANNELS.listProjects),
  getProject: bridge.buildProvider<MakeVideoResult<VideoProject | null>, ProjectIdRequest>(
    MAKE_VIDEO_CHANNELS.getProject
  ),
  saveProject: bridge.buildProvider<MakeVideoResult<VideoProject>, VideoProject>(MAKE_VIDEO_CHANNELS.saveProject),
  removeProject: bridge.buildProvider<MakeVideoResult<VideoProject[]>, ProjectIdRequest>(
    MAKE_VIDEO_CHANNELS.removeProject
  ),
  generateScript: bridge.buildProvider<MakeVideoResult<Scene[]>, ScriptRequest>(MAKE_VIDEO_CHANNELS.generateScript),
  generateImage: bridge.buildProvider<MakeVideoResult<GenerateImageData>, GenerateImageRequest>(
    MAKE_VIDEO_CHANNELS.generateImage
  ),
  generateVoice: bridge.buildProvider<MakeVideoResult<GenerateVoiceData>, GenerateVoiceRequest>(
    MAKE_VIDEO_CHANNELS.generateVoice
  ),
  generateVideoClip: bridge.buildProvider<MakeVideoResult<GenerateVideoClipData>, GenerateVideoClipRequest>(
    MAKE_VIDEO_CHANNELS.generateVideoClip
  ),
  exportFinal: bridge.buildProvider<MakeVideoResult<ExportFinalData>, ExportFinalRequest>(
    MAKE_VIDEO_CHANNELS.exportFinal
  ),
};

// ---------------------------------------------------------------------------
// Provider helpers (mirrors studioChatBridge.ts)
// ---------------------------------------------------------------------------

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider configured enough to issue a call. */
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

/** Fetch the user's configured providers (empty list on any failure). */
const loadProviders = async (): Promise<IProvider[]> =>
  (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];

// ---------------------------------------------------------------------------
// Script generation (provider-backed LLM)
// ---------------------------------------------------------------------------

/** Build the system prompt instructing the model to act as a screenwriter. */
const buildScriptSystemPrompt = (req: ScriptRequest): string =>
  [
    'You are a professional film and anime screenwriter.',
    `Write a scene-by-scene shooting script for a short video about: "${req.topic}".`,
    `The visual and narrative style is: "${req.style}".`,
    `Return EXACTLY ${req.sceneCount} scenes.`,
    'Respond with STRICT JSON only — a single JSON array, no prose, no markdown fences.',
    'Each array element MUST be an object with exactly these string fields: "title", "narration", "imagePrompt".',
    `- "title": a short scene title, written in ${req.language}.`,
    `- "narration": the voice-over for the scene, written in ${req.language}.`,
    `- "imagePrompt": a single, visually detailed image-generation prompt written in ENGLISH. Describe camera angle, lighting, composition, mood, and reflect the "${req.style}" style. Do not reference other scenes.`,
    'Do not include any keys other than title, narration, and imagePrompt.',
  ].join('\n');

/**
 * Re-exported from {@link ./scriptParse} so existing imports
 * (`import { parseScenes } from '.../makeVideoBridge'`) keep working. The robust
 * fence-stripping / bracket-balanced / repair-on-failure parser lives there and
 * is unit-tested in isolation (no network/provider needed).
 */
export { parseScenes } from './scriptParse';

/**
 * `fetch` with an abort-based timeout. Combines an optional external signal with
 * an internal deadline so a hung provider never blocks the pipeline past
 * `timeoutMs`. The returned error names the timeout so the retry classifier and
 * the user both get a clear message.
 */
const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  external?: AbortSignal
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  external?.addEventListener('abort', onExternalAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (external?.aborted) throw new Error('Request aborted.', { cause: error });
    if (controller.signal.aborted) {
      throw new Error(`Model request timed out after ${Math.round(timeoutMs / 1000)}s.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
};

/** Per-request timeout for one non-streaming script completion (ms). */
const SCRIPT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Issue one non-streaming completion against the user's configured provider.
 * Routes a `cli:<agentId>` model id to a CLI agent. Throws on failure.
 *
 * Provider resolution happens once; the network call itself is retried with
 * exponential backoff on transient failures (HTTP 429/5xx, network flaps) so a
 * rate limit or gateway blip does not abort a multi-scene generation.
 */
const runProviderChat = async (model: string, messages: Array<{ role: string; content: string }>): Promise<string> => {
  const providers = await loadProviders();
  const selected = pickForModel(providers, model);
  if (!selected) {
    throw new Error('No usable model is configured. Open Settings → Model and add a provider/model, then try again.');
  }

  const url = resolveChatUrl(selected.provider);
  const apiKey = firstApiKey(selected.provider.api_key);

  return withRetry(
    async () => {
      const response = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model: selected.model, messages, stream: false }),
        },
        SCRIPT_REQUEST_TIMEOUT_MS
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw withStatus(
          new Error(`Model request failed (HTTP ${response.status}). ${detail.slice(0, 300)}`),
          response.status
        );
      }

      const json = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('The model returned an empty response.');
      }
      return content;
    },
    { isRetriable: isTransientError }
  );
};

/**
 * Generate a script: ask the model (provider OR CLI agent) for a JSON scene
 * array and parse it into {@link Scene}s. Throws on failure; the caller wraps it
 * into a result envelope.
 *
 * Exported so the Automation `action.app.makeVideo` connector can reuse the
 * exact same provider-backed generation without duplicating provider logic.
 */
export const runScript = async (req: ScriptRequest): Promise<Scene[]> => {
  const messages = [
    { role: 'system', content: buildScriptSystemPrompt(req) },
    {
      role: 'user',
      content: `Topic: ${req.topic}\nStyle: ${req.style}\nLanguage: ${req.language}\nScenes: ${req.sceneCount}`,
    },
  ];
  const content = await runAgentChatMessages(
    (model, msgs) => runProviderChat(model, msgs as Array<{ role: string; content: string }>),
    req.model,
    messages,
    undefined
  );
  return parseScenes(content, req.sceneCount, randomUUID);
};

// ---------------------------------------------------------------------------
// Image generation (cloud image model via the shared core)
// ---------------------------------------------------------------------------

/** Resolve the workspace dir for saved scene images (userData/make-video). */
const resolveImageWorkspaceDir = async (): Promise<string> => {
  const dir = path.join(app.getPath('userData'), 'make-video');
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
};

/** Build the {@link TProviderWithModel} owning `model`, or null when unconfigured. */
const pickImageProvider = (providers: IProvider[], model: string): TProviderWithModel | null => {
  const owner = providers.filter(isUsable).find((p) => p.models.includes(model));
  if (!owner) return null;
  return {
    id: owner.id,
    name: owner.name,
    platform: owner.platform,
    base_url: owner.base_url,
    api_key: firstApiKey(owner.api_key),
    use_model: model,
    capabilities: owner.capabilities,
    context_limit: owner.context_limit,
    model_protocols: owner.model_protocols,
    bedrock_config: owner.bedrock_config,
    enabled: owner.enabled,
    model_enabled: owner.model_enabled,
    model_health: owner.model_health,
    is_full_url: owner.is_full_url,
  };
};

/**
 * Render one scene image via the shared {@link executeImageGeneration} core.
 * Returns the saved image path (preferring the structured `imagePath` field,
 * falling back to parsing it out of the human-readable `text`) plus the model
 * description. Throws on hard failures; the caller wraps it into a result.
 *
 * Exported so the Automation `action.app.makeVideo` connector can render scenes
 * through the same cloud image pipeline.
 */
export const runImage = async (req: GenerateImageRequest): Promise<GenerateImageData> => {
  const providers = await loadProviders();
  const provider = pickImageProvider(providers, req.model);
  if (!provider) {
    throw new Error(
      'no-image-model: no usable image generation model is configured. Select an image model in Settings.'
    );
  }

  const workspaceDir = await resolveImageWorkspaceDir();
  const result = await withRetry(() => executeImageGeneration({ prompt: req.prompt }, provider, workspaceDir), {
    isRetriable: (error) =>
      // The image core resolves a `{ success:false, error }` instead of throwing
      // for many failures, so transient retries here only catch thrown network
      // flaps; the success-flag path is handled below.
      isTransientError(error),
  });

  if (!result.success) {
    throw new Error(result.error || result.text || 'Image generation failed.');
  }

  // Prefer the structured path; fall back to parsing "saved to: <path>" out of
  // the human-readable text the core returns.
  const fromText = result.text.match(/saved to:\s*(.+\.(?:jpg|jpeg|png|gif|webp|bmp|tiff|svg))/i);
  const imagePath = result.imagePath ?? (fromText ? fromText[1].trim() : null);

  return { imagePath, text: result.text };
};

// ---------------------------------------------------------------------------
// Store singleton + registration
// ---------------------------------------------------------------------------

let storeSingleton: IMakeVideoStore | null = null;
const getStore = (): IMakeVideoStore => {
  if (!storeSingleton) storeSingleton = createMakeVideoStore();
  return storeSingleton;
};

const ok = <T>(data: T): MakeVideoResult<T> => ({ ok: true, data });
const fail = <T>(error: unknown, code: 'no-model' | 'no-image-model' | 'error'): MakeVideoResult<T> => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
  code,
});

/**
 * Register every Make Video IPC handler. Idempotent (re-registration replaces
 * the bound handlers). Intended to be called once during Main-process bootstrap.
 */
export function registerMakeVideoBridge(): void {
  makeVideoChannels.listProjects.provider(async (): Promise<MakeVideoResult<VideoProject[]>> => {
    try {
      return ok(await getStore().list());
    } catch (error) {
      console.error('[MakeVideoBridge] list failed:', error);
      return fail<VideoProject[]>(error, 'error');
    }
  });

  makeVideoChannels.getProject.provider(async (req): Promise<MakeVideoResult<VideoProject | null>> => {
    try {
      return ok(await getStore().get(req.id));
    } catch (error) {
      console.error('[MakeVideoBridge] get failed:', error);
      return fail<VideoProject | null>(error, 'error');
    }
  });

  makeVideoChannels.saveProject.provider(async (req): Promise<MakeVideoResult<VideoProject>> => {
    try {
      return ok(await getStore().save(req));
    } catch (error) {
      console.error('[MakeVideoBridge] save failed:', error);
      return fail<VideoProject>(error, 'error');
    }
  });

  makeVideoChannels.removeProject.provider(async (req): Promise<MakeVideoResult<VideoProject[]>> => {
    try {
      return ok(await getStore().remove(req.id));
    } catch (error) {
      console.error('[MakeVideoBridge] remove failed:', error);
      return fail<VideoProject[]>(error, 'error');
    }
  });

  makeVideoChannels.generateScript.provider(async (req): Promise<MakeVideoResult<Scene[]>> => {
    try {
      return ok(await runScript(req));
    } catch (error) {
      console.error('[MakeVideoBridge] generate-script failed:', error);
      return fail<Scene[]>(error, classify(error));
    }
  });

  makeVideoChannels.generateImage.provider(async (req): Promise<MakeVideoResult<GenerateImageData>> => {
    try {
      return ok(await runImage(req));
    } catch (error) {
      console.error('[MakeVideoBridge] generate-image failed:', error);
      const message = error instanceof Error ? error.message : String(error);
      const code = /no-image-model/i.test(message) ? 'no-image-model' : 'error';
      return fail<GenerateImageData>(error, code);
    }
  });

  makeVideoChannels.generateVoice.provider(async (req): Promise<MakeVideoResult<GenerateVoiceData>> => {
    try {
      const audioDir = path.join(app.getPath('userData'), 'make-video', 'audio');
      const audioPath = await withRetry(
        () => generateVoice(req.text, req.voiceConfig, req.projectId, req.sceneId, { audioDir }),
        { isRetriable: isTransientError }
      );
      // Persist audioPath on the scene.
      await getStore().updateScene(req.projectId, req.sceneId, { audioPath, audioError: null });
      return ok({ audioPath });
    } catch (error) {
      console.error('[MakeVideoBridge] generate-voice failed:', error);
      await getStore()
        .updateScene(req.projectId, req.sceneId, {
          audioError: error instanceof Error ? error.message : String(error),
        })
        .catch((): undefined => undefined);
      return fail<GenerateVoiceData>(error, 'error');
    }
  });

  makeVideoChannels.generateVideoClip.provider(async (req): Promise<MakeVideoResult<GenerateVideoClipData>> => {
    try {
      const clipsDir = path.join(app.getPath('userData'), 'make-video', 'clips');
      const videoClipPath = await generateVideoClip(
        req.frameStartPath,
        req.frameEndPath,
        req.prompt,
        req.videoClipConfig,
        req.projectId,
        req.sceneId,
        { clipsDir }
      );
      await getStore().updateScene(req.projectId, req.sceneId, { videoClipPath, videoClipError: null });
      return ok({ videoClipPath });
    } catch (error) {
      console.error('[MakeVideoBridge] generate-video-clip failed:', error);
      await getStore()
        .updateScene(req.projectId, req.sceneId, {
          videoClipError: error instanceof Error ? error.message : String(error),
        })
        .catch((): undefined => undefined);
      return fail<GenerateVideoClipData>(error, 'error');
    }
  });

  makeVideoChannels.exportFinal.provider(async (req): Promise<MakeVideoResult<ExportFinalData>> => {
    try {
      const defaultOutputPath =
        req.outputPath || path.join(app.getPath('userData'), 'make-video', 'exports', `final-${req.projectId}.mp4`);
      const result = await exportFinalVideo(req.segments, defaultOutputPath);
      return ok(result);
    } catch (error) {
      console.error('[MakeVideoBridge] export-final failed:', error);
      return fail<ExportFinalData>(error, 'error');
    }
  });
}
