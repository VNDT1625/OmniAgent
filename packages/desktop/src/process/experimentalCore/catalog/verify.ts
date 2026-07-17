/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type { CoreAdapterDefinition } from '../adapters';
import {
  ADAPTER_CATALOG_SCHEMA_VERSION,
  AdapterCatalogError,
  type AdapterCatalogDocument,
  type CatalogVerificationOptions,
} from './types';

const VERSION_PATTERN = /^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/u;

const canonicalPayload = (
  document: Pick<AdapterCatalogDocument, 'schemaVersion' | 'revision' | 'coreCompatibility' | 'definitions'>
): string =>
  JSON.stringify({
    schemaVersion: document.schemaVersion,
    revision: document.revision,
    coreCompatibility: document.coreCompatibility,
    definitions: document.definitions,
  });

export const hashAdapterCatalogPayload = (
  document: Pick<AdapterCatalogDocument, 'schemaVersion' | 'revision' | 'coreCompatibility' | 'definitions'>
): string => createHash('sha256').update(canonicalPayload(document), 'utf8').digest('hex');

const parseVersion = (version: string): number[] =>
  version
    .split(/[.+-]/u)
    .slice(0, 3)
    .map((part) => Number(part) || 0);

const compareVersions = (left: string, right: string): number => {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
};

const assertDefinitions = (definitions: unknown): definitions is CoreAdapterDefinition[] => {
  if (!Array.isArray(definitions) || definitions.length === 0) return false;
  return definitions.every((item) => {
    if (!item || typeof item !== 'object') return false;
    const value = item as Partial<CoreAdapterDefinition>;
    return (
      typeof value.id === 'string' &&
      value.id.trim() !== '' &&
      typeof value.name === 'string' &&
      value.name.trim() !== '' &&
      typeof value.protocol === 'string' &&
      Array.isArray(value.candidates) &&
      value.candidates.length > 0 &&
      value.candidates.every((candidate) => typeof candidate === 'string' && candidate.trim() !== '') &&
      Array.isArray(value.args) &&
      value.args.every((arg) => typeof arg === 'string') &&
      typeof value.detail === 'string' &&
      typeof value.runnable === 'boolean'
    );
  });
};

export const validateAdapterCatalog = (
  value: unknown,
  options: CatalogVerificationOptions = {}
): AdapterCatalogDocument => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdapterCatalogError('invalid-schema', 'Adapter catalog must be a signed schema document.');
  }
  const candidate = value as Partial<AdapterCatalogDocument>;
  if (candidate.schemaVersion !== ADAPTER_CATALOG_SCHEMA_VERSION) {
    throw new AdapterCatalogError(
      'unsupported-schema',
      `Unsupported adapter catalog schema: ${String(candidate.schemaVersion)}.`
    );
  }
  if (typeof candidate.revision !== 'string' || !candidate.revision.trim()) {
    throw new AdapterCatalogError('invalid-schema', 'Adapter catalog revision is required.');
  }
  const range = candidate.coreCompatibility;
  if (
    !range ||
    typeof range !== 'object' ||
    typeof range.min !== 'string' ||
    !VERSION_PATTERN.test(range.min) ||
    (range.max !== undefined && (typeof range.max !== 'string' || !VERSION_PATTERN.test(range.max)))
  ) {
    throw new AdapterCatalogError('invalid-schema', 'Adapter catalog coreCompatibility range is invalid.');
  }
  if (range.max !== undefined && compareVersions(range.min, range.max) >= 0) {
    throw new AdapterCatalogError('invalid-schema', 'Adapter catalog coreCompatibility max must exceed min.');
  }
  if (!assertDefinitions(candidate.definitions)) {
    throw new AdapterCatalogError('invalid-schema', 'Adapter catalog definitions are invalid.');
  }
  if (typeof candidate.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.sha256)) {
    throw new AdapterCatalogError('invalid-schema', 'Adapter catalog sha256 is required.');
  }
  const document = candidate as AdapterCatalogDocument;
  if (hashAdapterCatalogPayload(document) !== document.sha256.toLowerCase()) {
    throw new AdapterCatalogError('hash-mismatch', 'Adapter catalog hash verification failed.');
  }
  if (
    options.coreVersion &&
    (compareVersions(options.coreVersion, range.min) < 0 ||
      (range.max && compareVersions(options.coreVersion, range.max) >= 0))
  ) {
    throw new AdapterCatalogError(
      'incompatible-core',
      `Adapter catalog ${document.revision} is incompatible with this core.`
    );
  }
  if (options.requireSignature && document.signature === undefined) {
    throw new AdapterCatalogError('signature-required', 'Adapter catalog signature is required.');
  }
  if (
    document.signature !== undefined &&
    (!options.verifySignature || !options.verifySignature(canonicalPayload(document), document.signature))
  ) {
    throw new AdapterCatalogError('signature-invalid', 'Adapter catalog signature verification failed.');
  }
  return structuredClone(document);
};

export const adapterCatalogPayload = canonicalPayload;
