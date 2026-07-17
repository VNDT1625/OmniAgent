/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CoreAdapterDefinition } from '../adapters';

export const ADAPTER_CATALOG_SCHEMA_VERSION = 1;

export type CoreCompatibilityRange = {
  min: string;
  max?: string;
};

export type AdapterCatalogDocument = {
  schemaVersion: number;
  revision: string;
  coreCompatibility: CoreCompatibilityRange;
  definitions: CoreAdapterDefinition[];
  sha256: string;
  signature?: string;
};

export type CatalogVerificationOptions = {
  coreVersion?: string;
  /** Production catalogs must set this so unsigned documents fail closed. */
  requireSignature?: boolean;
  verifySignature?: (payload: string, signature: string) => boolean;
};

export type AdapterCatalogErrorCode =
  | 'invalid-json'
  | 'invalid-schema'
  | 'unsupported-schema'
  | 'incompatible-core'
  | 'hash-mismatch'
  | 'signature-required'
  | 'signature-invalid';

export class AdapterCatalogError extends Error {
  public constructor(
    public readonly code: AdapterCatalogErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AdapterCatalogError';
  }
}
