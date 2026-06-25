import { describe, expect, it } from 'vitest';
import type { IProvider } from '@/common/config/storage';
import {
  recommendConfiguredModels,
  toPricingModelId,
  type ModelBenchmark,
  type ModelPricing,
} from '@/common/pricing/modelPricingAdvisor';

const provider = (patch: Partial<IProvider>): IProvider =>
  ({
    id: patch.id ?? 'provider',
    platform: patch.platform ?? 'custom',
    name: patch.name ?? 'Provider',
    base_url: patch.base_url ?? 'https://api.openai.com/v1',
    api_key: patch.api_key ?? 'secret',
    models: patch.models ?? [],
    enabled: patch.enabled,
    model_enabled: patch.model_enabled,
    model_protocols: patch.model_protocols,
  }) as IProvider;

const pricing = (input: number, output: number): ModelPricing => ({
  id: 'id',
  name: 'Model',
  promptPerTokenUsd: input / 1_000_000,
  completionPerTokenUsd: output / 1_000_000,
});

describe('modelPricingAdvisor', () => {
  it('maps configured providers to llmprices model ids', () => {
    expect(toPricingModelId(provider({ name: 'OpenAI' }), 'gpt-4o')).toBe('openai/gpt-4o');
    expect(toPricingModelId(provider({ platform: 'anthropic', name: 'Anthropic' }), 'claude-opus-4.5')).toBe(
      'anthropic/claude-opus-4.5'
    );
    expect(toPricingModelId(provider({ name: 'OpenRouter' }), 'anthropic/claude-sonnet-4.5')).toBe(
      'anthropic/claude-sonnet-4.5'
    );
  });

  it('recommends among configured keyed providers without exposing api keys', async () => {
    const providers = [
      provider({ id: 'openai', name: 'OpenAI', api_key: 'sk-secret', models: ['gpt-4o', 'gpt-4o-mini'] }),
      provider({
        id: 'anthropic',
        platform: 'anthropic',
        name: 'Anthropic',
        api_key: 'sk-ant',
        models: ['claude-opus-4.5'],
      }),
      provider({ id: 'disabled', name: 'OpenAI', api_key: '', models: ['gpt-4.1'] }),
    ];
    const prices = new Map<string, ModelPricing>([
      ['openai/gpt-4o', pricing(2.5, 10)],
      ['openai/gpt-4o-mini', pricing(0.15, 0.6)],
      ['anthropic/claude-opus-4.5', pricing(15, 75)],
    ]);

    const result = await recommendConfiguredModels(providers, async (id) => prices.get(id) ?? null);

    expect(result.availableCount).toBe(3);
    expect(result.pricedCount).toBe(3);
    expect(result.cheapest?.model).toBe('gpt-4o-mini');
    expect(result.strongest?.model).toBe('claude-opus-4.5');
    expect(result.bestValue?.model).toBe('gpt-4o-mini');
    expect(JSON.stringify(result)).not.toContain('sk-secret');
    expect(result.candidates.map((candidate) => candidate.pricingTier)).toEqual(
      expect.arrayContaining(['cheap', 'average', 'expensive'])
    );
  });

  it('uses Artificial Analysis benchmark scores when available', async () => {
    const providers = [
      provider({ id: 'openai', name: 'OpenAI', api_key: 'sk-secret', models: ['gpt-4o', 'gpt-4o-mini'] }),
    ];
    const prices = new Map<string, ModelPricing>([
      ['openai/gpt-4o', pricing(2.5, 10)],
      ['openai/gpt-4o-mini', pricing(0.15, 0.6)],
    ]);
    const benchmarks = new Map<string, ModelBenchmark>([
      [
        'openai/gpt-4o',
        {
          id: 'gpt-4o',
          name: 'GPT-4o',
          qualityScore: 91,
          outputTokensPerSecond: 80,
          timeToFirstTokenSeconds: 0.4,
          source: 'artificial-analysis',
        },
      ],
    ]);

    const result = await recommendConfiguredModels(
      providers,
      async (id) => prices.get(id) ?? null,
      async (id) => benchmarks.get(id) ?? null
    );

    const gpt4o = result.candidates.find((candidate) => candidate.model === 'gpt-4o');
    expect(result.benchmarkedCount).toBe(1);
    expect(gpt4o?.performanceSource).toBe('artificial-analysis');
    expect(gpt4o?.benchmark?.qualityScore).toBe(91);
    expect(gpt4o?.performanceScore).toBeGreaterThan(91);
  });
});
