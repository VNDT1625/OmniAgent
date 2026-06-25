/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PricingRecommendation } from '@/common/pricing/modelPricingAdvisor';
import { bridge } from '@office-ai/platform';
import { recommendConfiguredProviderModels } from './configuredModelPricing';

export type PricingResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const PRICING_CHANNELS = {
  recommendConfiguredModels: 'pricing.recommend-configured-models',
} as const;

export const pricingChannels = {
  recommendConfiguredModels: bridge.buildProvider<PricingResult<PricingRecommendation>, void>(
    PRICING_CHANNELS.recommendConfiguredModels
  ),
};

export function registerPricingBridge(): void {
  pricingChannels.recommendConfiguredModels.provider(async (): Promise<PricingResult<PricingRecommendation>> => {
    try {
      return { ok: true, data: await recommendConfiguredProviderModels() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `pricing.recommendConfiguredModels: ${message}` };
    }
  });
}
