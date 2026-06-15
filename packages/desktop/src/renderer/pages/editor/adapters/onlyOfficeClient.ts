/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the ONLYOFFICE editing bridge + the Document Server
 * URL setting.
 *
 * The Main-process bridge runs OUR on-demand integration host; this client
 * starts/stops a session. The Document Server URL (the heavy editor engine the
 * user runs separately) is a Studio setting kept in `localStorage`.
 *
 * Renderer-only. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type { EditSessionInfo } from '@process/studio/onlyOfficeServer';

const ONLYOFFICE_CHANNELS = {
  editStart: 'studio.office-edit-start',
  editStop: 'studio.office-edit-stop',
  ensureServer: 'studio.office-ensure-server',
} as const;

/** localStorage key holding the user's Document Server base URL. */
export const ONLYOFFICE_URL_KEY = 'studio.onlyofficeUrl';

type EditResult = { ok: true; data: EditSessionInfo } | { ok: false; error: string };

/** Failure arm of {@link EditResult}; cast target under the no-`strictNullChecks` tsconfig. */
type EditFailure = { ok: false; error: string };

/** Outcome of resolving/starting a Document Server (mirrors the Main type). */
export type EnsureServerResult =
  | { ok: true; url: string; managed: boolean }
  | { ok: false; reason: 'docker-missing' | 'docker-stopped' | 'start-failed' | 'timeout'; detail?: string };

const editStartProvider = bridge.buildProvider<EditResult, { path: string; advertisedHost?: string }>(
  ONLYOFFICE_CHANNELS.editStart
);
const editStopProvider = bridge.buildProvider<{ ok: true }, { token: string }>(ONLYOFFICE_CHANNELS.editStop);
const ensureServerProvider = bridge.buildProvider<EnsureServerResult, { configuredUrl?: string }>(
  ONLYOFFICE_CHANNELS.ensureServer
);

/**
 * Read the user-configured Document Server base URL (trimmed, no trailing
 * slash). Returns '' when unset OR when it points at our own managed container
 * (localhost:8080 / 127.0.0.1:8080) — earlier builds wrongly persisted that, and
 * treating it as "configured" skips the managed reconcile (JWT + host gateway).
 * Ignoring it forces the manager path, which self-heals a stale container.
 */
export const getDocumentServerUrl = (): string => {
  try {
    const raw = (localStorage.getItem(ONLYOFFICE_URL_KEY) ?? '').trim().replace(/\/+$/, '');
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:8080)?$/i.test(raw)) return '';
    return raw;
  } catch {
    return '';
  }
};

/** Persist the Document Server base URL. */
export const setDocumentServerUrl = (url: string): void => {
  try {
    localStorage.setItem(ONLYOFFICE_URL_KEY, url.trim());
  } catch {
    /* storage unavailable — non-fatal */
  }
};

/** Race an invoke against a timeout so a missing bridge rejects instead of hanging. */
const withTimeout = <T>(call: () => Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('ONLYOFFICE bridge timed out — restart the app so the bridge is wired.'));
    }, ms);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Start an editing session for `path`; returns the editor session info. */
export const startOfficeEdit = async (path: string, advertisedHost?: string): Promise<EditSessionInfo> => {
  const result = await withTimeout(() => editStartProvider.invoke({ path, advertisedHost }), 30000);
  if (result.ok) return result.data;
  throw new Error((result as EditFailure).error);
};

/** End an editing session (best-effort). */
export const stopOfficeEdit = async (token: string): Promise<void> => {
  try {
    await withTimeout(() => editStopProvider.invoke({ token }), 10000);
  } catch {
    /* best-effort */
  }
};

/**
 * Resolve a reachable Document Server: prefer the configured URL, otherwise ask
 * the Main process to start the managed Docker container on demand. Starting a
 * fresh container can take a while, so this allows a generous timeout.
 */
export const ensureDocumentServer = async (configuredUrl?: string): Promise<EnsureServerResult> => {
  return withTimeout(() => ensureServerProvider.invoke({ configuredUrl }), 180000);
};
