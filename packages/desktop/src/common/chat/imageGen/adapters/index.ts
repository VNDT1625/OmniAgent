/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ImageProviderAdapter } from '../types';
import { getApiShape } from '@/common/utils/imageModelAllowlist';
import { OpenAIChatAdapter } from './openai-chat';
import { OpenAIImagesAdapter } from './openai-images';

export type { ImageProviderAdapter };

type ProviderShape = { platform?: string; base_url?: string; name?: string };

export function getAdapter(provider: ProviderShape): ImageProviderAdapter {
  const shape = getApiShape(provider);
  return shape === 'images' ? OpenAIImagesAdapter : OpenAIChatAdapter;
}
