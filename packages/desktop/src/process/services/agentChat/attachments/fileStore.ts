/**
 * Persistent, content-addressed byte storage for transport-neutral attachments.
 *
 * Public artifacts contain only opaque store references. Absolute storage paths
 * and raw bytes never enter prompts, renderer events, or checkpoints.
 */

/* oxlint-disable no-await-in-loop, preserve-caught-error -- filesystem cleanup is serialized under the store mutex. */

import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateAttachmentEnvelope } from './validation';
import type {
  ArtifactBytePutInput,
  ArtifactCleanupResult,
  ArtifactIntegrityResult,
  ArtifactStorePutInput,
  AttachmentArtifact,
  PersistentAttachmentArtifactStore,
} from './types';

export const TOMNY_ARTIFACT_STORE_PROVIDER = 'tomny-artifact-store';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/;
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

type StoredArtifactRecord = {
  version: 1;
  artifact: AttachmentArtifact;
  owners: string[];
  expiresAt?: number;
  lastAccessedAt: number;
};

type StoreFs = Pick<typeof fs, 'mkdir' | 'readFile' | 'writeFile' | 'rename' | 'readdir' | 'unlink'>;

export type FileAttachmentArtifactStoreOptions = {
  fsImpl?: StoreFs;
  now?: () => number;
  newId?: () => string;
};

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const cloneArtifact = (artifact: AttachmentArtifact): AttachmentArtifact => structuredClone(artifact);

const assertId = (value: string, label: string): void => {
  if (!ID_RE.test(value)) throw new Error(`${label} must be a safe opaque identifier.`);
};

const assertOwner = (value: string): void => {
  if (!OWNER_RE.test(value)) throw new Error('Artifact owner must be a safe opaque identifier.');
};

const assertArtifact = (artifact: AttachmentArtifact): void => {
  const result = validateAttachmentEnvelope({
    version: 1,
    id: 'store_record',
    createdAt: artifact.createdAt,
    blocks: [{ type: 'artifact', artifact }],
  });
  if ('issues' in result) {
    throw new Error(`Stored artifact metadata is invalid: ${result.issues[0]?.message ?? 'unknown'}`);
  }
};

const parseRecord = (value: unknown): StoredArtifactRecord => {
  if (!value || typeof value !== 'object') throw new Error('Artifact record metadata is invalid.');
  const record = value as Partial<StoredArtifactRecord>;
  if (
    record.version !== 1 ||
    !record.artifact ||
    !Array.isArray(record.owners) ||
    !record.owners.every((owner) => typeof owner === 'string' && OWNER_RE.test(owner)) ||
    !Number.isSafeInteger(record.lastAccessedAt) ||
    (record.expiresAt !== undefined && !Number.isSafeInteger(record.expiresAt))
  ) {
    throw new Error('Artifact record metadata is invalid.');
  }
  assertArtifact(record.artifact);
  if (
    record.artifact.source.type !== 'opaque' ||
    record.artifact.source.provider !== TOMNY_ARTIFACT_STORE_PROVIDER ||
    record.artifact.source.ref !== record.artifact.id
  ) {
    throw new Error('Artifact record does not contain its canonical opaque reference.');
  }
  return record as StoredArtifactRecord;
};

export class FileAttachmentArtifactStore implements PersistentAttachmentArtifactStore {
  private readonly fsImpl: StoreFs;
  private readonly now: () => number;
  private readonly newId: () => string;
  private operation: Promise<void> = Promise.resolve();

