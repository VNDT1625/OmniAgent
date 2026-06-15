/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LSP wire protocol — the PURE, testable codec for Language Server Protocol
 * messages over a stdio stream.
 *
 * A language server speaks JSON-RPC 2.0 framed with HTTP-like headers:
 *
 *   Content-Length: <bytes>\r\n
 *   \r\n
 *   <utf-8 JSON body>
 *
 * This module owns ONLY the framing + a minimal request/notification builder.
 * It has no Node APIs, no child_process, no state beyond an incremental buffer —
 * so the spawn/lifecycle layer ({@link file://./lspRuntime.ts}) can stay thin and
 * this layer stays unit-testable.
 *
 *  - {@link encodeMessage}: object → framed `Buffer`-ready string bytes.
 *  - {@link LspMessageBuffer}: feed raw chunks, pull complete JSON messages.
 *  - {@link buildRequest} / {@link buildNotification}: typed JSON-RPC envelopes.
 *
 * Process boundary: Main-process module, but pure (no Node APIs used here).
 */

/** A JSON-RPC 2.0 request (expects a response keyed by `id`). */
export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
};

/** A JSON-RPC 2.0 notification (fire-and-forget; no `id`). */
export type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
};

/** A JSON-RPC 2.0 response message from the server. */
export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

/** Any inbound message: a response (has `id`) or a server-initiated message. */
export type JsonRpcInbound =
  | JsonRpcResponse
  | (JsonRpcNotification & { id?: undefined })
  | (JsonRpcRequest & { id: number });

/** The header/body separator and header line terminator. */
const HEADER_SEP = '\r\n\r\n';
const CONTENT_LENGTH = 'content-length';

/**
 * Frame a JSON-RPC message into the LSP wire format. The body is UTF-8 encoded
 * and the `Content-Length` is its BYTE length (not character length), as the
 * spec requires for non-ASCII payloads.
 */
export const encodeMessage = (message: JsonRpcRequest | JsonRpcNotification): string => {
  const body = JSON.stringify(message);
  const contentLength = Buffer.byteLength(body, 'utf-8');
  return `Content-Length: ${contentLength}\r\n\r\n${body}`;
};

/** Build a typed JSON-RPC request envelope. */
export const buildRequest = (id: number, method: string, params?: unknown): JsonRpcRequest => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

/** Build a typed JSON-RPC notification envelope. */
export const buildNotification = (method: string, params?: unknown): JsonRpcNotification => ({
  jsonrpc: '2.0',
  method,
  ...(params === undefined ? {} : { params }),
});

/**
 * Parse the header block of a framed message into a case-insensitive map.
 * Returns `null` when the block is malformed (no parseable lines).
 */
const parseHeaders = (raw: string): Map<string, string> => {
  const headers = new Map<string, string>();
  for (const line of raw.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers.set(key, value);
  }
  return headers;
};

/**
 * Incremental decoder for a stdio stream of LSP messages. The server may emit
 * partial frames, multiple frames per chunk, or split a frame across chunks —
 * this buffers raw bytes and yields whole JSON messages once their declared
 * `Content-Length` has arrived.
 *
 * Stateful but self-contained: holds only a growing `Buffer` it trims as it
 * drains. Operates on bytes (not chars) so multi-byte UTF-8 bodies are framed
 * correctly.
 */
export class LspMessageBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  /** Append a raw chunk from the server's stdout. */
  append(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  /**
   * Drain every complete message currently buffered. Returns the parsed bodies
   * in arrival order; leaves any trailing partial frame in the buffer. Bodies
   * that fail to JSON-parse are skipped (a malformed frame never wedges the
   * stream — its bytes are consumed and dropped).
   */
  drain(): JsonRpcInbound[] {
    const messages: JsonRpcInbound[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_SEP);
      if (headerEnd === -1) break;

      const headerText = this.buffer.subarray(0, headerEnd).toString('utf-8');
      const headers = parseHeaders(headerText);
      const lengthRaw = headers.get(CONTENT_LENGTH);
      const contentLength = lengthRaw === undefined ? NaN : Number.parseInt(lengthRaw, 10);

      // Missing/invalid Content-Length: drop the bad header block and resync.
      if (!Number.isFinite(contentLength) || contentLength < 0) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEP.length);
        continue;
      }

      const bodyStart = headerEnd + HEADER_SEP.length;
      const bodyEnd = bodyStart + contentLength;
      // The full body has not arrived yet — wait for more chunks.
      if (this.buffer.length < bodyEnd) break;

      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf-8');
      this.buffer = this.buffer.subarray(bodyEnd);
      try {
        messages.push(JSON.parse(body) as JsonRpcInbound);
      } catch {
        // Malformed body: bytes already consumed, skip it.
      }
    }
    return messages;
  }

  /** Number of bytes currently buffered (for tests / backpressure checks). */
  get pending(): number {
    return this.buffer.length;
  }
}

/** Type guard: an inbound message that is a response to one of our requests. */
export const isResponse = (message: JsonRpcInbound): message is JsonRpcResponse =>
  typeof (message as JsonRpcResponse).id === 'number' &&
  ((message as JsonRpcResponse).result !== undefined || (message as JsonRpcResponse).error !== undefined);

/** Type guard: an inbound server notification (e.g. publishDiagnostics). */
export const isNotification = (message: JsonRpcInbound): message is JsonRpcNotification =>
  (message as { id?: unknown }).id === undefined && typeof (message as JsonRpcNotification).method === 'string';
