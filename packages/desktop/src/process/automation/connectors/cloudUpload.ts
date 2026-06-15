/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cloud-storage upload connector for the `action.cloud.upload` workflow node.
 *
 * Persists an artifact (the file the previous step produced, or an explicit
 * `sourcePath`) to a remote bucket / WebDAV share and returns a public or
 * shareable URL so downstream social/email nodes can reference it.
 *
 * Two backends are supported via {@link CloudProviderKind}:
 *  - **s3**: any S3-compatible endpoint (AWS S3, Cloudflare R2, MinIO…). Requests
 *    are signed with AWS Signature V4 using only `node:crypto` — no `aws-sdk`,
 *    no extra dependency. Path-style addressing (`${endpoint}/${bucket}/${key}`).
 *  - **webdav**: Nextcloud / generic WebDAV via `PUT` with HTTP Basic auth.
 *
 * The `fetch` implementation and the byte reader are injectable so the executor
 * can be unit-tested without real network or filesystem access.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { createHash, createHmac } from 'node:crypto';
import * as path from 'node:path';
import type { CloudUploadNodeConfig } from '../automationTypes';
import { mimeFromPath, readArtifactBytes, resolveSourcePath, substituteInput } from './artifacts';

/**
 * Injectable dependencies for {@link createCloudUploader}. Both default to real
 * implementations (global `fetch` and the artifact byte reader) but can be
 * stubbed in tests to exercise success and failure paths offline.
 */
export type CloudUploadDeps = {
  /** HTTP client; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** File-bytes reader; defaults to {@link readArtifactBytes} from `./artifacts`. */
  readBytes?: (filePath: string) => Promise<Buffer>;
};

/** Outcome of an upload: the hosted URL (when known), the object key, and provider. */
export type CloudUploadResult = {
  /** Public / shareable URL, or `null` when the object is not publicly readable. */
  url: string | null;
  /** The destination object key / remote path that was written. */
  key: string;
  /** Which backend handled the upload (`'s3'` | `'webdav'`). */
  provider: string;
};

/** AWS SigV4 constants — kept here so the signer stays dependency-free. */
const AWS_ALGORITHM = 'AWS4-HMAC-SHA256';
const AWS_REQUEST = 'aws4_request';
const S3_SERVICE = 's3';
const DEFAULT_REGION = 'us-east-1';

/** Hex SHA-256 of a string or buffer. */
const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** HMAC-SHA256 returning the raw digest, so signing keys can be chained. */
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * RFC 3986 percent-encoding as required by AWS SigV4 (encodes everything except
 * the unreserved set `A-Za-z0-9-._~`). `encodeURIComponent` leaves `!'()*`
 * unescaped, so fix those up explicitly.
 */
const rfc3986Encode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Encode an object key as a URI path: encode each segment but preserve `/`. */
const encodeKeyPath = (key: string): string =>
  key
    .split('/')
    .map((segment) => rfc3986Encode(segment))
    .join('/');

/** Produce the `YYYYMMDDTHHMMSSZ` and `YYYYMMDD` stamps SigV4 expects. */
const amzDateStamps = (now: Date): { amzDate: string; dateStamp: string } => {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
};

/** Remove any trailing slashes so URL joins never produce a double slash. */
const stripTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

/** Read up to the first 300 chars of an error response body (best-effort). */
const readErrorSnippet = async (response: Response): Promise<string> => {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
};

/** Throw a connector-friendly error describing a non-2xx HTTP response. */
const throwHttpError = async (provider: string, response: Response): Promise<never> => {
  const snippet = await readErrorSnippet(response);
  throw new Error(`${provider} upload failed with HTTP ${response.status}: ${snippet}`);
};

/** Resolve the destination key/path: substituted `destination`, else basename. */
const resolveKey = (config: CloudUploadNodeConfig, sourcePath: string, input: unknown): string => {
  const raw = typeof config.destination === 'string' ? config.destination.trim() : '';
  const substituted = raw.length > 0 ? substituteInput(raw, input).trim() : '';
  const key = substituted.length > 0 ? substituted : path.basename(sourcePath);
  return key.replace(/^\/+/, '');
};

/** Inputs shared by the S3 signer. */
type S3SignedRequest = {
  url: string;
  headers: Record<string, string>;
};

/**
 * Build the signed PUT URL + headers for an S3-compatible object upload. The
 * request uses path-style addressing and signs `content-type`, `host`,
 * `x-amz-content-sha256`, `x-amz-date`, and (when public) `x-amz-acl`.
 */
