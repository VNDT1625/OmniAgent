/** Direct provider model discovery. No AionCore process or routes involved. */
import type { FetchModelsAnonymousRequest, FetchModelsResponse } from '@/common/types/provider/providerApi';
import {
  getRecommendedPlatform,
  guessProtocolFromKey,
  guessProtocolFromUrl,
  normalizeBaseUrl,
  removeApiPathSuffix,
  type ProtocolDetectionRequest,
  type ProtocolDetectionResponse,
  type ProtocolType,
} from '@/common/utils/protocolDetector';

export type ProviderFetch = typeof fetch;
const objectValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const modelIds = (payload: unknown): string[] => {
  const body = objectValue(payload);
  const entries = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      const item = objectValue(entry);
      const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : '';
      return id.replace(/^models\//u, '');
    })
    .filter(Boolean);
};
const protocolForPlatform = (platform: string, baseUrl: string, apiKey: string): ProtocolType => {
  const normalized = platform.toLowerCase();
  if (normalized.includes('anthropic') || normalized === 'claude') return 'anthropic';
  if (normalized.includes('gemini') || normalized.includes('vertex')) return 'gemini';
  return guessProtocolFromUrl(baseUrl) ?? guessProtocolFromKey(apiKey) ?? 'openai';
};
const unique = (values: string[]): string[] => [...new Set(values)];
const requestCandidates = (
  request: FetchModelsAnonymousRequest
): Array<{ url: string; headers: Record<string, string> }> => {
  const apiKey = request.api_key.split(/[,\n]/u)[0]?.trim() ?? '';
  const rawBase = normalizeBaseUrl(request.base_url ?? '');
  const base = removeApiPathSuffix(rawBase) ?? rawBase;
  const protocol = protocolForPlatform(request.platform, base, apiKey);
  if (!base) throw new Error('Base URL is required to fetch models.');
  if (protocol === 'gemini') {
    return unique([`${base}/v1beta/models`, `${base}/v1/models`]).map((url) => ({
      url: `${url}?key=${encodeURIComponent(apiKey)}`,
      headers: {},
    }));
  }
  if (protocol === 'anthropic') {
    return [
      {
        url: base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      },
    ];
  }
  const urls = base.endsWith('/v1') ? [`${base}/models`] : [`${base}/models`, `${base}/v1/models`];
  return unique(urls).map((url) => ({ url, headers: { Authorization: `Bearer ${apiKey}` } }));
};
export const fetchProviderModelList = async (
  request: FetchModelsAnonymousRequest,
  fetchImpl: ProviderFetch = fetch
): Promise<FetchModelsResponse> => {
  let lastError = 'No compatible model endpoint responded.';
  for (const candidate of requestCandidates(request)) {
    try {
      // Candidate endpoints are deliberate fallbacks; stop after the first valid response.
      // eslint-disable-next-line no-await-in-loop
      const response = await fetchImpl(candidate.url, {
        method: 'GET',
        headers: candidate.headers,
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        lastError = `Model endpoint returned HTTP ${response.status}.`;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const models = modelIds((await response.json()) as unknown);
      if (models.length > 0) return { models };
      lastError = 'The provider returned an empty model list.';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError);
};
export const detectProviderProtocol = async (
  request: ProtocolDetectionRequest,
  fetchImpl: ProviderFetch = fetch
): Promise<ProtocolDetectionResponse> => {
  const protocol =
    request.preferredProtocol ??
    guessProtocolFromUrl(request.base_url) ??
    guessProtocolFromKey(request.api_key) ??
    'openai';
  try {
    const result = await fetchProviderModelList(
      { platform: protocol, base_url: request.base_url, api_key: request.api_key },
      fetchImpl
    );
    return {
      success: true,
      protocol,
      confidence: 100,
      fixedBaseUrl: normalizeBaseUrl(request.base_url),
      models: result.models.map((model) => (typeof model === 'string' ? model : model.id)),
      suggestion: { type: 'none', message: `Detected ${protocol} protocol.` },
    };
  } catch (error) {
    return {
      success: false,
      protocol,
      confidence: protocol === 'unknown' ? 0 : 45,
      error: error instanceof Error ? error.message : String(error),
      suggestion: {
        type: protocol === 'unknown' ? 'check_key' : 'none',
        message: 'Could not verify the provider endpoint.',
        suggestedPlatform: getRecommendedPlatform(protocol) ?? undefined,
      },
    };
  }
};
