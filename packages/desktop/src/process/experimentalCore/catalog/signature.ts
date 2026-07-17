/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPublicKey, verify } from 'node:crypto';

/**
 * Build a strict Ed25519 verifier for adapter catalogs.
 *
 * The public key may be PEM or base64-encoded SPKI DER. Signatures are base64.
 * Invalid key material and malformed signatures fail closed.
 */
export const createEd25519CatalogVerifier = (publicKey: string): ((payload: string, signature: string) => boolean) => {
  const value = publicKey.trim();
  if (!value) throw new Error('Tomny adapter catalog public key is required.');
  const key = value.includes('BEGIN PUBLIC KEY')
    ? createPublicKey(value)
    : createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Tomny adapter catalog public key must use Ed25519.');
  }
  return (payload, signature): boolean => {
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(signature) || signature.length % 4 !== 0) return false;
      return verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  };
};
