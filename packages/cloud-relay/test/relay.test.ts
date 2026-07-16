import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const TOKEN = '0123456789abcdef'.repeat(4);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const CLIENT = 'client-a';
const url = (suffix: string): string => `https://relay.test/v1/workspaces/${WORKSPACE}${suffix}`;
const auth = (token = TOKEN): Record<string, string> => ({ authorization: `Bearer ${token}` });
const jsonHeaders = (): Record<string, string> => ({ ...auth(), 'content-type': 'application/json' });

const hash = async (content: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const putBlob = async (content: string): Promise<string> => {
  const blobHash = await hash(content);
  const response = await SELF.fetch(url(`/blobs/${blobHash}`), {
    method: 'PUT',
    headers: { ...auth(), 'content-type': 'text/plain' },
    body: content,
  });
  expect(response.status).toBe(200);
  return blobHash;
};

const claim = async (path: string, clientId = CLIENT): Promise<{ ok: boolean }> =>
  (
    await SELF.fetch(url('/leases'), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ relPath: path, clientId, name: clientId }),
    })
  ).json();

const append = async (id: string, path: string, blobHash: string): Promise<Response> =>
  SELF.fetch(url('/ops'), {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({
      id,
      workspaceId: WORKSPACE,
      clientId: CLIENT,
      protocolVersion: 2,
      baseSeq: 0,
      baseHash: null,
      createdAt: Date.now(),
      type: 'file.write',
      path,
      hash: blobHash,
      size: 5,
      encoding: 'utf8',
    }),
  });

describe('cloud workspace relay', () => {
  it('pins a strong workspace token and mints a one-time socket ticket', async () => {
    expect((await SELF.fetch(url('/manifest'), { headers: auth() })).status).toBe(200);
    const wrong = await SELF.fetch(url('/manifest'), { headers: auth('f'.repeat(64)) });
    expect(wrong.status).toBe(400);
    const leakedQueryToken = await SELF.fetch(`${url('/manifest')}?token=${TOKEN}`);
    expect(leakedQueryToken.status).toBe(400);

    const ticketResponse = await SELF.fetch(url('/tickets'), { method: 'POST', headers: auth() });
    const { ticket } = await ticketResponse.json<{ ticket: string }>();
    const connectUrl = `${url('/connect')}?ticket=${ticket}&clientId=${CLIENT}`;
    expect(connectUrl).not.toContain(TOKEN);
    const connected = await SELF.fetch(connectUrl, { headers: { Upgrade: 'websocket' } });
    expect(connected.status).toBe(101);
    connected.webSocket?.accept();
    expect((await SELF.fetch(connectUrl, { headers: { Upgrade: 'websocket' } })).status).toBe(400);
  });

  it('serializes concurrent file operations, enforces leases and deduplicates retries', async () => {
    await SELF.fetch(url('/manifest'), { headers: auth() });
    const [hashA, hashB] = await Promise.all([putBlob('alpha'), putBlob('bravo')]);
    expect((await Promise.all([claim('a.txt'), claim('b.txt')])).map(({ ok }) => ok)).toEqual([true, true]);

    const [responseA, responseB] = await Promise.all([append('op-a', 'a.txt', hashA), append('op-b', 'b.txt', hashB)]);
    const accepted = await Promise.all([responseA.json<{ seq: number }>(), responseB.json<{ seq: number }>()]);
    expect(accepted.map(({ seq }) => seq).toSorted()).toEqual([1, 2]);
    expect((await (await append('op-a', 'a.txt', hashA)).json<{ seq: number }>()).seq).toBe(accepted[0].seq);
    expect((await claim('a.txt', 'client-b')).ok).toBe(false);
    const staleHash = await putBlob('stale');
    const stale = await append('op-stale', 'a.txt', staleHash);
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain('base hash mismatch');

    const status = await (
      await SELF.fetch(url('/status'), { headers: auth() })
    ).json<{
      manifest: { seq: number; files: Record<string, { hash: string }> };
    }>();
    expect(status.manifest.seq).toBe(2);
    expect(status.manifest.files['a.txt'].hash).toBe(hashA);
    expect(status.manifest.files['b.txt'].hash).toBe(hashB);
  });

  it('rejects content that does not match its blob address', async () => {
    await SELF.fetch(url('/manifest'), { headers: auth() });
    const response = await SELF.fetch(url(`/blobs/${'a'.repeat(64)}`), {
      method: 'PUT',
      headers: { ...auth(), 'content-type': 'text/plain' },
      body: 'tampered',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('blob hash mismatch');
  });
});
