/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Automation credential vault IPC surface. Mirrors
 * `automationClient.ts`: re-declares the channel names and rebuilds matching
 * `bridge.buildProvider` invokers, borrowing only types via `import type`.
 *
 * The renderer only ever sees credential metadata + field keys — never the
 * decrypted secret values (those stay in the Main process).
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  CredentialResult,
  CredentialSummary,
  RemoveCredentialRequest,
  SaveCredentialRequest,
} from '@process/automation/credentialBridge';

const CREDENTIAL_CHANNELS = {
  list: 'automation.cred.list',
  save: 'automation.cred.save',
  remove: 'automation.cred.remove',
} as const;

const TIMEOUT_MS = 8000;

const channels = {
  list: bridge.buildProvider<CredentialResult<CredentialSummary[]>, void>(CREDENTIAL_CHANNELS.list),
  save: bridge.buildProvider<CredentialResult<CredentialSummary>, SaveCredentialRequest>(CREDENTIAL_CHANNELS.save),
  remove: bridge.buildProvider<CredentialResult<CredentialSummary[]>, RemoveCredentialRequest>(
    CREDENTIAL_CHANNELS.remove
  ),
};

/** Race an invoke against a timeout so an unwired bridge rejects fast. */
const withTimeout = <T>(call: () => Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('[CredentialClient] No reply — the credential bridge may not be wired yet.'));
    }, TIMEOUT_MS);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Timeout-guarded credential invokers for the renderer. */
export const credentialClient = {
  list: (): Promise<CredentialResult<CredentialSummary[]>> => withTimeout(() => channels.list.invoke()),
  save: (req: SaveCredentialRequest): Promise<CredentialResult<CredentialSummary>> =>
    withTimeout(() => channels.save.invoke(req)),
  remove: (id: string): Promise<CredentialResult<CredentialSummary[]>> =>
    withTimeout(() => channels.remove.invoke({ id })),
};

export type { CredentialSummary };
