/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  LspMessageBuffer,
  buildNotification,
  buildRequest,
  encodeMessage,
  isNotification,
  isResponse,
  type JsonRpcResponse,
} from '../../../../packages/desktop/src/process/ide/lang/lspProtocol';

describe('encodeMessage', () => {
  it('frames a request with a byte-length Content-Length header', () => {
    const framed = encodeMessage(buildRequest(1, 'initialize', { rootUri: 'file:///x' }));
    const [header, body] = framed.split('\r\n\r\n');
    expect(header.startsWith('Content-Length: ')).toBe(true);
    const declared = Number.parseInt(header.slice('Content-Length: '.length), 10);
    expect(declared).toBe(Buffer.byteLength(body, 'utf-8'));
    expect(JSON.parse(body)).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  });

  it('uses BYTE length (not char length) for multi-byte bodies', () => {
    const framed = encodeMessage(buildNotification('x', { text: '日本語' }));
    const [header, body] = framed.split('\r\n\r\n');
    const declared = Number.parseInt(header.slice('Content-Length: '.length), 10);
    expect(declared).toBe(Buffer.byteLength(body, 'utf-8'));
    expect(declared).toBeGreaterThan(body.length); // multi-byte → more bytes than chars
  });

  it('omits params when undefined', () => {
    const req = buildRequest(2, 'shutdown');
    expect('params' in req).toBe(false);
  });
});

describe('LspMessageBuffer', () => {
  const frame = (obj: unknown): Buffer => Buffer.from(encodeMessage(obj as never), 'utf-8');

  it('decodes a single complete message', () => {
    const buf = new LspMessageBuffer();
    buf.append(frame(buildNotification('a', { v: 1 })));
    const messages = buf.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ method: 'a', params: { v: 1 } });
    expect(buf.pending).toBe(0);
  });

  it('decodes multiple messages in one chunk, in order', () => {
    const buf = new LspMessageBuffer();
    buf.append(Buffer.concat([frame(buildNotification('first')), frame(buildNotification('second'))]));
    const messages = buf.drain();
    expect(messages.map((m) => (m as { method: string }).method)).toEqual(['first', 'second']);
  });

  it('waits for the rest of a frame split across chunks', () => {
    const buf = new LspMessageBuffer();
    const full = frame(buildNotification('split', { big: 'payload' }));
    const cut = Math.floor(full.length / 2);
    buf.append(full.subarray(0, cut));
    expect(buf.drain()).toHaveLength(0); // body not complete yet
    buf.append(full.subarray(cut));
    const messages = buf.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ method: 'split', params: { big: 'payload' } });
  });

  it('handles a header split across chunks', () => {
    const buf = new LspMessageBuffer();
    const full = frame(buildNotification('hdr'));
    buf.append(full.subarray(0, 5)); // mid-header
    expect(buf.drain()).toHaveLength(0);
    buf.append(full.subarray(5));
    expect(buf.drain()).toHaveLength(1);
  });

  it('skips a malformed body but keeps draining subsequent frames', () => {
    const buf = new LspMessageBuffer();
    const badBody = '{not json';
    const badFrame = `Content-Length: ${Buffer.byteLength(badBody, 'utf-8')}\r\n\r\n${badBody}`;
    buf.append(Buffer.from(badFrame, 'utf-8'));
    buf.append(frame(buildNotification('good')));
    const messages = buf.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ method: 'good' });
  });

  it('resyncs past a header block with no Content-Length', () => {
    const buf = new LspMessageBuffer();
    buf.append(Buffer.from('X-Bogus: 1\r\n\r\n', 'utf-8'));
    buf.append(frame(buildNotification('after')));
    const messages = buf.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ method: 'after' });
  });

  it('frames multi-byte bodies correctly across the byte boundary', () => {
    const buf = new LspMessageBuffer();
    buf.append(frame(buildNotification('jp', { text: '日本語テスト' })));
    const messages = buf.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ params: { text: '日本語テスト' } });
  });
});

describe('type guards', () => {
  it('isResponse detects a result/error keyed by id', () => {
    const ok: JsonRpcResponse = { jsonrpc: '2.0', id: 7, result: { x: 1 } };
    const err: JsonRpcResponse = { jsonrpc: '2.0', id: 8, error: { code: -1, message: 'nope' } };
    expect(isResponse(ok)).toBe(true);
    expect(isResponse(err)).toBe(true);
  });

  it('isNotification detects a method with no id', () => {
    expect(isNotification(buildNotification('textDocument/publishDiagnostics'))).toBe(true);
    expect(isNotification({ jsonrpc: '2.0', id: 1, result: {} } as never)).toBe(false);
  });
});
