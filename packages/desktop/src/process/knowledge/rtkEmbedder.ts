/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Embedder resolution for Realtime Knowledge.
 *
 * Prefers the user's configured embedding model (resolved from `/api/providers`,
 * mirroring `ide/knowledgeGraphBridge.ts`); when none is configured it falls back
 * to a deterministic LOCAL hashing embedder so semantic lookup still works
 * offline without a model. The fallback is a bag-of-words term-frequency hash —
 * crude, but adequate for the small, curated set of volatile facts and zero-cost.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import { hasSpecificModelCapability } from '@/common/utils/modelCapabilities';
import type { Embedder } from './realtime/rtkVectorIndex';

/** Dimensionality of the local hashing fallback embedder. */
const HASHING_DIMENSIONS = 256;

/** Tokenise text into lowercase word tokens. */
const tokenize = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** FNV-1a 32-bit hash → bucket index. */
const bucket = (token: string, dimensions: number): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % dimensions;
};

/**
 * A deterministic, local, network-free embedder. Maps each text to a
 * term-frequency vector over hashed buckets. Used when no embedding model is
 * configured so lookup never hard-fails.
 */
export const createHashingEmbedder = (dimensions: number = HASHING_DIMENSIONS): Embedder => ({
  providerId: 'local-hashing',
  model: `hashing-v1-${dimensions}`,
  embed: (texts) =>
    Promise.resolve(
      texts.map((text) => {
        const vector = Array.from({ length: dimensions }, () => 0);
        for (const token of tokenize(text)) {
          vector[bucket(token, dimensions)] += 1;
        }
        return vector;
      })
    ),
});

const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

const isUsable = (p: IProvider): boolean =>
  p.enabled !== false && Boolean(p.api_key) && Boolean(p.base_url) && Array.isArray(p.models) && p.models.length > 0;

const loadProviders = (): Promise<IProvider[]> =>
  httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[]);

const firstApiKey = (apiKeys: string): string =>
  apiKeys
    .split(/[,\n]/)
    .map((k) => k.trim())
    .find((k) => k.length > 0) ?? '';

const resolveEmbeddingUrl = (provider: IProvider): string => {
  const base = provider.base_url.replace(/\/+$/, '');
  if (!provider.is_full_url) return `${base}/embeddings`;
  return `${base.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '')}/embeddings`;
};

const modelHasEmbeddingCapability = (provider: IProvider, model: string): boolean => {
  if (hasSpecificModelCapability(provider, model, 'embedding') === true) return true;
  return provider.capabilities?.some((c) => c.type === 'embedding' && c.isUserSelected !== false) ?? false;
};

const pickEmbeddingModel = (providers: IProvider[]): { provider: IProvider; model: string } | null => {
  for (const provider of providers.filter(isUsable)) {
    const model = provider.models.find(
      (candidate) => isModelEnabled(provider, candidate) && modelHasEmbeddingCapability(provider, candidate)
    );
    if (model) return { provider, model };
  }
  return null;
};

type EmbeddingResponse = { data?: Array<{ index?: number; embedding?: unknown }> };

const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));

const parseEmbeddingVectors = (json: EmbeddingResponse, expected: number): number[][] => {
  const vectors: number[][] = Array.from({ length: expected }, (): number[] => []);
  for (const item of json.data ?? []) {
    const index = item.index ?? vectors.findIndex((vector) => vector.length === 0);
    if (index < 0 || index >= vectors.length || !isNumberArray(item.embedding)) continue;
    vectors[index] = item.embedding;
  }
  if (vectors.some((vector) => vector.length === 0)) {
    throw new Error('Embedding provider returned incomplete vectors.');
  }
  return vectors;
};

/** Build an embedder from the user's configured embedding model, or `null`. */
export const createProviderEmbedder = async (): Promise<Embedder | null> => {
  const selected = pickEmbeddingModel(await loadProviders());
  if (!selected) return null;
  return {
    providerId: selected.provider.id,
    model: selected.model,
    embed: async (texts, signal) => {
      const response = await fetch(resolveEmbeddingUrl(selected.provider), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${firstApiKey(selected.provider.api_key)}`,
        },
        body: JSON.stringify({ model: selected.model, input: texts }),
        signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Embedding request failed (HTTP ${response.status}). ${detail.slice(0, 300)}`);
      }
      return parseEmbeddingVectors((await response.json()) as EmbeddingResponse, texts.length);
    },
  };
};

/** Resolve the best available embedder: provider model if configured, else local hashing. */
export const resolveRtkEmbedder = async (): Promise<Embedder> => {
  try {
    const provider = await createProviderEmbedder();
    if (provider) return provider;
  } catch {
    // fall through to the local fallback
  }
  return createHashingEmbedder();
};
