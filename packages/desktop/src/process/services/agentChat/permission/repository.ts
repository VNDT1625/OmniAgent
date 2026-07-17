import { createHash } from 'node:crypto';

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PermissionStateRepository, PermissionStoreState } from './types';

type RepositoryFs = Pick<typeof fs.promises, 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'unlink'>;
type PersistedPermissionEnvelope = { schemaVersion: 1; payload: PermissionStoreState; checksum: string };

const emptyState = (): PermissionStoreState => ({ version: 1, grants: [], audit: [] });
const checksum = (state: PermissionStoreState): string =>
  createHash('sha256').update(JSON.stringify(state)).digest('hex');
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

const isState = (value: unknown): value is PermissionStoreState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<PermissionStoreState>;
  return state.version === 1 && Array.isArray(state.grants) && Array.isArray(state.audit);
};

/** In-memory repository for ephemeral runtimes and unit tests. */
export class MemoryPermissionRepository implements PermissionStateRepository {
  private state = emptyState();

  public async load(): Promise<PermissionStoreState> {
    return structuredClone(this.state);
  }

  public async save(state: PermissionStoreState): Promise<void> {
    this.state = structuredClone(state);
  }
}

/** Atomic, owner-only JSON persistence with a checksum that fails closed on tampering. */
export class JsonPermissionRepository implements PermissionStateRepository {
  public constructor(
    private readonly filePath: string,
    private readonly fsImpl: RepositoryFs = fs.promises
  ) {}

  public async load(): Promise<PermissionStoreState> {
    let text: string;
    try {
      text = await this.fsImpl.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return emptyState();
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('Permission store envelope is invalid.');
    const envelope = parsed as Partial<PersistedPermissionEnvelope>;
    if (envelope.schemaVersion !== 1 || !isState(envelope.payload) || typeof envelope.checksum !== 'string') {
      throw new Error('Permission store envelope is invalid.');
    }
    if (checksum(envelope.payload) !== envelope.checksum) {
      throw new Error('Permission store integrity check failed; refusing to load grants.');
    }
    return structuredClone(envelope.payload);
  }

  public async save(state: PermissionStoreState): Promise<void> {
    const temporary = `${this.filePath}.tmp`;
    const envelope: PersistedPermissionEnvelope = {
      schemaVersion: 1,
      payload: structuredClone(state),
      checksum: checksum(state),
    };
    await this.fsImpl.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.fsImpl.writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await this.fsImpl.rename(temporary, this.filePath);
    } catch (error) {
      await this.fsImpl.unlink(temporary).catch((): void => undefined);
      throw error;
    }
  }
}
