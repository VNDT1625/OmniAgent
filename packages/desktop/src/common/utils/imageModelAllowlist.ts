/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Allowlist for built-in image generation tool.
 *
 * Two API shapes are supported:
 *
 *   "chat"   — OpenAI chat completions multimodal output (form B).
 *              The model returns images via `message.images` or inline markdown.
 *              Supported: Gemini, OpenRouter chat-style, AntigravityTools.
 *
 *   "images" — OpenAI /v1/images/generations + /v1/images/edits (form A).
 *              Returns { data: [{ b64_json }] }.
 *              Supported: OpenAI (gpt-image-*, dall-e-*), Stability AI,
 *              Alibaba DashScope (通义万相), Together AI (FLUX).
 *
 * When a new adapter lands, add its rule here and update the Tooltip text.
 */

import type { ApiShape } from '@/common/chat/imageGen/types';

type ProviderShape = {
  platform?: string;
  base_url?: string;
  name?: string;
};

const IMAGE_NAME_PATTERN = /(image|banana|imagine|flux|dall-e|stable|sd[0-9]|wanx)/i;

type Rule = {
  id: string;
  apiShape: ApiShape;
  match: (provider: ProviderShape) => boolean;
  /** Optional additional model-name filter. If omitted, IMAGE_NAME_PATTERN is used. */
  modelPattern?: RegExp;
};

const RULES: Rule[] = [
  // ── Form B (chat completions) ──────────────────────────────────────────────
  {
    id: 'gemini',
    apiShape: 'chat',
    match: (p) => p.platform === 'gemini' || p.platform === 'gemini-vertex-ai',
  },
  {
    id: 'openrouter',
    apiShape: 'chat',
    match: (p) => !!p.base_url?.includes('openrouter.ai'),
  },
  {
    id: 'antigravity',
    apiShape: 'chat',
    match: (p) => !!p.name?.toLowerCase().includes('antigravity'),
  },

  // ── Form A (OpenAI /v1/images/* endpoints) ─────────────────────────────────
  {
    id: 'openai-official',
    apiShape: 'images',
    match: (p) => !!p.base_url?.includes('api.openai.com'),
    modelPattern: /(gpt-image|dall-e)/i,
  },
  {
    id: 'stability-ai',
    apiShape: 'images',
    match: (p) => !!p.base_url?.includes('stability.ai'),
    modelPattern: /(stable|sd[0-9]|ultra|core)/i,
  },
  {
    id: 'dashscope',
    apiShape: 'images',
    match: (p) => !!p.base_url?.includes('dashscope.aliyuncs.com'),
    modelPattern: /(wanx|image)/i,
  },
  {
    id: 'together',
    apiShape: 'images',
    match: (p) => !!p.base_url?.includes('together') || !!p.base_url?.includes('togetherai'),
    modelPattern: /(flux)/i,
  },
];

/**
 * Returns true if the given provider+model combination is supported by the
 * built-in image generation tool (either form A or form B).
 */
export const isImageGenSupported = (provider: ProviderShape, modelName: string): boolean => {
  for (const rule of RULES) {
    if (!rule.match(provider)) continue;
    const pattern = rule.modelPattern ?? IMAGE_NAME_PATTERN;
    if (pattern.test(modelName)) return true;
  }
  return false;
};

/**
 * Returns the API shape for a given provider: 'images' for form-A providers
 * (OpenAI /v1/images/*), 'chat' for form-B chat completions.
 * Falls back to 'chat' for unknown providers.
 */
export const getApiShape = (provider: ProviderShape): ApiShape => {
  for (const rule of RULES) {
    if (rule.match(provider)) return rule.apiShape;
  }
  return 'chat';
};
