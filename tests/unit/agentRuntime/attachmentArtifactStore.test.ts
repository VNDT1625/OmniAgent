import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileAttachmentArtifactStore,
  type FileAttachmentArtifactStore,
} from '@process/services/agentChat/attachments';

const directories: string[] = [];
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

const createStore = async (
  options: { now?: () => number; newId?: () => string } = {}
): Promise<{ root: string; store: FileAttachmentArtifactStore }> => {
  const root = await mkdtemp(path.join(tmpdir(), 'tomny-artifacts-'));
  directories.push(root);
  return { root, store: createFileAttachmentArtifactStore(root, options) as FileAttachmentArtifactStore };
};

const putText = (
  store: FileAttachmentArtifactStore,
  value = 'hello',
  overrides: Partial<Parameters<FileAttachmentArtifactStore['putBytes']>[0]> = {}
) =>
  store.putBytes({
    id: 'artifact_text_1',
    kind: 'text',
    name: 'note.txt',
    mimeType: 'text/plain',
    bytes: bytes(value),
    createdAt: 10,
    ...overrides,
  });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('persistent attachment artifact byte store', () => {
  it('persists bytes behind an opaque reference and reopens them without exposing a path', async () => {
    const { root, store } = await createStore();
    const artifact = await putText(store);

    expect(artifact.source).toEqual({
      type: 'opaque',
      provider: 'tomny-artifact-store',
      ref: 'artifact_text_1',
    });
    expect(JSON.stringify(artifact)).not.toContain(root);

    const reopened = createFileAttachmentArtifactStore(root);
    await expect(reopened.readBytes(artifact.id)).resolves.toEqual(bytes('hello'));
    await expect(reopened.verify(artifact.id)).resolves.toMatchObject({ ok: true });
  });

  it('rehashes input bytes and rejects a caller-provided hash mismatch before persistence', async () => {
    const { store } = await createStore();

    await expect(putText(store, 'hello', { expectedSha256: '0'.repeat(64) })).rejects.toThrow(/SHA-256/u);
    await expect(store.get('artifact_text_1')).resolves.toBeUndefined();
  });

  it('detects blob tampering on both integrity checks and reads', async () => {
    const { root, store } = await createStore();
    const artifact = await putText(store);
    await writeFile(path.join(root, 'blobs', `${artifact.sha256}.bin`), bytes('jello'));

    await expect(store.verify(artifact.id)).resolves.toEqual({ ok: false, reason: 'hash-mismatch' });
    await expect(store.readBytes(artifact.id)).rejects.toThrow(/SHA-256/u);
  });

  it('rejects metadata whose opaque id no longer matches its storage key', async () => {
    const { root, store } = await createStore();
    await putText(store);
    const recordPath = path.join(root, 'records', 'artifact_text_1.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as {
      artifact: { id: string; source: { ref: string } };
    };
    record.artifact.id = 'artifact_swapped';
    record.artifact.source.ref = 'artifact_swapped';
    await writeFile(recordPath, JSON.stringify(record));

    await expect(store.verify('artifact_text_1')).resolves.toEqual({ ok: false, reason: 'invalid-metadata' });
  });

  it('deduplicates identical content and deletes a blob only after its last record is removed', async () => {
    const { root, store } = await createStore();
    const first = await putText(store);
    await putText(store, 'hello', { id: 'artifact_text_2' });

    expect(await readdir(path.join(root, 'blobs'))).toHaveLength(1);
    await store.remove(first.id);
    expect(await readdir(path.join(root, 'blobs'))).toHaveLength(1);
    await store.remove('artifact_text_2');
    expect(await readdir(path.join(root, 'blobs'))).toHaveLength(0);
  });

  it('retains shared ownership and removes unreferenced artifacts when the final owner releases them', async () => {
    const { store } = await createStore();
    await putText(store, 'hello', { ownerId: 'session_one' });
    await store.retain('artifact_text_1', 'session_two');

    await expect(store.releaseOwner('session_one')).resolves.toBe(0);
    await expect(store.get('artifact_text_1')).resolves.toBeDefined();
    await expect(store.releaseOwner('session_two')).resolves.toBe(1);
    await expect(store.get('artifact_text_1')).resolves.toBeUndefined();
  });

  it('cleans expired records, their orphaned blobs, temporary files and malformed metadata', async () => {
    let now = 10;
    const { root, store } = await createStore({ now: () => now });
    await putText(store, 'expires', { expiresAt: 20 });
    await mkdir(path.join(root, 'records'), { recursive: true });
    await writeFile(path.join(root, 'records', 'bad.json'), '{broken');
    await writeFile(path.join(root, 'records', 'abandoned.tmp'), 'temporary');
    await writeFile(path.join(root, 'blobs', `${'f'.repeat(64)}.bin`), 'orphan');
    now = 21;

    const result = await store.cleanup();

    expect(result).toMatchObject({
      removedArtifacts: 1,
      invalidRecords: 1,
      removedTemporaryFiles: 1,
      removedBlobs: 2,
    });
    await expect(store.verify('artifact_text_1')).resolves.toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects reads after expiry even before cleanup runs', async () => {
    let now = 10;
    const { store } = await createStore({ now: () => now });
    await putText(store, 'expires', { expiresAt: 20 });
    now = 20;

    await expect(store.verify('artifact_text_1')).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(store.readBytes('artifact_text_1')).rejects.toThrow(/expired/u);
  });

  it('imports a validated local source only when declared size and hash match actual bytes', async () => {
    const { root, store } = await createStore();
    const source = path.join(root, 'source.txt');
    const value = bytes('from file');
    await writeFile(source, value);

    const artifact = await store.put({
      id: 'artifact_import_1',
      kind: 'text',
      name: 'source.txt',
      mimeType: 'text/plain',
      sizeBytes: value.byteLength,
      sha256: hash(value),
      source: { type: 'local-file', path: source },
    });

    expect(artifact.source.type).toBe('opaque');
    await expect(store.readBytes(artifact.id)).resolves.toEqual(value);
  });

  it('serializes concurrent writes so metadata and shared blobs remain complete', async () => {
    const { root, store } = await createStore();

    await Promise.all([
      putText(store, 'same', { id: 'artifact_parallel_1' }),
      putText(store, 'same', { id: 'artifact_parallel_2' }),
      putText(store, 'different', { id: 'artifact_parallel_3' }),
    ]);

    expect(await readdir(path.join(root, 'records'))).toHaveLength(3);
    expect(await readdir(path.join(root, 'blobs'))).toHaveLength(2);
    expect(await readFile(path.join(root, 'blobs', `${hash(bytes('same'))}.bin`))).toEqual(Buffer.from('same'));
  });
});
