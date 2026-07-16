/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { startTunnel, stopTunnel, type TunnelResult } from '@process/studio/cloudflareTunnel';

const TUNNEL_KEY = 'telegram-remote';
const SECRET_ENV = 'AIONUI_TELEGRAM_REMOTE_SECRET';
let startPromise: Promise<TunnelResult> | null = null;
let activeBackendPort: number | null = null;
let activePublicUrl: string | null = null;
let appLanguage = 'en-US';

/** Seed the credential inherited by aioncore before its process is spawned. */
export function prepareTelegramRemoteSecret(): string {
  const existing = process.env[SECRET_ENV]?.trim();
  if (existing) return existing;
  const secret = randomBytes(32).toString('hex');
  process.env[SECRET_ENV] = secret;
  return secret;
}

/**
 * Publish the token-protected Telegram remote surface and give aioncore its
 * HTTPS origin. Repeated readiness callbacks share one in-flight tunnel.
 */
export function startTelegramRemoteTunnel(backendPort: number, language = 'en-US'): Promise<TunnelResult> {
  activeBackendPort = backendPort;
  appLanguage = language;
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const result = await startTunnel(TUNNEL_KEY, `http://127.0.0.1:${backendPort}`);
    if (!result.ok) return result;

    try {
      const response = await postRemoteConfiguration(backendPort, {
        public_url: result.url,
        language: appLanguage,
      });
      if (!response.ok) {
        stopTunnel(TUNNEL_KEY);
        return { ok: false, reason: 'start-failed', detail: `aioncore rejected tunnel setup (${response.status})` };
      }
      activePublicUrl = result.url;
      return result;
    } catch (error) {
      stopTunnel(TUNNEL_KEY);
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: 'start-failed', detail };
    }
  })();
  return startPromise;
}

async function postRemoteConfiguration(
  backendPort: number,
  configuration: { public_url?: string; language?: string }
): Promise<Response> {
  return fetch(`http://127.0.0.1:${backendPort}/api/channel/remote/public-url`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aionui-remote-secret': prepareTelegramRemoteSecret(),
    },
    body: JSON.stringify(configuration),
    signal: AbortSignal.timeout(10_000),
  });
}

/** Keep Remote copy aligned with the language selected in AionUi. */
export async function syncTelegramRemoteLanguage(language: string): Promise<boolean> {
  appLanguage = language;
  if (activeBackendPort === null || activePublicUrl === null) return false;
  try {
    const response = await postRemoteConfiguration(activeBackendPort, { language });
    return response.ok;
  } catch (error) {
    console.warn('[TelegramRemote] language sync failed', error);
    return false;
  }
}

export function stopTelegramRemoteTunnel(): void {
  stopTunnel(TUNNEL_KEY);
  startPromise = null;
  activeBackendPort = null;
  activePublicUrl = null;
}
