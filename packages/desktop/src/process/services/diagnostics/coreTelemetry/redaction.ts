/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CoreTelemetryEvent } from './types';

const SAFE_ATTRIBUTE_KEYS = new Set([
  'protocol',
  'surface',
  'errorCode',
  'retryReason',
  'reason',
  'transport',
  'status',
]);
const SECRET_PATTERN =
  /(bearer\s+|sk-[a-z0-9_-]{8,}|(?:api[_-]?key|token|secret|password|authorization|cookie|credential)\s*[:=]\s*)[^\s,;]+/giu;
const HOME_PATH_PATTERN = /[a-z]:\\users\\[^\\\s]+|\/home\/[^/\s]+/giu;

export const redactTelemetryText = (value: string): string =>
  value.replace(SECRET_PATTERN, '$1[REDACTED]').replace(HOME_PATH_PATTERN, '[USER_HOME]').slice(0, 512);

/** Telemetry is allowlist-based: prompt, response, file content and arbitrary provider data never enter the log. */
export const sanitizeTelemetryAttributes = (value?: Record<string, unknown>): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_ATTRIBUTE_KEYS.has(key)) continue;
    if (typeof item === 'string') sanitized[key] = redactTelemetryText(item);
    else if (typeof item === 'number' || typeof item === 'boolean' || item === null) sanitized[key] = item;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
};

/**
 * Produce the only telemetry shape allowed to cross the Main/Renderer boundary.
 * Defense in depth is intentional: persisted events are already sanitized, but
 * old or externally migrated telemetry files must not be trusted by IPC.
 */
export const toPublicCoreTelemetryEvent = (event: CoreTelemetryEvent): CoreTelemetryEvent => {
  const attributes = sanitizeTelemetryAttributes(event.attributes);
  return {
    eventId: redactTelemetryText(event.eventId),
    runId: redactTelemetryText(event.runId),
    sessionId: redactTelemetryText(event.sessionId),
    targetId: redactTelemetryText(event.targetId),
    kind: event.kind,
    timestamp: event.timestamp,
    elapsedMs: event.elapsedMs,
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    ...(event.tool === undefined ? {} : { tool: redactTelemetryText(event.tool) }),
    ...(event.outcome === undefined ? {} : { outcome: event.outcome }),
    ...(attributes ? { attributes } : {}),
  };
};
