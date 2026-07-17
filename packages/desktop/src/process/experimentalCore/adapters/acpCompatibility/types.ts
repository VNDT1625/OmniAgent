/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentCapabilities, SessionModelState } from '@agentclientprotocol/sdk';
import type { CoreAdapterDefinition } from '../coreAdapter';

export type AcpFeature =
  | 'text'
  | 'resource-link'
  | 'image'
  | 'audio'
  | 'embedded-context'
  | 'load-session'
  | 'session-list'
  | 'session-resume'
  | 'session-fork'
  | 'session-close'
  | 'mcp-stdio'
  | 'mcp-http'
  | 'mcp-sse'
  | 'model-selection';

export type AcpContractRequirements = {
  required?: AcpFeature[];
  preferred?: AcpFeature[];
};

export type AcpHandshakeSnapshot = {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  models?: SessionModelState | null;
};

export type AcpCompatibilityReport = {
  targetId?: string;
  status: 'full' | 'degraded' | 'incompatible';
  protocolVersion: number;
  supported: AcpFeature[];
  missingRequired: AcpFeature[];
  degradedFeatures: AcpFeature[];
  reasons: string[];
};

export type AcpCatalogIssue = {
  targetId: string;
  severity: 'error' | 'warning';
  message: string;
};

export type AcpCatalogDefinition = Pick<
  CoreAdapterDefinition,
  'id' | 'name' | 'protocol' | 'candidates' | 'args' | 'detail' | 'runnable'
>;
