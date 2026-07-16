/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConnectorTarget } from './types';

/**
 * Registry of CLI / IDE tools AionUi can auto-configure to route through
 * 9Router. Ordering is display order (most-requested first).
 *
 * Each entry only declares *how* the tool is wired, never secrets. The plan
 * engine (`buildConnectorPlan`) turns an entry + endpoint into a concrete,
 * apply-able plan. Adding a new tool is a one-line registry change.
 */
export const CONNECTOR_TARGETS: ConnectorTarget[] = [
  {
    id: 'kiro',
    label: 'Kiro',
    protocol: 'openai',
    mechanism: 'manual',
    descriptionKey: 'settings.router9.target.kiro',
    baseUrlStyle: 'withV1',
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    protocol: 'openai',
    mechanism: 'manual',
    descriptionKey: 'settings.router9.target.antigravity',
    baseUrlStyle: 'withV1',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    protocol: 'anthropic',
    mechanism: 'configFile',
    descriptionKey: 'settings.router9.target.claudeCode',
    baseUrlStyle: 'withV1',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    protocol: 'openai',
    mechanism: 'env',
    descriptionKey: 'settings.router9.target.codex',
    baseUrlStyle: 'origin',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    protocol: 'openai',
    mechanism: 'manual',
    descriptionKey: 'settings.router9.target.cursor',
    baseUrlStyle: 'withV1',
  },
  {
    id: 'cline',
    label: 'Cline',
    protocol: 'openai',
    mechanism: 'manual',
    descriptionKey: 'settings.router9.target.cline',
    baseUrlStyle: 'withV1',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    protocol: 'openai',
    mechanism: 'configFile',
    descriptionKey: 'settings.router9.target.openclaw',
    baseUrlStyle: 'withV1',
  },
];

/** Look up a target definition by id. */
export const getConnectorTarget = (id: string): ConnectorTarget | undefined => {
  return CONNECTOR_TARGETS.find((t) => t.id === id);
};
