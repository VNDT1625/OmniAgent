import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SecretDescriptor, SecretResolveRequest } from './contextTypes';

type SecretPayload = Record<string, string>;
export type StoredSecret = SecretDescriptor & { encryptedPayload: string };
export type SecretVaultCodec = {
  available(): boolean;
  encrypt(plainText: string): string;
  decrypt(cipherText: string): string;
};
export type SecretVaultRepository = {
  list(): Promise<StoredSecret[]>;
  save(values: StoredSecret[]): Promise<void>;
};
export type SecretVault = {
  put(
    input: Omit<SecretDescriptor, 'handle' | 'createdAt' | 'updatedAt'>,
    payload: SecretPayload
  ): Promise<SecretDescriptor>;
  list(): Promise<SecretDescriptor[]>;
  resolve(request: SecretResolveRequest): Promise<SecretPayload>;
  remove(handle: string): Promise<boolean>;
};

const metadata = ({ encryptedPayload: _payload, ...descriptor }: StoredSecret): SecretDescriptor =>
  structuredClone(descriptor);
const targetAllowed = (allowed: string[] | undefined, value: string | undefined): boolean =>
  !allowed || allowed.length === 0 || (Boolean(value) && allowed.includes(value!));

/**
 * Resolves OS-encrypted values only for a bound host capability.
 * The vault must never be passed to renderer, prompt construction, event, or checkpoint code.
 */
export const createSecretVault = (
  repository: SecretVaultRepository,
  codec: SecretVaultCodec,
  newHandle: () => string = () => `secret://${randomUUID()}`,
  now: () => number = Date.now
): SecretVault => {
  const requireEncryption = (): void => {
    if (!codec.available())
      throw new Error('OS secret encryption is unavailable; refusing to persist or reveal secrets.');
  };
  return {
    async put(input, payload) {
      requireEncryption();
      const fields = [...new Set(input.fields.map((field) => field.trim()).filter(Boolean))];
      if (fields.length === 0 || fields.some((field) => typeof payload[field] !== 'string')) {
        throw new Error('Every allowed secret field must have a string value.');
      }
      if (Object.keys(payload).some((field) => !fields.includes(field))) {
        throw new Error('Secret payload contains fields outside its allowlist.');
      }
      const timestamp = now();
      if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= timestamp))
        throw new Error('Secret expiry must be in the future.');
      if (input.revokedAt !== undefined) throw new Error('A new secret cannot be revoked.');
      const stored: StoredSecret = {
        ...structuredClone(input),
        fields,
        handle: newHandle(),
        createdAt: timestamp,
        updatedAt: timestamp,
        encryptedPayload: codec.encrypt(JSON.stringify(payload)),
      };
      await repository.save([...(await repository.list()), stored]);
      return metadata(stored);
    },
    async list() {
      return (await repository.list()).map(metadata);
    },
    async resolve(request) {
      requireEncryption();
      const stored = (await repository.list()).find((item) => item.handle === request.handle);
      if (!stored) throw new Error('Unknown secret capability handle.');
      if (stored.revokedAt !== undefined) throw new Error('Secret capability has been revoked.');
      if (stored.expiresAt !== undefined && stored.expiresAt <= now())
        throw new Error('Secret capability has expired.');
      if (!stored.binding.surfaces.includes(request.surface))
        throw new Error('Secret capability is not allowed on this surface.');
      if (!stored.binding.purposes.includes(request.purpose))
        throw new Error('Secret capability is not allowed for this purpose.');
      if (!targetAllowed(stored.binding.targets, request.target))
        throw new Error('Secret capability is not allowed for this target.');
      const requestedFields = [...new Set(request.fields)];
      if (requestedFields.length === 0 || requestedFields.some((field) => !stored.fields.includes(field))) {
        throw new Error('Secret capability field is not allowed.');
      }
      const decoded: unknown = JSON.parse(codec.decrypt(stored.encryptedPayload));
      if (!decoded || typeof decoded !== 'object') throw new Error('Secret payload is corrupted.');
      const payload = decoded as SecretPayload;
      if (requestedFields.some((field) => typeof payload[field] !== 'string'))
        throw new Error('Secret payload is corrupted.');
      return Object.fromEntries(requestedFields.map((field) => [field, payload[field]]));
    },
    async remove(handle) {
      const values = await repository.list();
      const next = values.filter((item) => item.handle !== handle);
      if (next.length === values.length) return false;
      await repository.save(next);
      return true;
    },
  };
};

type RepositoryFs = Pick<typeof fs.promises, 'readFile' | 'writeFile' | 'rename' | 'mkdir'>;
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const isStoredSecret = (value: unknown): value is StoredSecret => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredSecret>;
  return typeof item.handle === 'string' && typeof item.encryptedPayload === 'string' && Array.isArray(item.fields);
};

/** Atomic 0600 persistence for encrypted records only. */
export const createFileSecretRepository = (
  filePath: string,
  fsImpl: RepositoryFs = fs.promises
): SecretVaultRepository => ({
  async list() {
    try {
      const value: unknown = JSON.parse(await fsImpl.readFile(filePath, 'utf-8'));
      return Array.isArray(value) ? value.filter(isStoredSecret) : [];
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  },
  async save(values) {
    const temporary = `${filePath}.tmp`;
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    await fsImpl.writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(temporary, filePath);
  },
});
