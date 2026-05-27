/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public entry point for the image generation subsystem.
 *
 * Dispatches to the correct adapter based on the provider's API shape:
 *   - "chat"   → OpenAI chat completions (form B, e.g. Gemini)
 *   - "images" → OpenAI /v1/images/* (form A, e.g. gpt-image-2, dall-e-3)
 */

import * as path from 'path';
import type { TProviderWithModel } from './types';
import type { ImageGenParams, ImageGenResult } from './types';
import { parseImageUris, saveGeneratedImage } from './utils';
import { getAdapter } from './adapters';

export type { ImageGenParams, ImageGenResult };

// Re-export utility functions that external callers use
export {
  safeJsonParse,
  isImageFile,
  isHttpUrl,
  fileToBase64,
  getImageMimeType,
  getFileExtensionFromDataUrl,
  saveGeneratedImage,
  processImageUri,
} from './utils';

export async function executeImageGeneration(
  params: ImageGenParams,
  provider: TProviderWithModel,
  workspaceDir: string,
  proxy?: string,
  signal?: AbortSignal
): Promise<ImageGenResult> {
  if (signal?.aborted) {
    return { success: false, text: 'Image generation was cancelled.', error: 'cancelled' };
  }

  try {
    const imageUris = parseImageUris(params.image_uris);
    const adapter = getAdapter(provider);

    const useEdit = imageUris.length > 0 && adapter.capabilities.edit && typeof adapter.edit === 'function';

    const normalizedImages = useEdit
      ? await adapter.edit!({ prompt: params.prompt, imageUris, provider, workspaceDir, proxy, signal })
      : await adapter.generate({ prompt: params.prompt, imageUris, provider, workspaceDir, proxy, signal });

    if (normalizedImages.length === 0) {
      return {
        success: true,
        text: `Image generation did not produce any images.\n\nTip: Make sure your image generation model supports this type of request. Current model: ${provider.use_model}`,
      };
    }

    const firstImage = normalizedImages[0];
    const savedPath = await saveGeneratedImage(firstImage.image_url.url, workspaceDir);
    const relativeImagePath = path.relative(workspaceDir, savedPath);

    const cleanText = `Image generated successfully.\n\nGenerated image saved to: ${savedPath}`;

    return {
      success: true,
      text: cleanText,
      imagePath: savedPath,
      relativeImagePath,
    };
  } catch (error) {
    if (signal?.aborted) {
      return { success: false, text: 'Image generation was cancelled.', error: 'cancelled' };
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[ImageGen] API call failed:`, error);
    return { success: false, text: `Error generating image: ${errorMessage}`, error: errorMessage };
  }
}
