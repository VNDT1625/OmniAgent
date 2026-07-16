/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Credential vault IPC bridge — exposes CRUD for the Automation credential store
 * to the renderer (the credential manager UI + the node config credential
 * picker). Decrypted field values are NEVER sent to the renderer; only metadata
 * (id, name, kind, the field *keys*) crosses the boundary. The engine resolves a
 * credential's secrets in the Main process at run time via {@link resolveCredentialFields}.
 *
 * Channels:
 *  - `automation.cred.list`   — list credentials (metadata + field keys only).
 *  - `automation.cred.save`   — upsert a credential (plain values encrypted here).
 *  - `automation.cred.remove` — delete a credential by id.
 *
 * Every channel resolves a result envelope (never rejects) so the renderer can
 * branch on `ok` instead of hanging.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { createCredentialStore, type Credential, type ICredentialStore } from './credentialStore';

/** IPC channel names for the credential vault (renderer-safe contract). */
export const CREDENTIAL_CHANNELS = {
  list: 'automation.cred.list',
  save: 'automation.cred.save',
  remove: 'automation.cred.remove',
} as const;

/** Always-resolving result envelope. */
export type CredentialResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Renderer-safe view of a credential — metadata + the field *keys* only (never
 * the decrypted secret values).
 */
export type CredentialSummary = {
  id: string;
  name: string;
  kind: Credential['kind'];
  fieldKeys: string[];
  updatedAt: number;
};

/** Request for {@link CREDENTIAL_CHANNELS.save}. */
export type SaveCredentialRequest = {
  /** Existing id to update, or blank/absent to create. */
  id?: string;
  name: string;
  kind: Credential['kind'];
  /** Plain-text field values; encrypted in the Main process before persisting. */
  fields: Record<string, string>;
};

/** Request for {@link CREDENTIAL_CHANNELS.remove}. */
export type RemoveCredentialRequest = { id: string };

/** Typed credential channels. Exported for bootstrap registration wiring. */
export const credentialChannels = {
  list: bridge.buildProvider<CredentialResult<CredentialSummary[]>, void>(CREDENTIAL_CHANNELS.list),
  save: bridge.buildProvider<CredentialResult<CredentialSummary>, SaveCredentialRequest>(CREDENTIAL_CHANNELS.save),
  remove: bridge.buildProvider<CredentialResult<CredentialSummary[]>, RemoveCredentialRequest>(
    CREDENTIAL_CHANNELS.remove
  ),
};

/** Project a full {@link Credential} onto its renderer-safe summary. */
const toSummary = (cred: Credential): CredentialSummary => ({
  id: cred.id,
  name: cred.name,
  kind: cred.kind,
  fieldKeys: Object.keys(cred.fields),
  updatedAt: cred.updatedAt,
});

/** Lazily-built shared store (also used by the engine for run-time resolution). */
let sharedStore: ICredentialStore | undefined;
const getStore = (): ICredentialStore => {
  if (!sharedStore) sharedStore = createCredentialStore();
  return sharedStore;
};

/**
 * Resolve a credential's decrypted fields by id, in the Main process. Used by
 * node connectors that accept a `credentialId` instead of inline secrets.
 * Returns `undefined` when the credential does not exist.
 */
export const resolveCredentialFields = (id: string): Promise<Record<string, string> | undefined> =>
  getStore().getDecrypted(id);

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Register the credential vault IPC handlers. Idempotent. Intended to be called
 * once during Main-process bootstrap.
 */
export function registerCredentialBridge(): void {
  const store = getStore();

  credentialChannels.list.provider(async (): Promise<CredentialResult<CredentialSummary[]>> => {
    try {
      const list = await store.list();
      return { ok: true, data: list.map(toSummary) };
    } catch (error) {
      console.error('[CredentialBridge] list failed:', error);
      return { ok: false, error: errorMessage(error) };
    }
  });

  credentialChannels.save.provider(async (req): Promise<CredentialResult<CredentialSummary>> => {
    try {
      const saved = await store.save({ id: req.id, name: req.name, kind: req.kind, fields: req.fields });
      return { ok: true, data: toSummary(saved) };
    } catch (error) {
      console.error('[CredentialBridge] save failed:', error);
      return { ok: false, error: errorMessage(error) };
    }
  });

  credentialChannels.remove.provider(async (req): Promise<CredentialResult<CredentialSummary[]>> => {
    try {
      const remaining = await store.remove(req.id);
      return { ok: true, data: remaining.map(toSummary) };
    } catch (error) {
      console.error('[CredentialBridge] remove failed:', error);
      return { ok: false, error: errorMessage(error) };
    }
  });
}

/** Reset the shared store (deterministic teardown for tests). */
export function disposeCredentialBridge(): void {
  sharedStore = undefined;
}
