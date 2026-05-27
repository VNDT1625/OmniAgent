/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Form-B adapter: OpenAI chat completions with multimodal image output.
 * The model returns generated images via `choice.message.images` or as
 * inline base64 data-URIs embedded in the markdown content.
 *
 * Supported providers: Google Gemini, OpenRouter chat-style image models,
 * AntigravityTools.
 */

import * as path from 'path';
import type OpenAI from 'openai';
import { ClientFactory } from '@/common/api/ClientFactory';
import type { NormalizedImage, ImageProviderAdapter, ImageAdapterParams } from '../types';
import { processImageUri, fileToBase64, getImageMimeType } from '../utils';

const API_TIMEOUT_MS = 120_000;

export const OpenAIChatAdapter: ImageProviderAdapter = {
  capabilities: {
    generate: true,
    edit: true,
    multiImageEdit: true,
    async: false,
  },

  async generate(params: ImageAdapterParams): Promise<NormalizedImage[]> {
    const { prompt, imageUris, provider, workspaceDir, proxy, signal } = params;

    const enhancedPrompt = imageUris.length > 0 ? `Analyze/Edit image: ${prompt}` : `Generate image: ${prompt}`;
    const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: 'text', text: enhancedPrompt }];

    if (imageUris.length > 0) {
      const imageResults = await Promise.allSettled(imageUris.map((uri) => processImageUri(uri, workspaceDir)));
      const successful: Array<{ type: 'image_url'; image_url: { url: string; detail: 'auto' | 'low' | 'high' } }> = [];
      const errors: string[] = [];

      imageResults.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value) {
          successful.push(result.value);
        } else {
          const error = result.status === 'rejected' ? result.reason : 'Unknown error';
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push(`Image ${index + 1} (${imageUris[index]}): ${errorMessage}`);
        }
      });

      if (successful.length === 0) {
        throw new Error(`Failed to process any images. Errors:\n${errors.join('\n')}`);
      }

      successful.forEach((img) => contentParts.push(img));
    }

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'user', content: contentParts }];
    const rotatingClient = await ClientFactory.createRotatingClient(provider, {
      proxy,
      rotatingOptions: { maxRetries: 3, retryDelay: 1000 },
    });

    const completion = await (rotatingClient as any).createChatCompletion(
      { model: provider.use_model, messages: messages as any },
      { signal, timeout: API_TIMEOUT_MS }
    );

    const choice = completion.choices?.[0];
    if (!choice) throw new Error('No response from image generation API');

    const responseText: string = choice.message?.content || '';
    let images: Array<{ type: 'image_url'; image_url: { url: string } }> = choice.message?.images || [];

    // Extract base64 data-URIs from markdown if not in images field
    if (images.length === 0 && responseText) {
      const dataUrlRegex = /!\[[^\]]*\]\((data:image\/[^;]+;base64,[^)]+)\)/g;
      const dataUrlMatches = [...responseText.matchAll(dataUrlRegex)];
      if (dataUrlMatches.length > 0) {
        images = dataUrlMatches.map((match) => ({ type: 'image_url' as const, image_url: { url: match[1] } }));
      } else {
        const file_pathRegex = /!\[[^\]]*\]\(([^)]+\.(?:jpg|jpeg|png|gif|webp|bmp|tiff|svg))\)/gi;
        const file_pathMatches = [...responseText.matchAll(file_pathRegex)];
        if (file_pathMatches.length > 0) {
          const processed: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
          for (const match of file_pathMatches) {
            const filePath = match[1];
            const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
            try {
              const base64Data = await fileToBase64(fullPath);
              const mimeType = getImageMimeType(fullPath);
              processed.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } });
            } catch (_e) {
              console.warn(`[ImageGen/chat] Could not load image file: ${filePath}`);
            }
          }
          if (processed.length > 0) images = processed;
        }
      }
    }

    if (images.length === 0) {
      throw new Error(
        `Image generation did not produce any images.\n\nModel response: ${responseText}\n\nTip: Make sure your image generation model supports this type of request. Current model: ${provider.use_model}`
      );
    }

    // Return raw data-URIs; caller (executeImageGeneration) does the single disk save
    const normalized: NormalizedImage[] = [];
    for (const img of images) {
      if (img.type === 'image_url' && img.image_url?.url) {
        normalized.push({ type: 'image_url', image_url: { url: img.image_url.url } });
      }
    }
    return normalized;
  },
};
