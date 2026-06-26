/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public-tunnel adapter for the Omni External MCP Gateway — wraps the
 * already-built Cloudflare Quick Tunnel helper so the gateway can expose
 * `http://127.0.0.1:<port>` as `https://<random>.trycloudflare.com` for
 * external AI hosts (ChatGPT/Grok with an MCP connector, browser tools using
 * the Debug Bridge).
 *
 * IMPORTANT — Cloudflare Quick Tunnels are a DEVELOPMENT / TEST tool, not
 * production: they do not proxy SSE reliably, the URL changes every time, and
 * upstream reliability is not guaranteed. The gateway therefore only mounts
 * tunnel-safe paths (`/ide/mcp` Streamable HTTP + `/debug/omni/*`) and tells
 * the user this explicitly in the Settings UI. Cloudflare's own docs say
 * Quick Tunnels are for development; production wants a named tunnel.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import {
  ensureCloudflared,
  isCloudflaredAvailable,
  startTunnel,
  stopTunnel,
  type TunnelResult,
} from '@process/studio/cloudflareTunnel';
import type { OmniGatewayProgressPhase } from './omniGatewayProgress';

/** Key passed to the underlying tunnel map so we own exactly ONE tunnel. */
export const OMNI_GATEWAY_TUNNEL_KEY = 'omni-gateway';

/** Result returned from {@link startOmniTunnel}. */
export type StartOmniTunnelResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'cloudflared-missing' | 'install-failed' | 'start-failed' | 'timeout'; detail?: string };

/** Options accepted by {@link startOmniTunnel}. */
export type StartOmniTunnelOptions = {
  /**
   * Phase notifications for the UI. Called with the most recent phase as soon
   * as we hit it. Never throws — wrap your sink in try/catch if needed.
   */
  onProgress?: (phase: OmniGatewayProgressPhase, message?: string) => void;
};

/**
 * Start (or reuse) a Cloudflare Quick Tunnel that fronts our loopback port.
 *
 * @param port The loopback port the gateway HTTP server is bound to.
 * @param opts Optional progress sink so the Settings UI can render per-phase
 *   feedback instead of an opaque spinner.
 */
export const startOmniTunnel = async (
  port: number,
  opts: StartOmniTunnelOptions = {}
): Promise<StartOmniTunnelResult> => {
  const { onProgress } = opts;
  const emit = (phase: OmniGatewayProgressPhase, message?: string): void => {
    if (!onProgress) return;
    try {
      onProgress(phase, message);
    } catch {
      /* sink errors must never break the tunnel lifecycle */
    }
  };

  // 1) Ensure the cloudflared binary is available, installing on demand
  //    (downloads into the app's userData on Windows/Linux; falls back to
  //    package managers on macOS). The probe itself takes ~1 s, the install
  //    can take 5–30 s the first time — both worth surfacing.
  emit('checking-cloudflared');
  if (!(await isCloudflaredAvailable())) {
    emit('installing-cloudflared');
    const ensured = await ensureCloudflared();
    if (!ensured.ok) {
      return {
        ok: false,
        reason: 'install-failed',
        detail: 'detail' in ensured ? ensured.detail : 'Could not install cloudflared.',
      };
    }
  }

  // 2) Spawn the quick tunnel pointing at our loopback origin. Cloudflare's
  //    edge can hold us for 5–25 s between spawn and URL assignment, so we
  //    emit spawning-tunnel before starting the process, then switch to
  //    waiting-tunnel-url while Cloudflare assigns the public URL.
  emit('spawning-tunnel');
  emit('waiting-tunnel-url');
  const result: TunnelResult = await startTunnel(OMNI_GATEWAY_TUNNEL_KEY, `http://127.0.0.1:${port}`);
  if (result.ok) return { ok: true, url: result.url };
  const reason = 'reason' in result ? result.reason : 'start-failed';
  const detail = 'detail' in result ? result.detail : undefined;
  if (reason === 'not-installed') {
    return { ok: false, reason: 'cloudflared-missing', detail };
  }
  return { ok: false, reason, detail };
};

/** Stop the gateway's Cloudflare Quick Tunnel (no-op when none running). */
export const stopOmniTunnel = (): void => {
  stopTunnel(OMNI_GATEWAY_TUNNEL_KEY);
};
