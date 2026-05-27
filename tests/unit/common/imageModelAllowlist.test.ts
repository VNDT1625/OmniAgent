/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isImageGenSupported, getApiShape } from '@/common/utils/imageModelAllowlist';

// ── isImageGenSupported ────────────────────────────────────────────────────────

describe('isImageGenSupported — form B (chat completions)', () => {
  it('accepts native Gemini image models', () => {
    const p = { platform: 'gemini' };
    expect(isImageGenSupported(p, 'gemini-2.5-flash-image-preview')).toBe(true);
  });

  it('accepts Vertex AI Gemini image models', () => {
    const p = { platform: 'gemini-vertex-ai' };
    expect(isImageGenSupported(p, 'gemini-2.5-flash-image')).toBe(true);
  });

  it('accepts OpenRouter chat image models via base_url', () => {
    const p = { platform: 'custom', base_url: 'https://openrouter.ai/api/v1' };
    expect(isImageGenSupported(p, 'google/gemini-2.5-flash-image-preview')).toBe(true);
    expect(isImageGenSupported(p, 'nano-banana')).toBe(true);
  });

  it('accepts AntigravityTools by name', () => {
    const p = { platform: 'custom', name: 'AntigravityTools' };
    expect(isImageGenSupported(p, 'gemini-3-pro-image-1x1')).toBe(true);
  });

  it('rejects text-only model on Gemini', () => {
    const p = { platform: 'gemini' };
    expect(isImageGenSupported(p, 'gemini-2.5-pro')).toBe(false);
  });
});

describe('isImageGenSupported — form A (OpenAI /v1/images/*)', () => {
  it('accepts gpt-image-* on api.openai.com', () => {
    const p = { platform: 'custom', base_url: 'https://api.openai.com/v1' };
    expect(isImageGenSupported(p, 'gpt-image-2')).toBe(true);
    expect(isImageGenSupported(p, 'gpt-image-1')).toBe(true);
    expect(isImageGenSupported(p, 'dall-e-3')).toBe(true);
  });

  it('rejects text model (gpt-4o) even on api.openai.com', () => {
    const p = { platform: 'custom', base_url: 'https://api.openai.com/v1' };
    expect(isImageGenSupported(p, 'gpt-4o')).toBe(false);
  });

  it('accepts Stability AI models', () => {
    const p = { platform: 'custom', base_url: 'https://api.stability.ai/v2beta' };
    expect(isImageGenSupported(p, 'stable-diffusion-3.5')).toBe(true);
    expect(isImageGenSupported(p, 'stable-image-ultra')).toBe(true);
  });

  it('accepts Dashscope 通义万相', () => {
    const p = { platform: 'custom', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' };
    expect(isImageGenSupported(p, 'wanx-v1')).toBe(true);
    expect(isImageGenSupported(p, 'wanx2.1-t2i-turbo')).toBe(true);
  });

  it('accepts Together AI FLUX models', () => {
    const p = { platform: 'custom', base_url: 'https://api.together.xyz/v1' };
    expect(isImageGenSupported(p, 'black-forest-labs/FLUX.1-schnell')).toBe(true);
    expect(isImageGenSupported(p, 'flux-dev')).toBe(true);
  });

  it('rejects unknown provider regardless of model name', () => {
    const p = { platform: 'custom', base_url: 'https://api.unknown.com/v1' };
    expect(isImageGenSupported(p, 'gpt-image-1')).toBe(false);
    expect(isImageGenSupported(p, 'dall-e-3')).toBe(false);
  });
});

// ── getApiShape ────────────────────────────────────────────────────────────────

describe('getApiShape', () => {
  it('returns "chat" for Gemini', () => {
    expect(getApiShape({ platform: 'gemini' })).toBe('chat');
  });

  it('returns "chat" for OpenRouter', () => {
    expect(getApiShape({ base_url: 'https://openrouter.ai/api/v1' })).toBe('chat');
  });

  it('returns "images" for OpenAI official endpoint', () => {
    expect(getApiShape({ base_url: 'https://api.openai.com/v1' })).toBe('images');
  });

  it('returns "images" for Stability AI', () => {
    expect(getApiShape({ base_url: 'https://api.stability.ai/v2beta' })).toBe('images');
  });

  it('returns "images" for Dashscope', () => {
    expect(getApiShape({ base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })).toBe('images');
  });

  it('returns "images" for Together AI', () => {
    expect(getApiShape({ base_url: 'https://api.together.xyz/v1' })).toBe('images');
  });

  it('falls back to "chat" for unknown providers', () => {
    expect(getApiShape({ platform: 'custom', base_url: 'https://api.unknown.com/v1' })).toBe('chat');
  });
});
