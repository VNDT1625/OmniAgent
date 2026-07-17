/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  AcpCatalogDefinition,
  AcpCatalogIssue,
  AcpCompatibilityReport,
  AcpContractRequirements,
  AcpFeature,
  AcpHandshakeSnapshot,
} from './types';

const ALL_FEATURES: AcpFeature[] = [
  'text',
  'resource-link',
  'image',
  'audio',
  'embedded-context',
  'load-session',
  'session-list',
  'session-resume',
  'session-fork',
  'session-close',
  'mcp-stdio',
  'mcp-http',
  'mcp-sse',
  'model-selection',
];

const unique = <T>(values: T[]): T[] => [...new Set(values)];

export const supportedAcpFeatures = (handshake: AcpHandshakeSnapshot): AcpFeature[] => {
  const capabilities = handshake.agentCapabilities;
  const session = capabilities?.sessionCapabilities;
  const supported = new Set<AcpFeature>(['text', 'resource-link', 'mcp-stdio']);
  if (capabilities?.promptCapabilities?.image) supported.add('image');
  if (capabilities?.promptCapabilities?.audio) supported.add('audio');
  if (capabilities?.promptCapabilities?.embeddedContext) supported.add('embedded-context');
  if (capabilities?.loadSession) supported.add('load-session');
  if (session?.list) supported.add('session-list');
  if (session?.resume) supported.add('session-resume');
  if (session?.fork) supported.add('session-fork');
  if (session?.close) supported.add('session-close');
  if (capabilities?.mcpCapabilities?.http) supported.add('mcp-http');
  if (capabilities?.mcpCapabilities?.sse) supported.add('mcp-sse');
  if (handshake.models?.availableModels.length) supported.add('model-selection');
  return ALL_FEATURES.filter((feature) => supported.has(feature));
};

/** Negotiate only advertised ACP features. Missing optional features produce an explicit degraded contract. */
export const evaluateAcpCompatibility = (
  handshake: AcpHandshakeSnapshot,
  requirements: AcpContractRequirements = {},
  supportedProtocolVersions: number[] = [PROTOCOL_VERSION]
): AcpCompatibilityReport => {
  const required: AcpFeature[] = unique(requirements.required ?? ['text']);
  const preferred: AcpFeature[] = unique(requirements.preferred ?? []);
  const supported = supportedAcpFeatures(handshake);
  const supportedSet = new Set(supported);
  const missingRequired = required.filter((feature) => !supportedSet.has(feature));
  const degradedFeatures = preferred.filter((feature) => !supportedSet.has(feature));
  const reasons: string[] = [];
  const protocolCompatible = supportedProtocolVersions.includes(handshake.protocolVersion);
  if (!protocolCompatible) reasons.push(`Unsupported ACP protocol version ${String(handshake.protocolVersion)}.`);
  if (missingRequired.length > 0) reasons.push(`Missing required ACP features: ${missingRequired.join(', ')}.`);
  if (degradedFeatures.length > 0) reasons.push(`Optional ACP features disabled: ${degradedFeatures.join(', ')}.`);
  return {
    status:
      !protocolCompatible || missingRequired.length > 0
        ? 'incompatible'
        : degradedFeatures.length > 0
          ? 'degraded'
          : 'full',
    protocolVersion: handshake.protocolVersion,
    supported,
    missingRequired,
    degradedFeatures,
    reasons,
  };
};

/** Static catalog validation prevents a detected executable from being presented with a malformed ACP launch contract. */
export const validateAcpCatalog = (definitions: AcpCatalogDefinition[]): AcpCatalogIssue[] => {
  const issues: AcpCatalogIssue[] = [];
  const ids = new Set<string>();
  for (const definition of definitions.filter((item) => item.protocol === 'acp')) {
    if (!definition.id.trim())
      issues.push({ targetId: definition.id, severity: 'error', message: 'ACP target ID is empty.' });
    if (ids.has(definition.id)) {
      issues.push({ targetId: definition.id, severity: 'error', message: 'ACP target ID is duplicated.' });
    }
    ids.add(definition.id);
    if (!definition.name.trim()) {
      issues.push({ targetId: definition.id, severity: 'error', message: 'ACP target name is empty.' });
    }
    if (definition.candidates.length === 0 || definition.candidates.some((candidate) => !candidate.trim())) {
      issues.push({ targetId: definition.id, severity: 'error', message: 'ACP executable candidates are invalid.' });
    }
    if (!definition.runnable) {
      issues.push({ targetId: definition.id, severity: 'warning', message: 'ACP target is catalogued but disabled.' });
    }
  }
  return issues;
};
