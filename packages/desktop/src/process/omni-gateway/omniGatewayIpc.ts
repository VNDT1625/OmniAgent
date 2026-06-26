/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IPC handlers for the Omni External MCP Gateway Settings panel.
 *
 * Mirrors `notificationBridge.ts`: registers each provider in the catalog
 * declared on {@link ipcBridge.omniGateway} so the renderer can call into the
 * Main-process gateway lifecycle without leaking the bearer token into a
 * persisted config file.
 *
 * Process boundary: Main-process (Node.js / Electron). No DOM APIs.
 */

import { ipcBridge } from '@/common';
import {
  applyOmniGatewayConfig,
  createOmniGatewayDebugAccess,
  disableOmniGatewayWebAccess,
  enableOmniGatewayWebAccess,
  ensureOmniGatewayStarted,
  getOmniGatewayLatestProgress,
  getOmniGatewayStatus,
  listOmniGatewayOAuthClients,
  revokeOmniGatewayDebugAccess,
  revokeOmniGatewayOAuthClient,
  rotateOmniGatewayToken,
  revealOmniGatewayToken,
  setOmniGatewayAuthMode,
  setOmniGatewayRemoteAccess,
  setOmniGatewaySessionTtl,
  setOmniGatewayToolPermission,
} from './registerOmniGateway';

/** Register every IPC provider used by the External MCP Gateway settings UI. */
export const initOmniGatewayBridge = (): void => {
  ipcBridge.omniGateway.getStatus.provider(async () => getOmniGatewayStatus());
  ipcBridge.omniGateway.applyConfig.provider(async (patch) => applyOmniGatewayConfig(patch));
  ipcBridge.omniGateway.rotateToken.provider(async () => rotateOmniGatewayToken());
  ipcBridge.omniGateway.revealToken.provider(async () => revealOmniGatewayToken());
  ipcBridge.omniGateway.enableWebAccess.provider(async () => enableOmniGatewayWebAccess());
  ipcBridge.omniGateway.disableWebAccess.provider(async () => disableOmniGatewayWebAccess());
  ipcBridge.omniGateway.createDebugAccess.provider(async () => createOmniGatewayDebugAccess());
  ipcBridge.omniGateway.revokeDebugAccess.provider(async () => revokeOmniGatewayDebugAccess());
  ipcBridge.omniGateway.getProgress.provider(async () => getOmniGatewayLatestProgress());
  ipcBridge.omniGateway.setAuthMode.provider(async ({ mode }) => setOmniGatewayAuthMode(mode));
  ipcBridge.omniGateway.setSessionTtl.provider(async ({ ttlMs }) => setOmniGatewaySessionTtl(ttlMs));
  ipcBridge.omniGateway.setToolPermission.provider(async ({ toolName, allowed }) =>
    setOmniGatewayToolPermission(toolName, allowed)
  );
  ipcBridge.omniGateway.listOAuthClients.provider(async () => listOmniGatewayOAuthClients());
  ipcBridge.omniGateway.revokeOAuthClient.provider(async ({ clientId }) => revokeOmniGatewayOAuthClient(clientId));
  ipcBridge.omniGateway.setRemoteAccess.provider(async (patch) => setOmniGatewayRemoteAccess(patch));

  void ensureOmniGatewayStarted().catch((error) => {
    console.warn('[OmniGateway] startup ensure failed:', error);
  });
};
