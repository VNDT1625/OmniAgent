/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Encrypted persistence for the Omni External MCP Gateway's auth layer.
 *
 * Stores the whole auth state as a SINGLE AES-256-GCM ciphertext blob in
 * `omni-gateway-security.json` inside the Electron `userData` directory. The
 * encryption scheme mirrors {@link createCredentialStore} exactly:
 *   - 32-byte AES-256 key derived from SHA-256 of the `userData` path (stable
 *     per installation, never leaves the machine — only this app on this
 *     machine can decrypt it).
 *   - `<iv_hex>:<authTag_hex>:<ciphertext_hex>` envelope.
 *
 * Unlike the per-field credential store, the gateway's auth state is small and
 * always read/written as a whole, so we encrypt the entire JSON document in one
 * shot. The on-disk file therefore reveals nothing — not even which auth mode
 * is selected or how many OAuth clients exist.
 *
 * Persisted state:
 *   - `authMode`        — bearer | oauth | none | mixed
 *   - `sessionTtlMs`    — idle session TTL surfaced to bootstrap/state
 *   - `toolPermissions` — per-tool allow/deny overrides
 *   - `oauthClients`    — registered OAuth clients (DCR)
 *   - `oauthTokens`     — live access/refresh tokens
 *
 * Testability: `dir`, `fs`, `now`, and `encryptionKey` are injectable so unit
 * tests run with a deterministic key and an in-memory fs.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  OMNI_DEFAULT_AUTH_MODE,
  isOmniAuthMode,
  type OmniAuthMode,
  type OmniOAuthClient,
  type OmniOAuthToken,
  type OmniToolPermissions,
} from './authTypes';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The full, decrypted auth state held by the gateway. */
export type OmniSecurityState = {
  authMode: OmniAuthMode;
  sessionTtlMs: number;
  toolPermissions: OmniToolPermissions;
  oauthClients: OmniOAuthClient[];
  oauthTokens: OmniOAuthToken[];
};

/** Public contract of the security store. */
export type IOmniSecurityStore = {
  /** Load the decrypted state (cached after first read). */
  load(): Promise<OmniSecurityState>;
  /** Persist the full state atomically (encrypted). Returns the saved state. */
  save(state: OmniSecurityState): Promise<OmniSecurityState>;
  /** Apply a shallow patch over the current state and persist it. */
  patch(patch: Partial<OmniSecurityState>): Promise<OmniSecurityState>;
};

/** Minimal subset of `fs/promises` used here (injectable for tests). */
export type OmniSecurityFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Construction options for {@link createOmniSecurityStore}. */
export type OmniSecurityStoreOptions = {
  /** Directory the data file lives in. Defaults to the Electron `userData` dir. */
  dir?: string;
  /** File-system implementation. Injectable for tests; defaults to `fs/promises`. */
  fs?: OmniSecurityFs;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** 32-byte AES-256 key. When provided, skips machine-id derivation (tests). */
  encryptionKey?: Buffer;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the persisted document inside the app data directory. */
const SECURITY_DATA_FILE = 'omni-gateway-security.json';

/** Persisted-document schema version (bump if the envelope changes). */
const SECURITY_DOC_VERSION = 1;

/** AES-256-GCM IV length in bytes. */
const IV_BYTES = 12;

/** AES-256-GCM auth-tag length in bytes. */
const AUTH_TAG_BYTES = 16;

/** Default idle session TTL (6h) — matches the gateway's historical default. */
export const OMNI_SECURITY_DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Default fs adapter
// ---------------------------------------------------------------------------

const defaultFs: OmniSecurityFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

// ---------------------------------------------------------------------------
// Key derivation + crypto (mirrors credentialStore.ts)
// ---------------------------------------------------------------------------

/** Derive a 32-byte AES-256 key from the stable `userData` path. */
const deriveKey = (dir: string): Buffer => createHash('sha256').update(dir).digest();

/** Encrypt a plain-text string → `<iv_hex>:<authTag_hex>:<ciphertext_hex>`. */
const encrypt = (plaintext: string, key: Buffer): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
};

