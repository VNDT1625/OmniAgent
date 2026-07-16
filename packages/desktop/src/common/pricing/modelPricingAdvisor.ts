/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProvider } from '@/common/config/storage';

export type PricingTier = 'cheap' | 'average' | 'expensive' | 'unknown';

export type ModelPricing = {
  id: string;
  name: string;
  promptPerTokenUsd: number;
  completionPerTokenUsd: number;
  inputCacheReadPerTokenUsd?: number;
};

export type ModelBenchmark = {
  id: string;
  name: string;
  qualityScore?: number;
  codingScore?: number;
  outputTokensPerSecond?: number;
  timeToFirstTokenSeconds?: number;
  source: 'artificial-analysis' | 'heuristic';
};

export type PricingCandidate = {
  providerId: string;
  providerName: string;
  platform: string;
  model: string;
  pricingModelId: string;
  hasApiKey: boolean;
  promptPerMillionUsd?: number;
  completionPerMillionUsd?: number;
  blendedPerMillionUsd?: number;
  pricingTier: PricingTier;
  performanceScore: number;
  performanceSource: 'artificial-analysis' | 'heuristic';
  benchmark?: ModelBenchmark;
  valueScore?: number;
  recommendation: 'best-value' | 'fast-cheap' | 'strong' | 'fallback' | 'unknown';
};

export type PricingRecommendation = {
  candidates: PricingCandidate[];
  cheapest?: PricingCandidate;
  strongest?: PricingCandidate;
  bestValue?: PricingCandidate;
  availableCount: number;
  pricedCount: number;
  benchmarkedCount: number;
};

export type PricingLookup = (pricingModelId: string) => Promise<ModelPricing | null>;
export type BenchmarkLookup = (pricingModelId: string, model: string) => Promise<ModelBenchmark | null>;

const hasKey = (provider: IProvider): boolean =>
  provider.api_key.trim().length > 0 || provider.platform === 'gemini-with-google-auth';

const enabledModels = (provider: IProvider): string[] =>
  (provider.models ?? []).filter((model) => provider.model_enabled?.[model] !== false);

const canonicalProvider = (provider: IProvider, model: string): string | null => {
  const platform = provider.platform.toLowerCase();
  const name = provider.name.toLowerCase();
  const baseUrl = provider.base_url.toLowerCase();
  const protocol = provider.model_protocols?.[model]?.toLowerCase();
  if (model.includes('/')) return null;
  if (protocol === 'anthropic' || platform === 'anthropic' || name.includes('anthropic')) return 'anthropic';
  if (protocol === 'gemini' || platform.includes('gemini') || name.includes('gemini')) return 'google';
  if (name.includes('deepseek') || baseUrl.includes('deepseek')) return 'deepseek';
  if (name.includes('openrouter') || baseUrl.includes('openrouter')) return 'openrouter';
  if (name.includes('qwen') || name.includes('dashscope') || baseUrl.includes('dashscope')) return 'qwen';
  if (protocol === 'openai' || name.includes('openai') || baseUrl.includes('api.openai.com')) return 'openai';
  return null;
};

export const toPricingModelId = (provider: IProvider, model: string): string | null => {
  if (model.includes('/')) return model;
  const canonical = canonicalProvider(provider, model);
  return canonical ? `${canonical}/${model}` : null;
};

const modelPerformanceScore = (model: string): number => {
  const lower = model.toLowerCase();
  if (/(opus|gpt-5|gemini-3|o3|r1|reasoner)/.test(lower)) return 95;
  if (/(sonnet|gpt-4\.1|gpt-4o|gemini-2\.5-pro|deepseek-v3|qwen3-max)/.test(lower)) return 82;
  if (/(haiku|mini|flash|lite|small|turbo|qwen3|gemini-2\.5-flash)/.test(lower)) return 62;
  return 70;
};

const scoreFromBenchmark = (model: string, benchmark: ModelBenchmark | null): number => {
  if (!benchmark) return modelPerformanceScore(model);
  const quality = benchmark.codingScore ?? benchmark.qualityScore;
  const qualityScore = typeof quality === 'number' ? quality : modelPerformanceScore(model);
  const speedBonus =
    typeof benchmark.outputTokensPerSecond === 'number'
      ? Math.min(10, Math.max(0, benchmark.outputTokensPerSecond / 25))
      : 0;
  const latencyPenalty =
    typeof benchmark.timeToFirstTokenSeconds === 'number'
      ? Math.min(8, Math.max(0, benchmark.timeToFirstTokenSeconds - 1))
      : 0;
  return Math.max(1, Math.min(100, qualityScore + speedBonus - latencyPenalty));
};

const blendedCost = (pricing: ModelPricing): number =>
  pricing.promptPerTokenUsd * 700_000 + pricing.completionPerTokenUsd * 300_000;

