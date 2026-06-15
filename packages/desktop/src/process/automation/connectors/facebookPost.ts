/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Facebook Page publisher for the `action.social.facebook` workflow node.
 *
 * Publishes to a Facebook Page through the Graph API (v21.0). The node can post
 * four ways, picked automatically from its config and the incoming pipeline value:
 *  - **photo**: when `attachArtifact` is set and the previous step's artifact is
 *    an image — multipart `POST /{pageId}/photos` with the bytes as `source`.
 *  - **video**: when the artifact is a video — multipart `POST /{pageId}/videos`.
 *  - **link**: when no artifact is attached but `link` is set — `POST /{pageId}/feed`
 *    with `message` + `link`.
 *  - **text**: otherwise — `POST /{pageId}/feed` with just `message`.
 *
 * `message` supports `{{input}}` substitution so the caption can quote the
 * upstream value. The `fetch` implementation and the artifact byte reader are
 * injectable so the executor can be unit-tested without real network or
 * filesystem access.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as path from 'node:path';
import type { FacebookNodeConfig } from '../automationTypes';
import { artifactFromInput, mimeFromPath, readArtifactBytes, substituteInput } from './artifacts';

/** Graph API version + base URL all requests are built from. */
const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';

/**
 * Injectable dependencies for {@link createFacebookPublisher}. Both default to
 * real implementations (global `fetch` and the artifact byte reader) but can be
 * stubbed in tests to exercise success and failure paths offline.
 */
export type FacebookPostDeps = {
  /** HTTP client; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** File-bytes reader; defaults to {@link readArtifactBytes} from `./artifacts`. */
  readBytes?: (filePath: string) => Promise<Buffer>;
};

/** The kind of post that was published, mirroring the chosen Graph endpoint. */
export type FacebookPostKind = 'text' | 'photo' | 'video' | 'link';

/** Outcome of a publish: the created post id (when known) and the post kind. */
export type FacebookPostResult = {
  /** Graph API post id (`id`/`post_id`), or `null` when none was returned. */
  postId: string | null;
  /** Which kind of post was published. */
  kind: FacebookPostKind;
};

/** Type guard for a plain, non-null object record. */
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Validate that a required string config field is present and non-empty. */
const requireField = (value: string | undefined, label: string, nodeName: string): string => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) throw new Error(`"${nodeName}" is missing a Facebook ${label}.`);
  return trimmed;
};

/** Parse a Graph API response body as JSON, tolerating empty/non-JSON bodies. */
const parseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Surface the raw text so a non-JSON error body is not silently discarded.
    return text;
  }
};

/** Extract the created post id from a Graph success body (`id` or `post_id`). */
const extractPostId = (body: unknown): string | null => {
  if (!isRecord(body)) return null;
  if (typeof body.id === 'string' && body.id.length > 0) return body.id;
  if (typeof body.post_id === 'string' && body.post_id.length > 0) return body.post_id;
  return null;
};

/**
 * Throw a connector-friendly error for a non-2xx Graph response, preferring the
 * Graph API's own `error.message` (`{ error: { message } }`) when present and
 * always including the HTTP status.
 */
const throwGraphError = (nodeName: string, status: number, body: unknown): never => {
  let detail = '';
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    detail = body.error.message;
  } else if (typeof body === 'string' && body.length > 0) {
    detail = body;
  }
  const suffix = detail.length > 0 ? `: ${detail}` : '';
  throw new Error(`"${nodeName}" Facebook publish failed with HTTP ${status}${suffix}`);
};

/**
 * Create a `BodyInit` Blob from raw file bytes. A fresh `Uint8Array` view is used
 * so the value satisfies the `BlobPart` contract regardless of the `Buffer`'s
 * backing store.
 */
const blobFromBytes = (bytes: Buffer, mime: string): Blob => new Blob([new Uint8Array(bytes)], { type: mime });

/**
 * Create a Facebook Page publisher bound to the given (optionally stubbed)
 * dependencies.
 *
 * @param deps - Injectable `fetch` and byte-reader; both default to real impls.
 * @returns An object exposing a {@link FacebookPostResult}-returning `post`.
 */
export const createFacebookPublisher = (deps?: FacebookPostDeps) => {
  const fetchImpl: typeof fetch = deps?.fetchImpl ?? fetch;
  const readBytes = deps?.readBytes ?? readArtifactBytes;

  /** Send a request, parse the body, and map a non-2xx into a Graph error. */
  const send = async (url: string, init: RequestInit, nodeName: string): Promise<unknown> => {
    const response = await fetchImpl(url, init);
    const body = await parseJson(response);
    if (!response.ok) throwGraphError(nodeName, response.status, body);
    return body;
  };

  return {
    /**
     * Publish a post for an `action.social.facebook` node.
     *
     * @param config - The node configuration (page id, token, templated message).
     * @param input - The previous step's output; the source of `{{input}}` and of
     *   the artifact to attach when {@link FacebookNodeConfig.attachArtifact} is set.
     * @param nodeName - Human-friendly node label used in error messages.
     * @param signal - Optional abort signal forwarded to the underlying request.
     * @returns The created post id (or `null`) and the kind of post published.
     * @throws If `pageId` or `accessToken` is missing, or the Graph API rejects
     *   the request.
     */
    async post(
      config: FacebookNodeConfig,
      input: unknown,
      nodeName: string,
      signal?: AbortSignal
    ): Promise<FacebookPostResult> {
      // Fail fast with an actionable message before touching the network.
      const pageId = requireField(config.pageId, 'page id', nodeName);
      const accessToken = requireField(config.accessToken, 'access token', nodeName);
      const message = substituteInput(config.message ?? '', input);

      // 1) Media post: attach the previous step's artifact as a photo or video.
      if (config.attachArtifact) {
        const artifact = artifactFromInput(input);
        if (artifact) {
          const mime = artifact.mimeType ?? mimeFromPath(artifact.path);
          const isImage = mime.startsWith('image/');
          const isVideo = mime.startsWith('video/');
          if (isImage || isVideo) {
            const bytes = await readBytes(artifact.path);
            const filename = path.basename(artifact.path);
            const form = new FormData();
            form.append('source', blobFromBytes(bytes, mime), filename);
            form.append(isImage ? 'caption' : 'description', message);
            form.append('access_token', accessToken);

            const edge = isImage ? 'photos' : 'videos';
            const body = await send(
              `${GRAPH_API_BASE}/${encodeURIComponent(pageId)}/${edge}`,
              { method: 'POST', body: form, signal },
              nodeName
            );
            return { postId: extractPostId(body), kind: isImage ? 'photo' : 'video' };
          }
        }
      }

      // 2) Link post: share a public URL on the page feed.
      const link = typeof config.link === 'string' ? config.link.trim() : '';
      if (link.length > 0) {
        const params = new URLSearchParams({ message, link, access_token: accessToken });
        const body = await send(
          `${GRAPH_API_BASE}/${encodeURIComponent(pageId)}/feed`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString(),
            signal,
          },
          nodeName
        );
        return { postId: extractPostId(body), kind: 'link' };
      }

      // 3) Plain text post on the page feed.
      const params = new URLSearchParams({ message, access_token: accessToken });
      const body = await send(
        `${GRAPH_API_BASE}/${encodeURIComponent(pageId)}/feed`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString(),
          signal,
        },
        nodeName
      );
      return { postId: extractPostId(body), kind: 'text' };
    },
  };
};
