/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import {
  recommendConfiguredModels,
  type ModelBenchmark,
  type ModelPricing,
  type PricingRecommendation,
} from '@/common/pricing/modelPricingAdvisor';

type LlmPricesResponse = {
  id: string;
  name: string;
  pricing: {
    prompt: string;
    completion: string;
    input_cache_read?: string;
  };
};

const PRICING_ENDPOINT = 'https://llmprices.ai/api/pricing';
const ARTIFICIAL_ANALYSIS_ENDPOINTS = [
  'https://artificialanalysis.ai/api/v2/llms/models',
  'https://artificialanalysis.ai/api/v2/data/llms/models',
  'https://artificialanalysis.ai/api/v2/llms/models/free',
] as const;

type ArtificialAnalysisEnvelope = {
  data?: unknown[];
  tier?: string;
};

let artificialAnalysisCache: { fetchedAt: number; models: unknown[] } | null = null;

const parsePrice = (value: string | undefined): number | undefined => {
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const fetchLlmPricesModelPricing = async (pricingModelId: string): Promise<ModelPricing | null> => {
  const url = new URL(PRICING_ENDPOINT);
  url.searchParams.set('model', pricingModelId);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return null;
  const json = (await response.json()) as LlmPricesResponse;
  const prompt = parsePrice(json.pricing?.prompt);
  const completion = parsePrice(json.pricing?.completion);
  if (prompt === undefined || completion === undefined) return null;
  return {
    id: json.id,
    name: json.name,
    promptPerTokenUsd: prompt,
    completionPerTokenUsd: completion,
    inputCacheReadPerTokenUsd: parsePrice(json.pricing.input_cache_read),
  };
};

const artificialAnalysisApiKey = (): string =>
  process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim() || process.env.AA_API_KEY?.trim() || '';

const normalizeModelKey = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

const readString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
};

const readNumber = (record: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
};

const nestedRecords = (record: Record<string, unknown>, keys: string[]): Record<string, unknown>[] =>
  keys.flatMap((key) => {
    const value = record[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return [value as Record<string, unknown>];
    if (Array.isArray(value))
      return value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
    return [];
  });

const fetchArtificialAnalysisModels = async (): Promise<unknown[]> => {
  const key = artificialAnalysisApiKey();
  if (!key) return [];
  const now = Date.now();
  if (artificialAnalysisCache && now - artificialAnalysisCache.fetchedAt < 60 * 60 * 1000) {
    return artificialAnalysisCache.models;
  }
  for (const endpoint of ARTIFICIAL_ANALYSIS_ENDPOINTS) {
    const response = await fetch(endpoint, {
      headers: { 'x-api-key': key },
      signal: AbortSignal.timeout(10_000),
    }).catch((): null => null);
    if (!response?.ok) continue;
    const json = (await response.json()) as ArtificialAnalysisEnvelope;
    const models = Array.isArray(json.data) ? json.data : [];
    if (models.length > 0) {
      artificialAnalysisCache = { fetchedAt: now, models };
      return models;
    }
  }
  return [];
};

const extractBenchmark = (record: Record<string, unknown>): ModelBenchmark | null => {
  const id = readString(record, ['id', 'slug', 'model', 'model_id']) ?? '';
  const name = readString(record, ['name', 'display_name', 'model']) ?? id;
  if (!id && !name) return null;
  const related = [
    record,
    ...nestedRecords(record, ['evaluations', 'performance', 'benchmarks', 'scores', 'metrics', 'providers']),
  ];
  const qualityScore = related
    .map((item) =>
      readNumber(item, [
        'intelligence_index',
        'artificial_analysis_intelligence_index',
        'aa_intelligence_index',
        'quality_score',
        'score',
      ])
    )
    .find((value): value is number => typeof value === 'number');
  const codingScore = related
    .map((item) =>
      readNumber(item, [
        'coding_index',
        'artificial_analysis_coding_index',
        'coding_score',
        'live_codebench',
        'swe_bench',
        'agentic_coding_score',
      ])
    )
    .find((value): value is number => typeof value === 'number');
  const outputTokensPerSecond = related
    .map((item) =>
      readNumber(item, [
        'median_output_tokens_per_second',
        'output_tokens_per_second',
        'tokens_per_second',
        'median_tokens_per_second',
      ])
    )
    .find((value): value is number => typeof value === 'number');
  const timeToFirstTokenSeconds = related
    .map((item) =>
      readNumber(item, ['median_time_to_first_token_seconds', 'time_to_first_token_seconds', 'ttft_seconds'])
    )
    .find((value): value is number => typeof value === 'number');
  if (
    qualityScore === undefined &&
    codingScore === undefined &&
    outputTokensPerSecond === undefined &&
    timeToFirstTokenSeconds === undefined
  ) {
    return null;
  }
  return {
    id,
    name,
    qualityScore,
    codingScore,
    outputTokensPerSecond,
    timeToFirstTokenSeconds,
    source: 'artificial-analysis',
  };
};

export const fetchArtificialAnalysisBenchmark = async (
  pricingModelId: string,
  model: string
): Promise<ModelBenchmark | null> => {
  const models = await fetchArtificialAnalysisModels();
  const modelKey = normalizeModelKey(model);
  const pricingKey = normalizeModelKey(pricingModelId.split('/').pop() ?? pricingModelId);
  for (const item of models) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const keys = [
      readString(record, ['slug', 'name', 'model', 'model_id']),
      ...nestedRecords(record, ['providers']).map((provider) =>
        readString(provider, ['model', 'model_id', 'slug', 'name'])
      ),
    ]
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeModelKey);
    if (
      keys.some((key) => key === modelKey || key === pricingKey || key.includes(modelKey) || modelKey.includes(key))
    ) {
      return extractBenchmark(record);
    }
  }
  return null;
};

export const recommendConfiguredProviderModels = async (): Promise<PricingRecommendation> => {
  const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch((): IProvider[] => [])) || [];
  return recommendConfiguredModels(providers, fetchLlmPricesModelPricing, fetchArtificialAnalysisBenchmark);
};
