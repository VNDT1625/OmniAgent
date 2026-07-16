/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConfigFilePlan, ConnectorPlan, ConnectorTarget, EnvVar, Router9Endpoint } from './types';
import { getConnectorTarget } from './targets';

/**
 * Pure plan engine for the 9Router distribution layer.
 *
 * Given a target tool and a running 9Router endpoint, compute exactly what
 * AionUi would set (env vars / config files / copy-paste fields) so the tool
 * routes through 9Router — "auto convert to the format the app needs". This is
 * the seam the user asked for: every tool wants a different shape, and 9Router
 * does the actual format translation downstream.
 *
 * No network, no filesystem, no Node APIs here — safe for both processes and
 * trivially unit-testable.
 */

/** Strip a trailing slash so we can compose URLs predictably. */
const trimTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

/** A bare origin (no `/v1`) — used by Anthropic-style and Codex-style tools. */
export const toOrigin = (baseUrl: string): string => {
  const trimmed = trimTrailingSlash(baseUrl);
  return trimmed.replace(/\/v1$/, '');
};

/** An OpenAI-style base ending in `/v1`. Idempotent. */
export const toV1 = (baseUrl: string): string => {
  const origin = toOrigin(baseUrl);
  return `${origin}/v1`;
};

/** Resolve the base URL for a target according to its declared style. */
export const resolveBaseUrl = (target: ConnectorTarget, baseUrl: string): string => {
  return target.baseUrlStyle === 'origin' ? toOrigin(baseUrl) : toV1(baseUrl);
};

/** Pretty JSON with stable 2-space indentation. */
const json = (value: unknown): string => JSON.stringify(value, null, 2);

/**
 * Build env vars for env-mechanism targets. Currently only Codex CLI, which
 * reads `OPENAI_BASE_URL` (origin, no `/v1`) + `OPENAI_API_KEY`.
 */
const buildEnv = (target: ConnectorTarget, endpoint: Router9Endpoint, baseUrl: string): EnvVar[] => {
  if (target.mechanism !== 'env') return [];
  const env: EnvVar[] = [
    { key: 'OPENAI_BASE_URL', value: baseUrl },
    { key: 'OPENAI_API_KEY', value: endpoint.apiKey },
  ];
  if (endpoint.model) {
    env.push({ key: 'OPENAI_MODEL', value: endpoint.model });
  }
  return env;
};

/**
 * Build config files for configFile-mechanism targets. Each tool has its own
 * schema; we deep-merge so we never clobber unrelated user settings.
 */
const buildFiles = (target: ConnectorTarget, endpoint: Router9Endpoint, baseUrl: string): ConfigFilePlan[] => {
  if (target.mechanism !== 'configFile') return [];

  if (target.id === 'claude-code') {
    // Claude Code reads ~/.claude/config.json with Anthropic-style keys.
    return [
      {
        path: '~/.claude/config.json',
        format: 'json',
        mergeStrategy: 'deepMerge',
        content: json({
          anthropic_api_base: baseUrl,
          anthropic_api_key: endpoint.apiKey,
        }),
      },
    ];
  }

  if (target.id === 'openclaw') {
    // OpenClaw declares providers in ~/.openclaw/openclaw.json. Use 127.0.0.1
    // (its docs warn against `localhost` due to IPv6 resolution).
    const modelId = endpoint.model ?? 'kr/claude-sonnet-4.5';
    return [
      {
        path: '~/.openclaw/openclaw.json',
        format: 'json',
        mergeStrategy: 'deepMerge',
        content: json({
          models: {
            providers: {
              '9router': {
                baseUrl,
                apiKey: endpoint.apiKey,
                api: 'openai-completions',
                models: [{ id: modelId, name: `9Router · ${modelId}` }],
              },
            },
          },
        }),
      },
    ];
  }

  return [];
};

/**
 * Copy-paste fields shown in the UI for every target, regardless of mechanism.
 * Lets the user configure by hand when auto-apply is not possible (manual
 * targets) or not desired.
 */
const buildFields = (target: ConnectorTarget, endpoint: Router9Endpoint, baseUrl: string): EnvVar[] => {
  const fields: EnvVar[] = [
    { key: 'baseUrl', value: baseUrl },
    { key: 'apiKey', value: endpoint.apiKey },
  ];
  if (endpoint.model) {
    fields.push({ key: 'model', value: endpoint.model });
  }
  return fields;
};

/**
 * Compute the connector plan for a target id + endpoint.
 *
 * @throws if the endpoint is incomplete (missing baseUrl/apiKey) or the target
 *   id is unknown — callers should validate before applying side effects.
 */
export const buildConnectorPlan = (targetId: string, endpoint: Router9Endpoint): ConnectorPlan => {
  const target = getConnectorTarget(targetId);
  if (!target) {
    throw new Error(`Unknown 9Router connector target: ${targetId}`);
  }
  if (!endpoint.baseUrl?.trim()) {
    throw new Error('9Router endpoint baseUrl is required');
  }
  if (!endpoint.apiKey?.trim()) {
    throw new Error('9Router endpoint apiKey is required');
  }

  const baseUrl = resolveBaseUrl(target, endpoint.baseUrl);
  return {
    target,
    baseUrl,
    env: buildEnv(target, endpoint, baseUrl),
    files: buildFiles(target, endpoint, baseUrl),
    fields: buildFields(target, endpoint, baseUrl),
  };
};
