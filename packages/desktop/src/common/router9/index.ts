/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 9Router distribution layer — public surface.
 *
 * Re-exports the pure connector engine + target registry so renderer and main
 * can both consume them without reaching into individual files.
 */
export * from './types';
export { CONNECTOR_TARGETS, getConnectorTarget } from './targets';
export { buildConnectorPlan, resolveBaseUrl, toOrigin, toV1 } from './connectorEngine';
export { deepMerge, expandHome, mergeConfigContent } from './applyPlan';