const tierFor = (cost: number, sortedCosts: number[]): PricingTier => {
  if (sortedCosts.length === 0) return 'unknown';
  const index = sortedCosts.findIndex((value) => value === cost);
  const percentile = index / Math.max(1, sortedCosts.length - 1);
  if (percentile <= 0.33) return 'cheap';
  if (percentile >= 0.67) return 'expensive';
  return 'average';
};

export const recommendConfiguredModels = async (
  providers: IProvider[],
  lookup: PricingLookup,
  benchmarkLookup?: BenchmarkLookup
): Promise<PricingRecommendation> => {
  const baseCandidates = providers
    .filter((provider) => provider.enabled !== false && hasKey(provider))
    .flatMap((provider): PricingCandidate[] =>
      enabledModels(provider).map((model): PricingCandidate => {
        const pricingModelId = toPricingModelId(provider, model) ?? '';
        return {
          providerId: provider.id,
          providerName: provider.name,
          platform: provider.platform,
          model,
          pricingModelId,
          hasApiKey: hasKey(provider),
          pricingTier: pricingModelId ? 'unknown' : 'unknown',
          performanceScore: modelPerformanceScore(model),
          performanceSource: 'heuristic',
          recommendation: pricingModelId ? 'unknown' : 'fallback',
        };
      })
    );

  const priced = await Promise.all(
    baseCandidates.map(async (candidate): Promise<PricingCandidate> => {
      if (!candidate.pricingModelId) return candidate;
      const [pricing, benchmark] = await Promise.all([
        lookup(candidate.pricingModelId).catch((): ModelPricing | null => null),
        benchmarkLookup?.(candidate.pricingModelId, candidate.model).catch((): ModelBenchmark | null => null) ??
          Promise.resolve(null),
      ]);
      const performanceScore = scoreFromBenchmark(candidate.model, benchmark);
      if (!pricing) {
        return {
          ...candidate,
          benchmark: benchmark ?? undefined,
          performanceScore,
          performanceSource: benchmark ? 'artificial-analysis' : 'heuristic',
        };
      }
      const blendedPerMillionUsd = blendedCost(pricing);
      const valueScore = performanceScore / Math.max(0.001, blendedPerMillionUsd);
      return {
        ...candidate,
        benchmark: benchmark ?? undefined,
        performanceScore,
        performanceSource: benchmark ? 'artificial-analysis' : 'heuristic',
        promptPerMillionUsd: pricing.promptPerTokenUsd * 1_000_000,
        completionPerMillionUsd: pricing.completionPerTokenUsd * 1_000_000,
        blendedPerMillionUsd,
        valueScore,
      };
    })
  );

  const costs = priced
    .map((candidate) => candidate.blendedPerMillionUsd)
    .filter((cost): cost is number => typeof cost === 'number')
    .toSorted((a, b) => a - b);

  const classified = priced
    .map((candidate): PricingCandidate => {
      if (typeof candidate.blendedPerMillionUsd !== 'number') return candidate;
      return {
        ...candidate,
        pricingTier: tierFor(candidate.blendedPerMillionUsd, costs),
      };
    })
    .toSorted((a, b) => (b.valueScore ?? -1) - (a.valueScore ?? -1));

  const pricedOnly = classified.filter((candidate) => typeof candidate.blendedPerMillionUsd === 'number');
  const cheapest = pricedOnly.toSorted((a, b) => (a.blendedPerMillionUsd ?? 0) - (b.blendedPerMillionUsd ?? 0))[0];
  const strongest = pricedOnly.toSorted((a, b) => b.performanceScore - a.performanceScore)[0];
  const bestValue = pricedOnly.toSorted((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0))[0];

  const withRecommendations = classified.map((candidate): PricingCandidate => {
    if (bestValue && candidate.providerId === bestValue.providerId && candidate.model === bestValue.model) {
      return { ...candidate, recommendation: 'best-value' };
    }
    if (cheapest && candidate.providerId === cheapest.providerId && candidate.model === cheapest.model) {
      return { ...candidate, recommendation: 'fast-cheap' };
    }
    if (strongest && candidate.providerId === strongest.providerId && candidate.model === strongest.model) {
      return { ...candidate, recommendation: 'strong' };
    }
    if (candidate.pricingTier === 'unknown') return { ...candidate, recommendation: 'unknown' };
    return { ...candidate, recommendation: 'fallback' };
  });

  return {
    candidates: withRecommendations,
    cheapest,
    strongest,
    bestValue,
    availableCount: baseCandidates.length,
    pricedCount: pricedOnly.length,
    benchmarkedCount: classified.filter((candidate) => candidate.performanceSource === 'artificial-analysis').length,
  };
};
