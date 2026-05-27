/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TProviderWithModel } from '@/common/config/storage';

export type { TProviderWithModel };

export type NormalizedImage = {
  type: 'image_url';
  image_url: { url: string };
};

export type ImageGenParams = {
  prompt: string;
  image_uris?: string[] | string;
};

export type ImageGenResult = {
  success: boolean;
  text: string;
  imagePath?: string;
  relativeImagePath?: string;
  error?: string;
};

/** API shape for a provider's image model. */
export type ApiShape = 'chat' | 'images';

export type ImageAdapterParams = {
  prompt: string;
  imageUris: string[];
  provider: TProviderWithModel;
  workspaceDir: string;
  proxy?: string;
  signal?: AbortSignal;
};

export type ImageProviderAdapter = {
  capabilities: {
    generate: boolean;
    edit: boolean;
    multiImageEdit: boolean;
    async: boolean;
  };
  generate(params: ImageAdapterParams): Promise<NormalizedImage[]>;
  edit?(params: ImageAdapterParams): Promise<NormalizedImage[]>;
};
