/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TikTok publisher connector for the `action.social.tiktok` workflow node.
 *
 * Uploads the video the previous step produced (or an explicit `videoPath`) to
 * TikTok via the Content Posting API using a **direct post** with the
 * `FILE_UPLOAD` source. The flow is a two-step handshake:
 *
 *  1. `POST /post/publish/video/init/` — declare the post metadata and the file
 *     size; TikTok returns a `publish_id` and a presigned `upload_url`.
 *  2. `PUT {upload_url}` — stream the raw video bytes in a single chunk
 *     (`total_chunk_count = 1`) with the matching `Content-Range` header.
 *
 * Privacy defaults to `SELF_ONLY`, the safest level while an app is still
 * pending TikTok's content-posting audit (public posting is rejected until the
 * app is approved).
 *
 * The `fetch` implementation, the byte reader, and the file-size probe are all
 * injectable so the executor can be unit-tested without real network or
 * filesystem access.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import type { TiktokNodeConfig } from '../automationTypes';
import { mimeFromPath, readArtifactBytes, resolveSourcePath, substituteInput } from './artifacts';

/** Base URL for the TikTok Content Posting API (v2). */
const TIKTOK_API_BASE = 'https://open.tiktokapis.com/v2';

/** Endpoint that initialises a direct-post video upload. */
const INIT_ENDPOINT = `${TIKTOK_API_BASE}/post/publish/video/init/`;

/** Privacy level applied when the node config omits one (safest default). */
const DEFAULT_PRIVACY = 'SELF_ONLY';

/**
 * Injectable dependencies for {@link createTiktokPublisher}. Each defaults to a
 * production implementation but can be stubbed in tests to exercise the success
 * and failure paths offline.
 */
export type TiktokPostDeps = {
  /** HTTP client; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** File-bytes reader; defaults to {@link readArtifactBytes} from `./artifacts`. */
  readBytes?: (filePath: string) => Promise<Buffer>;
  /** File-size probe (bytes); defaults to `fs.promises.stat().size`. */
  stat?: (filePath: string) => Promise<number>;
};

/** Outcome of a publish: the `publish_id` TikTok assigned, or `null`. */
export type TiktokPostResult = {
  /** TikTok publish id used to poll post status, or `null` when not returned. */
  publishId: string | null;
};

/** Shape of the TikTok error object that wraps every Content Posting response. */
type TiktokError = {
  code?: string;
  message?: string;
};

/** Relevant fields of a successful init response payload. */
type TiktokInitData = {
  publish_id?: string;
  upload_url?: string;
};

/** Envelope returned by the init endpoint. */
type TiktokInitResponse = {
  data?: TiktokInitData;
  error?: TiktokError;
};

/** Default file-size probe: read `.size` from a `node:fs` stat. */
const defaultStat = async (filePath: string): Promise<number> => (await fs.promises.stat(filePath)).size;

/** Type guard for the loosely-typed JSON the init endpoint returns. */
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Read up to the first 300 chars of an error response body (best-effort). */
const readErrorSnippet = async (response: Response): Promise<string> => {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
};

/**
 * Create a TikTok publisher bound to the given (optionally stubbed) deps.
 *
 * @param deps - Injectable `fetch`, byte-reader, and size-probe; all default to
 *   real implementations.
 * @returns An object exposing a {@link TiktokPostResult}-returning `post`.
 */
export const createTiktokPublisher = (deps?: TiktokPostDeps) => {
  const fetchImpl: typeof fetch = deps?.fetchImpl ?? fetch;
  const readBytes = deps?.readBytes ?? readArtifactBytes;
  const stat = deps?.stat ?? defaultStat;

  return {
    /**
     * Publish the resolved video to TikTok as a direct post.
     *
     * @param config - The `action.social.tiktok` node configuration.
     * @param input - The previous node's output (used to locate the video and to
     *   substitute `{{input}}` in the caption).
     * @param nodeName - Human-friendly node label for error messages.
     * @param signal - Optional abort signal forwarded to both HTTP requests.
     * @returns The TikTok `publish_id` (or `null`).
     * @throws If `accessToken` is missing, the video cannot be located, or either
     *   HTTP request fails.
     */
    async post(
      config: TiktokNodeConfig,
      input: unknown,
      nodeName: string,
      signal?: AbortSignal
    ): Promise<TiktokPostResult> {
      const accessToken = config.accessToken?.trim() ?? '';
      // Fail fast with an actionable message before touching the network.
      if (accessToken.length === 0) {
        throw new Error(`"${nodeName}" is missing a TikTok access token.`);
      }

      // `resolveSourcePath` throws a clear error when no video is available.
      const sourcePath = resolveSourcePath(config.videoPath, input, nodeName);
      const caption = substituteInput(config.caption ?? '', input);
      const privacy = config.privacy ?? DEFAULT_PRIVACY;

      // Single-chunk upload: the whole file is one chunk.
      const videoSize = await stat(sourcePath);

      // Step 1 — initialise the direct post and obtain the presigned upload URL.
      const initResponse = await fetchImpl(INIT_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          post_info: {
            title: caption,
            privacy_level: privacy,
          },
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: videoSize,
            chunk_size: videoSize,
            total_chunk_count: 1,
          },
        }),
        signal,
      });

      const payload: unknown = await initResponse.json().catch((): null => null);
      const parsed: TiktokInitResponse = isObject(payload) ? (payload as TiktokInitResponse) : {};
      const error = parsed.error;

      // TikTok always returns an `error` object; `code === 'ok'` means success.
      if (!initResponse.ok || (typeof error?.code === 'string' && error.code !== 'ok')) {
        const message =
          error?.message && error.message.length > 0 ? error.message : await readErrorSnippet(initResponse);
        throw new Error(`"${nodeName}" TikTok init failed with HTTP ${initResponse.status}: ${message}`);
      }

      const uploadUrl = parsed.data?.upload_url ?? '';
      if (uploadUrl.length === 0) {
        throw new Error(`"${nodeName}" TikTok init did not return an upload URL.`);
      }

      // Step 2 — upload the raw video bytes in a single chunk.
      const bytes = await readBytes(sourcePath);
      // Copy into a fresh ArrayBuffer-backed view so the value satisfies the DOM
      // `BodyInit` contract (a `Buffer`'s backing store is typed `ArrayBufferLike`).
      const body: BodyInit = new Uint8Array(bytes);
      const contentType = mimeFromPath(sourcePath).startsWith('video/') ? mimeFromPath(sourcePath) : 'video/mp4';

      const uploadResponse = await fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
        },
        body,
        signal,
      });

      if (!uploadResponse.ok) {
        const snippet = await readErrorSnippet(uploadResponse);
        throw new Error(`"${nodeName}" TikTok upload failed with HTTP ${uploadResponse.status}: ${snippet}`);
      }

      return { publishId: parsed.data?.publish_id ?? null };
    },
  };
};
