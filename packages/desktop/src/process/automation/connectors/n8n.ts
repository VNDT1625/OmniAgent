/** Execute n8n workflows through their webhook endpoints. */
import type { N8nNodeConfig } from '../automationTypes';

export type N8nActionDeps = { fetchImpl?: typeof fetch };

const substituteInput = (value: unknown, input: unknown): unknown => {
  if (typeof value === 'string') {
    const renderedInput = typeof input === 'string' ? input : JSON.stringify(input ?? null);
    return value.replaceAll('{{input}}', renderedInput);
  }
  if (Array.isArray(value)) return value.map((item) => substituteInput(item, input));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteInput(item, input)]));
  }
  return value;
};

export const createN8nAction = (deps: N8nActionDeps = {}) => {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return async (config: N8nNodeConfig, input: unknown, signal?: AbortSignal): Promise<unknown> => {
    const webhookUrl = config.webhookUrl?.trim();
    if (!webhookUrl) throw new Error('n8n webhookUrl is required.');

    const timeoutMs = Math.min(Math.max(config.timeoutMs ?? 30_000, 1_000), 120_000);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const method = config.method ?? 'POST';
    const payload = config.payload === undefined ? input : substituteInput(config.payload, input);
    const headers: Record<string, string> = { accept: 'application/json', ...config.headers };

    if (method === 'POST' && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetchImpl(webhookUrl, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(payload ?? null) : undefined,
      signal: combinedSignal,
    });

    const text = await response.text();
    if (!response.ok) throw new Error(`n8n webhook failed (${response.status}): ${text.slice(0, 500)}`);
    if (!text) return { ok: true, status: response.status };

    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  };
};