  public constructor(
    private readonly root: string,
    options: FileAttachmentArtifactStoreOptions = {}
  ) {
    if (!path.isAbsolute(root)) throw new Error('Artifact store root must be absolute.');
    this.fsImpl = options.fsImpl ?? fs;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `artifact_${randomUUID()}`);
  }

  private get recordsDirectory(): string {
    return path.join(this.root, 'records');
  }

  private get blobsDirectory(): string {
    return path.join(this.root, 'blobs');
  }

  private recordPath(id: string): string {
    assertId(id, 'Artifact id');
    return path.join(this.recordsDirectory, `${id}.json`);
  }

  private blobPath(hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error('Artifact hash is invalid.');
    return path.join(this.blobsDirectory, `${hash}.bin`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      (): undefined => undefined,
      (): undefined => undefined
    );
    return result;
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      this.fsImpl.mkdir(this.recordsDirectory, { recursive: true }),
      this.fsImpl.mkdir(this.blobsDirectory, { recursive: true }),
    ]);
  }

  private async atomicWrite(filePath: string, value: Uint8Array | string): Promise<void> {
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await this.fsImpl.writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
      await this.fsImpl.rename(temporary, filePath);
    } finally {
      await this.fsImpl.unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }

  private async readRecord(id: string): Promise<StoredArtifactRecord | undefined> {
    try {
      const parsed: unknown = JSON.parse(await this.fsImpl.readFile(this.recordPath(id), 'utf8'));
      const record = parseRecord(parsed);
      if (record.artifact.id !== id) throw new Error('Artifact record id does not match its storage key.');
      return record;
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
  }

  private async writeRecord(record: StoredArtifactRecord): Promise<void> {
    await this.atomicWrite(this.recordPath(record.artifact.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  private async listEntries(directory: string): Promise<Dirent[]> {
    try {
      return await this.fsImpl.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }

  private async listRecords(): Promise<StoredArtifactRecord[]> {
    const records: StoredArtifactRecord[] = [];
    for (const entry of await this.listEntries(this.recordsDirectory)) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      try {
        const record = await this.readRecord(id);
        if (record) records.push(record);
      } catch {
        // Corrupt records are unusable and are removed by cleanup().
      }
    }
    return records;
  }

  public async putBytes(input: ArtifactBytePutInput): Promise<AttachmentArtifact> {
    return this.exclusive(async () => {
      await this.ensureDirectories();
      const id = input.id ?? this.newId();
      assertId(id, 'Artifact id');
      if (await this.readRecord(id)) throw new Error('Artifact id already exists.');
      if (!(input.bytes instanceof Uint8Array)) throw new Error('Artifact bytes must be a Uint8Array.');
      const bytes = Uint8Array.from(input.bytes);
      const hash = sha256(bytes);
      if (input.expectedSha256 !== undefined && input.expectedSha256 !== hash) {
        throw new Error('Artifact SHA-256 does not match the expected hash.');
      }
      const createdAt = input.createdAt ?? this.now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('Artifact createdAt is invalid.');
      if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= createdAt)) {
        throw new Error('Artifact expiry must be later than its creation time.');
      }
      if (input.ownerId) assertOwner(input.ownerId);
      const artifact: AttachmentArtifact = {
        id,
        kind: input.kind,
        name: input.name,
        mimeType: input.mimeType,
        sizeBytes: bytes.byteLength,
        sha256: hash,
        source: { type: 'opaque', provider: TOMNY_ARTIFACT_STORE_PROVIDER, ref: id },
        createdAt,
      };
      assertArtifact(artifact);

      const blobPath = this.blobPath(hash);
      try {
        const existing = await this.fsImpl.readFile(blobPath);
        if (existing.byteLength !== bytes.byteLength || sha256(existing) !== hash) {
          throw new Error('Existing content-addressed artifact blob failed integrity verification.');
        }
      } catch (error) {
        if (!missing(error)) throw error;
        await this.atomicWrite(blobPath, bytes);
        const persisted = await this.fsImpl.readFile(blobPath);
        if (persisted.byteLength !== bytes.byteLength || sha256(persisted) !== hash) {
          throw new Error('Artifact blob failed post-write integrity verification.');
        }
      }

      await this.writeRecord({
        version: 1,
        artifact,
        owners: input.ownerId ? [input.ownerId] : [],
        expiresAt: input.expiresAt,
        lastAccessedAt: createdAt,
      });
      return cloneArtifact(artifact);
    });
  }

  public async put(input: ArtifactStorePutInput): Promise<AttachmentArtifact> {
    if (input.source.type !== 'local-file') {
      throw new Error('Persistent byte import requires a validated local-file source.');
    }
    const bytes = await this.fsImpl.readFile(input.source.path);
    if (bytes.byteLength !== input.sizeBytes) throw new Error('Imported artifact size does not match its metadata.');
    return this.putBytes({
      id: input.id,
      kind: input.kind,
      name: input.name,
      mimeType: input.mimeType,
      bytes,
      expectedSha256: input.sha256,
      createdAt: input.createdAt,
    });
  }

  public async get(id: string): Promise<AttachmentArtifact | undefined> {
    return this.exclusive(async () => {
      const record = await this.readRecord(id);
      return record ? cloneArtifact(record.artifact) : undefined;
    });
  }

  public async readBytes(id: string): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const record = await this.readRecord(id);
      if (!record) throw new Error('Artifact was not found.');
      if (record.expiresAt !== undefined && record.expiresAt <= this.now()) {
        throw new Error('Artifact has expired.');
      }
      const bytes = await this.fsImpl.readFile(this.blobPath(record.artifact.sha256));
      if (bytes.byteLength !== record.artifact.sizeBytes)
        throw new Error('Artifact byte size failed integrity verification.');
      if (sha256(bytes) !== record.artifact.sha256) throw new Error('Artifact SHA-256 failed integrity verification.');
      record.lastAccessedAt = this.now();
      await this.writeRecord(record);
      return Uint8Array.from(bytes);
    });
  }

  public async verify(id: string): Promise<ArtifactIntegrityResult> {
    return this.exclusive(async () => {
      let record: StoredArtifactRecord | undefined;
      try {
        record = await this.readRecord(id);
      } catch {
        return { ok: false, reason: 'invalid-metadata' };
      }
      if (!record) return { ok: false, reason: 'missing' };
      if (record.expiresAt !== undefined && record.expiresAt <= this.now()) {
        return { ok: false, reason: 'expired' };
      }
      try {
        const bytes = await this.fsImpl.readFile(this.blobPath(record.artifact.sha256));
        if (bytes.byteLength !== record.artifact.sizeBytes) return { ok: false, reason: 'size-mismatch' };
        if (sha256(bytes) !== record.artifact.sha256) return { ok: false, reason: 'hash-mismatch' };
        return { ok: true, artifact: cloneArtifact(record.artifact) };
      } catch (error) {
        if (missing(error)) return { ok: false, reason: 'missing' };
        throw error;
      }
    });
  }

  public async retain(id: string, ownerId: string): Promise<void> {
    await this.exclusive(async () => {
      assertOwner(ownerId);
      const record = await this.readRecord(id);
      if (!record) throw new Error('Artifact was not found.');
      if (record.expiresAt !== undefined && record.expiresAt <= this.now()) throw new Error('Artifact has expired.');
      if (!record.owners.includes(ownerId)) {
        record.owners.push(ownerId);
        await this.writeRecord(record);
      }
    });
  }

  public async releaseOwner(ownerId: string, deleteUnreferenced = true): Promise<number> {
    return this.exclusive(async () => {
      assertOwner(ownerId);
      let removed = 0;
      for (const record of await this.listRecords()) {
        if (!record.owners.includes(ownerId)) continue;
        record.owners = record.owners.filter((owner) => owner !== ownerId);
        if (deleteUnreferenced && record.owners.length === 0) {
          await this.fsImpl.unlink(this.recordPath(record.artifact.id));
          removed += 1;
        } else {
          await this.writeRecord(record);
        }
      }
      if (removed > 0) await this.collectUnreferencedBlobs();
      return removed;
    });
  }

  private async collectUnreferencedBlobs(): Promise<number> {
    const referenced = new Set((await this.listRecords()).map((record) => record.artifact.sha256));
    let removed = 0;
    for (const entry of await this.listEntries(this.blobsDirectory)) {
      if (!entry.isFile() || !entry.name.endsWith('.bin')) continue;
      const hash = entry.name.slice(0, -4);
      if (HASH_RE.test(hash) && referenced.has(hash)) continue;
      await this.fsImpl.unlink(path.join(this.blobsDirectory, entry.name));
      removed += 1;
    }
    return removed;
  }

  public async remove(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const record = await this.readRecord(id);
      if (!record) return false;
      await this.fsImpl.unlink(this.recordPath(id));
      await this.collectUnreferencedBlobs();
      return true;
    });
  }

  public async cleanup(now = this.now()): Promise<ArtifactCleanupResult> {
    return this.exclusive(async () => {
      await this.ensureDirectories();
      let removedArtifacts = 0;
      let invalidRecords = 0;
      let removedTemporaryFiles = 0;
      for (const entry of await this.listEntries(this.recordsDirectory)) {
        const filePath = path.join(this.recordsDirectory, entry.name);
        if (!entry.isFile()) continue;
        if (entry.name.endsWith('.tmp')) {
          await this.fsImpl.unlink(filePath);
          removedTemporaryFiles += 1;
          continue;
        }
        if (!entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        try {
          if (!ID_RE.test(id)) throw new Error('invalid id');
          const record = await this.readRecord(id);
          if (!record) continue;
          if (record.expiresAt !== undefined && record.expiresAt <= now) {
            await this.fsImpl.unlink(filePath);
            removedArtifacts += 1;
          }
        } catch {
          await this.fsImpl.unlink(filePath);
          invalidRecords += 1;
        }
      }
      for (const entry of await this.listEntries(this.blobsDirectory)) {
        if (entry.isFile() && entry.name.endsWith('.tmp')) {
          await this.fsImpl.unlink(path.join(this.blobsDirectory, entry.name));
          removedTemporaryFiles += 1;
        }
      }
      const removedBlobs = await this.collectUnreferencedBlobs();
      return { removedArtifacts, removedBlobs, removedTemporaryFiles, invalidRecords };
    });
  }
}

export const createFileAttachmentArtifactStore = (
  root: string,
  options?: FileAttachmentArtifactStoreOptions
): PersistentAttachmentArtifactStore => new FileAttachmentArtifactStore(root, options);