/** Decrypt a value produced by {@link encrypt}; returns null on any failure. */
const decrypt = (encoded: string, key: Buffer): string | null => {
  try {
    const parts = encoded.split(':');
    if (parts.length !== 3) return null;
    const [ivHex, tagHex, ctHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ct = Buffer.from(ctHex, 'hex');
    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(ct).toString('utf-8') + decipher.final('utf-8');
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Defensive normalisation
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Build the default (empty) auth state. */
const defaultState = (): OmniSecurityState => ({
  authMode: OMNI_DEFAULT_AUTH_MODE,
  sessionTtlMs: OMNI_SECURITY_DEFAULT_SESSION_TTL_MS,
  toolPermissions: {},
  oauthClients: [],
  oauthTokens: [],
});

const normaliseToolPermissions = (v: unknown): OmniToolPermissions => {
  if (!isObject(v)) return {};
  const out: OmniToolPermissions = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'boolean') out[k] = val;
  }
  return out;
};

const normaliseClient = (v: unknown): OmniOAuthClient | null => {
  if (!isObject(v) || !isStr(v.clientId) || v.clientId.length === 0) return null;
  const redirectUris = Array.isArray(v.redirectUris) ? v.redirectUris.filter(isStr) : [];
  const grantTypes = Array.isArray(v.grantTypes) ? v.grantTypes.filter(isStr) : ['authorization_code', 'refresh_token'];
  return {
    clientId: v.clientId,
    clientSecret: isStr(v.clientSecret) ? v.clientSecret : undefined,
    clientName: isStr(v.clientName) ? v.clientName : undefined,
    redirectUris,
    createdAt: isFiniteNum(v.createdAt) ? v.createdAt : 0,
    grantTypes,
    tokenEndpointAuthMethod: isStr(v.tokenEndpointAuthMethod) ? v.tokenEndpointAuthMethod : 'none',
  };
};

const normaliseToken = (v: unknown): OmniOAuthToken | null => {
  if (!isObject(v) || !isStr(v.accessToken) || !isStr(v.refreshToken) || !isStr(v.clientId)) return null;
  return {
    accessToken: v.accessToken,
    refreshToken: v.refreshToken,
    clientId: v.clientId,
    scope: isStr(v.scope) ? v.scope : '',
    issuedAt: isFiniteNum(v.issuedAt) ? v.issuedAt : 0,
    accessExpiresAt: isFiniteNum(v.accessExpiresAt) ? v.accessExpiresAt : 0,
    refreshExpiresAt: isFiniteNum(v.refreshExpiresAt) ? v.refreshExpiresAt : 0,
  };
};

/** Coerce an arbitrary parsed value into a valid {@link OmniSecurityState}. */
const normaliseState = (parsed: unknown): OmniSecurityState => {
  const base = defaultState();
  if (!isObject(parsed)) return base;
  return {
    authMode: isOmniAuthMode(parsed.authMode) ? parsed.authMode : base.authMode,
    sessionTtlMs: isFiniteNum(parsed.sessionTtlMs) && parsed.sessionTtlMs > 0 ? parsed.sessionTtlMs : base.sessionTtlMs,
    toolPermissions: normaliseToolPermissions(parsed.toolPermissions),
    oauthClients: Array.isArray(parsed.oauthClients)
      ? parsed.oauthClients.map(normaliseClient).filter((c): c is OmniOAuthClient => c !== null)
      : [],
    oauthTokens: Array.isArray(parsed.oauthTokens)
      ? parsed.oauthTokens.map(normaliseToken).filter((t): t is OmniOAuthToken => t !== null)
      : [],
  };
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the gateway security store. State is cached in memory after the first
 * read and persisted atomically (tmp → rename) after each mutation.
 */
export const createOmniSecurityStore = (options?: OmniSecurityStoreOptions): IOmniSecurityStore => {
  const fsImpl = options?.fs ?? defaultFs;
  const resolveDir = (): string => options?.dir ?? app.getPath('userData');

  let _key: Buffer | undefined = options?.encryptionKey;
  const getKey = (): Buffer => {
    if (!_key) _key = deriveKey(resolveDir());
    return _key;
  };

  const filePath = (): string => path.join(resolveDir(), SECURITY_DATA_FILE);

  let cache: OmniSecurityState | undefined;

  const load = async (): Promise<OmniSecurityState> => {
    if (cache) return cache;
    try {
      const raw = await fsImpl.readFile(filePath(), 'utf-8');
      const doc = JSON.parse(raw) as unknown;
      // Envelope: { v: number, data: "<iv:tag:ct>" }
      if (isObject(doc) && isStr(doc.data)) {
        const plain = decrypt(doc.data, getKey());
        cache = plain ? normaliseState(JSON.parse(plain) as unknown) : defaultState();
      } else {
        cache = defaultState();
      }
    } catch (error) {
      if (!isFileNotFound(error)) {
        console.warn('[OmniSecurityStore] Failed to read security state; using defaults:', error);
      }
      cache = defaultState();
    }
    return cache;
  };

  const save = async (state: OmniSecurityState): Promise<OmniSecurityState> => {
    const normalised = normaliseState(state);
    cache = normalised;
    const fp = filePath();
    const dir = path.dirname(fp);
    const tmpPath = `${fp}.tmp`;
    const envelope = JSON.stringify({ v: SECURITY_DOC_VERSION, data: encrypt(JSON.stringify(normalised), getKey()) });
    await fsImpl.mkdir(dir, { recursive: true });
    await fsImpl.writeFile(tmpPath, envelope + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, fp);
    return normalised;
  };

  return {
    load,
    save,
    async patch(patch) {
      const current = await load();
      return save({ ...current, ...patch });
    },
  };
};
