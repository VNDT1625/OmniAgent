/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactRemoteError } from './protocol';
import type {
  RemoteCredential,
  RemoteFetch,
  RemoteHandshake,
  RemoteModelRecord,
  RemoteStreamDescriptor,
} from './types';

type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

const responseMessage = async (response: Response): Promise<string> => {
  const text = await response.text();
  if (!text) return `Remote gateway returned HTTP ${response.status}.`;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.error === 'string') return record.error;
      if (typeof record.message === 'string') return record.message;
    }
  } catch {
    // Keep the bounded plain-text response.
  }
  return text;
};

export class RemoteGatewayClient {
  public constructor(
    private readonly base: URL,
    private readonly credential: RemoteCredential,
    private readonly fetchImpl: RemoteFetch,
    private readonly timeoutMs: number
  ) {}

  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(new URL(path, this.base).toString(), {
        method: options.method ?? 'GET',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.credential.value}`,
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
      if (!response.ok) {
        const message = await responseMessage(response);
        throw new Error(message);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sanitized = redactRemoteError(message, this.credential.value);
      // Do not preserve the original cause: a hostile gateway may have echoed the bearer credential.
      // oxlint-disable-next-line preserve-caught-error
      throw new Error(sanitized);
    }
  }

  public handshake(signal?: AbortSignal): Promise<RemoteHandshake> {
    return this.request('/v1/handshake', { signal });
  }

  public async listModels(signal?: AbortSignal): Promise<RemoteModelRecord[]> {
    const response = await this.request<{ models?: unknown }>('/v1/models', { signal });
    if (!Array.isArray(response.models)) throw new Error('Remote model catalog is invalid.');
    return response.models.filter((item): item is RemoteModelRecord => {
      if (!item || typeof item !== 'object') return false;
      const model = item as Partial<RemoteModelRecord>;
      return (
        typeof model.id === 'string' &&
        (model.label === undefined || typeof model.label === 'string') &&
        (model.providerId === undefined || typeof model.providerId === 'string') &&
        (model.isDefault === undefined || typeof model.isDefault === 'boolean')
      );
    });
  }

  public startRun(
    input: {
      sessionId: string;
      prompt: string;
      workspace: string;
      modelKey?: string;
      permissionMode: string;
      protocolVersion: number;
    },
    signal: AbortSignal
  ): Promise<RemoteStreamDescriptor> {
    return this.request('/v1/runs', { method: 'POST', body: input, signal });
  }

  public resumeRun(runId: string, after: number, signal: AbortSignal): Promise<RemoteStreamDescriptor> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST',
      body: { after },
      signal,
    });
  }

  public answerPermission(runId: string, permissionId: string, approved: boolean, signal: AbortSignal): Promise<void> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(permissionId)}`, {
      method: 'POST',
      body: { approved },
      signal,
    });
  }

  public cancelRun(runId: string): Promise<void> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
  }
}