const signS3Put = (params: {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  key: string;
  contentType: string;
  publicRead: boolean;
  bodyHash: string;
  now: Date;
}): S3SignedRequest => {
  const { endpoint, region, bucket, accessKeyId, secretAccessKey, key, contentType, publicRead, bodyHash, now } =
    params;

  const base = new URL(stripTrailingSlash(endpoint));
  const host = base.host;
  const basePath = stripTrailingSlash(base.pathname);
  const canonicalUri = `${basePath}/${rfc3986Encode(bucket)}/${encodeKeyPath(key)}`;
  const requestUrl = `${base.protocol}//${host}${canonicalUri}`;

  const { amzDate, dateStamp } = amzDateStamps(now);

  // Headers that participate in the signature (sorted by lowercase name below).
  const signedHeaderValues: Record<string, string> = {
    'content-type': contentType,
    host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate,
  };
  if (publicRead) signedHeaderValues['x-amz-acl'] = 'public-read';

  const sortedNames = Object.keys(signedHeaderValues).toSorted();
  const canonicalHeaders = sortedNames.map((name) => `${name}:${signedHeaderValues[name].trim()}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = ['PUT', canonicalUri, '', canonicalHeaders, signedHeaders, bodyHash].join('\n');

  const scope = `${dateStamp}/${region}/${S3_SERVICE}/${AWS_REQUEST}`;
  const stringToSign = [AWS_ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, S3_SERVICE);
  const kSigning = hmac(kService, AWS_REQUEST);
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `${AWS_ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // `host` is set automatically by fetch from the URL, so it is signed but not
  // sent here (sending it manually can be rejected by the runtime).
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date': amzDate,
    Authorization: authorization,
  };
  if (publicRead) headers['x-amz-acl'] = 'public-read';

  return { url: requestUrl, headers };
};

/** Validate that a required string config field is present and non-empty. */
const requireField = (value: string | undefined, label: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) throw new Error(`Cloud upload is missing "${label}".`);
  return trimmed;
};

/**
 * Create a cloud uploader bound to the given (optionally stubbed) dependencies.
 *
 * @param deps - Injectable `fetch` and byte-reader; both default to real impls.
 * @returns An object exposing {@link CloudUploadResult}-returning `upload`.
 */
export const createCloudUploader = (deps?: CloudUploadDeps) => {
  const fetchImpl: typeof fetch = deps?.fetchImpl ?? fetch;
  const readBytes = deps?.readBytes ?? readArtifactBytes;

  return {
    /**
     * Upload the resolved artifact to the configured backend.
     *
     * @param config - The `action.cloud.upload` node configuration.
     * @param input - The previous node's output (used to locate the artifact and
     *   to substitute `{{input}}` in the destination).
     * @param nodeName - Human-friendly node label for error messages.
     * @param signal - Optional abort signal forwarded to the underlying request.
     * @returns The hosted URL (or `null`), object key, and provider name.
     */
    async upload(
      config: CloudUploadNodeConfig,
      input: unknown,
      nodeName: string,
      signal?: AbortSignal
    ): Promise<CloudUploadResult> {
      const sourcePath = resolveSourcePath(config.sourcePath, input, nodeName);
      const key = resolveKey(config, sourcePath, input);
      const contentType = mimeFromPath(sourcePath);
      const bytes = await readBytes(sourcePath);
      // Copy into a fresh ArrayBuffer-backed view so the value satisfies the DOM
      // `BodyInit` contract (a `Buffer`'s backing store is typed `ArrayBufferLike`).
      const body: BodyInit = new Uint8Array(bytes);

      if (config.provider === 's3') {
        const endpoint = requireField(config.endpoint, 'endpoint');
        const bucket = requireField(config.bucket, 'bucket');
        const accessKeyId = requireField(config.accessKeyId, 'accessKeyId');
        const secretAccessKey = requireField(config.secretAccessKey, 'secretAccessKey');
        const region =
          typeof config.region === 'string' && config.region.trim().length > 0 ? config.region.trim() : DEFAULT_REGION;
        const publicRead = config.publicRead === true;

        const signed = signS3Put({
          endpoint,
          region,
          bucket,
          accessKeyId,
          secretAccessKey,
          key,
          contentType,
          publicRead,
          bodyHash: sha256Hex(bytes),
          now: new Date(),
        });

        const response = await fetchImpl(signed.url, { method: 'PUT', headers: signed.headers, body, signal });
        if (!response.ok) await throwHttpError('S3', response);

        return { url: publicRead ? signed.url : null, key, provider: 's3' };
      }

      // WebDAV (Nextcloud / generic)
      const baseUrl = requireField(config.baseUrl, 'baseUrl');
      const remotePath = key.replace(/^\/+/, '');
      const requestUrl = `${stripTrailingSlash(baseUrl)}/${encodeKeyPath(remotePath)}`;

      const headers: Record<string, string> = { 'Content-Type': contentType };
      const username = typeof config.username === 'string' ? config.username : '';
      const password = typeof config.password === 'string' ? config.password : '';
      if (username.length > 0 || password.length > 0) {
        headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
      }

      const response = await fetchImpl(requestUrl, { method: 'PUT', headers, body, signal });
      if (!response.ok) await throwHttpError('WebDAV', response);

      return { url: requestUrl, key: remotePath, provider: 'webdav' };
    },
  };
};
