/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PURE secret redaction for learned commands (FR8).
 *
 * Before a command line is persisted to docTerminal, secret values are masked
 * with `***` so the knowledge store never keeps tokens/passwords/keys. Three
 * heuristics, applied in order:
 *   1. secret-bearing flags (`--token=…`, `--password …`, `api_key=…`),
 *   2. credentials embedded in a URL (`scheme://user:pass@host`),
 *   3. long opaque mixed (letters+digits) blobs that look like keys.
 *
 * Conservative by design: plain words and file paths are left intact so
 * suggestions still make sense. No I/O.
 */

/** Placeholder substituted for a redacted secret value. */
export const MASK = '***';

/** Flag/key names whose VALUE is a secret. */
const SECRET_KEYS = [
  'token',
  'password',
  'passwd',
  'pwd',
  'api[_-]?key',
  'apikey',
  'secret',
  'access[_-]?token',
  'auth[_-]?token',
  'client[_-]?secret',
];

/** `--key=VALUE` / `--key VALUE` / `key=VALUE` forms (value masked, separator kept). */
const KEY_VALUE = new RegExp(`((?:--?)?(?:${SECRET_KEYS.join('|')}))(\\s*=\\s*|\\s+)(\\S+)`, 'gi');

/** Bare env-style `XXX_TOKEN=value` assignments. */
const ENV_ASSIGN = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|ACCESS_KEY))=(\S+)/g;

/** Credentials in a URL: `scheme://user:PASS@host`. */
const URL_CREDS = /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s]+:)([^@/\s]+)(@)/gi;

/** A long opaque blob with BOTH letters and digits (key-like). */
const OPAQUE = /\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{20,}\b/g;

/**
 * Redact secret values in a command line, masking them with {@link MASK} while
 * preserving the command's structure.
 *
 * @param command The raw command line.
 * @returns The command with secret values masked.
 */
export const redactSecrets = (command: string): string => {
  if (command.length === 0) return command;
  return command
    .replace(KEY_VALUE, (_m, key: string, sep: string) => `${key}${sep.includes('=') ? '=' : ' '}${MASK}`)
    .replace(ENV_ASSIGN, (_m, key: string) => `${key}=${MASK}`)
    .replace(URL_CREDS, (_m, head: string, _pass: string, at: string) => `${head}${MASK}${at}`)
    .replace(OPAQUE, MASK);
};
