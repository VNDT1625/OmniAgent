/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Form-A adapter: OpenAI /v1/images/generations and /v1/images/edits endpoints.
 *
 * Supported providers: OpenAI (gpt-image-2, gpt-image-1, dall-e-3),
 * Stability AI (SD3.5), Alibaba DashScope OpenAI-compat (通义万相),
 * Together AI (FLUX schnell/dev).
 *
 * For dall-e-2/dall-e-3, requests response_format: 'b64_json' to avoid 1-hour expiry
 * URLs. gpt-image-1/2 always return b64 natively and reject the parameter.
 * Size is fixed at '1024x1024' for now; extend with a size/quality param later.
 */

import type OpenAI from 'openai';
import { OpenAIRotatingClient } from '@/common/api/OpenAIRotatingClient';
import type { OpenAIClientConfig } from '@/common/api/OpenAIRotatingClient';
import { isNewApiPlatform } from '@/common/utils/platformConstants';
import { normalizeNewApiBaseUrl } from '@/common/api/ClientFactory';
import { AuthType } from '@office-ai/aioncli-core';
import type { NormalizedImage, ImageProviderAdapter, ImageAdapterParams } from '../types';
import { isHttpUrl, resolveLocalImageBuffer } from '../utils';

const API_TIMEOUT_MS = 120_000;
const DEFAULT_SIZE = '1024x1024' as const;

// gpt-image-1/2 always return b64 — sending response_format causes 500.
// Only dall-e-2/dall-e-3 accept this parameter.
const supportsDallEResponseFormat = (model: string) => /dall-e/i.test(model);

function buildClient(provider: { base_url: string; api_key: string; platform: string }): OpenAIRotatingClient {
  const isNewApi = isNewApiPlatform(provider.platform);
  const base_url = isNewApi ? normalizeNewApiBaseUrl(provider.base_url, AuthType.USE_OPENAI) : provider.base_url;

  const clientConfig: OpenAIClientConfig = {
    baseURL: base_url,
    defaultHeaders: { 'HTTP-Referer': 'https://aionui.com', 'X-Title': 'AionUi' },
  };

  return new OpenAIRotatingClient(provider.api_key, clientConfig, { maxRetries: 3, retryDelay: 1000 });
}

async function fetchRemoteImageBuffer(url: string): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const { default: https } = await import('https');
  const { default: http } = await import('http');
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https://') ? https : http;
    mod
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const mimeType = (res.headers['content-type'] as string) || 'image/png';
          const ext = mimeType.split('/')[1]?.split(';')[0] || 'png';
          resolve({ buffer, mimeType, filename: `remote-image.${ext}` });
        });
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function resolveImageFile(
  uri: string,
  workspaceDir: string
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  if (isHttpUrl(uri)) {
    return fetchRemoteImageBuffer(uri);
  }
  return resolveLocalImageBuffer(uri, workspaceDir);
}

async function normalizeResponseData(
  data: Array<{ b64_json?: string | null; url?: string | null }>
): Promise<NormalizedImage[]> {
  const normalized: NormalizedImage[] = [];

  for (const item of data) {
    if (item.b64_json) {
      const dataUrl = item.b64_json.startsWith('data:') ? item.b64_json : `data:image/png;base64,${item.b64_json}`;
      normalized.push({ type: 'image_url', image_url: { url: dataUrl } });
    } else if (item.url) {
      try {
        const { buffer, mimeType } = await fetchRemoteImageBuffer(item.url);
        normalized.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` } });
      } catch (_e) {
        normalized.push({ type: 'image_url', image_url: { url: item.url } });
      }
    }
  }

  return normalized;
}

export const OpenAIImagesAdapter: ImageProviderAdapter = {
  capabilities: {
    generate: true,
    edit: true,
    multiImageEdit: false, // /v1/images/edits accepts one source image + optional mask
    async: false,
  },

  async generate(params: ImageAdapterParams): Promise<NormalizedImage[]> {
    const { prompt, provider, workspaceDir, signal } = params;
    const client = buildClient(provider);

    const generateParams: OpenAI.Images.ImageGenerateParams = {
      model: provider.use_model,
      prompt,
      size: DEFAULT_SIZE,
      n: 1,
      ...(supportsDallEResponseFormat(provider.use_model) && { response_format: 'b64_json' }),
    };

    const response = await client.createImage(
      generateParams as OpenAI.Images.ImageGenerateParams,
      { signal, timeout: API_TIMEOUT_MS } as OpenAI.RequestOptions
    );

    if (!response.data?.length) throw new Error('No images returned from /v1/images/generations');
    return normalizeResponseData(response.data);
  },

  async edit(params: ImageAdapterParams): Promise<NormalizedImage[]> {
    const { prompt, imageUris, provider, workspaceDir, signal } = params;
    const client = buildClient(provider);

    const firstUri = imageUris[0];
    if (!firstUri) throw new Error('edit() requires at least one image_uri');

    const resolved = await resolveImageFile(firstUri, workspaceDir);

    const { toFile } = await import('openai');
    const imageFile = await toFile(resolved.buffer, resolved.filename, { type: resolved.mimeType });

    const editParams: OpenAI.Images.ImageEditParams = {
      model: provider.use_model,
      image: imageFile as any,
      prompt,
      size: DEFAULT_SIZE,
      n: 1,
      ...(supportsDallEResponseFormat(provider.use_model) && { response_format: 'b64_json' }),
    };

    const response = await client.editImage(editParams, { signal, timeout: API_TIMEOUT_MS } as OpenAI.RequestOptions);

    if (!response.data?.length) throw new Error('No images returned from /v1/images/edits');
    return normalizeResponseData(response.data);
  },
};
