/** Main-process provider store with OS-encrypted secrets and atomic writes. */
import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IProvider } from '@/common/config/storage';
import type { CreateProviderRequest, UpdateProviderRequest } from '@/common/types/provider/providerApi';

const PROVIDERS_FILE = 'tomny-providers.json';
type ProviderSecrets = { apiKey: string; bedrockSecretAccessKey?: string };
type StoredProvider = Omit<IProvider, 'api_key' | 'bedrock_config'> & {
  bedrock_config?: Omit<NonNullable<IProvider['bedrock_config']>, 'secret_access_key'>;
  encryptedSecrets: string;
  osEncrypted: boolean;
};
export type ProviderFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};
export type ProviderCrypto = {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(base64: string, osEncrypted: boolean): string;
};
export type ProviderStoreOptions = { dir?: string; fs?: ProviderFs; crypto?: ProviderCrypto; newId?: () => string };
export type IProviderStore = {
  list(): Promise<IProvider[]>;
  get(id: string): Promise<IProvider | undefined>;
  create(input: CreateProviderRequest): Promise<IProvider>;
  update(id: string, input: UpdateProviderRequest): Promise<IProvider>;
  remove(id: string): Promise<void>;
};
const defaultFs: ProviderFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};
const defaultCrypto: ProviderCrypto = {
  isAvailable: () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt: (plain) => {
    try {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString('base64');
    } catch {
      /* Fall through when the OS keychain is unavailable. */
    }
    return Buffer.from(plain, 'utf-8').toString('base64');
  },
  decrypt: (base64, osEncrypted) => {
    const bytes = Buffer.from(base64, 'base64');
    return osEncrypted ? safeStorage.decryptString(bytes) : bytes.toString('utf-8');
  },
};
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const isStoredProvider = (value: unknown): value is StoredProvider =>
  isObject(value) &&
  typeof value.id === 'string' &&
  typeof value.platform === 'string' &&
  typeof value.encryptedSecrets === 'string' &&
  typeof value.osEncrypted === 'boolean';
const normalizeCreate = (input: CreateProviderRequest, id: string): IProvider => ({
  id,
  platform: input.platform.trim(),
  name: input.name.trim(),
  base_url: input.base_url.trim(),
  api_key: input.api_key,
  models: input.models ?? [],
  capabilities: input.capabilities,
  context_limit: input.context_limit,
  model_protocols: input.model_protocols,
  bedrock_config: input.bedrock_config,
  enabled: input.enabled ?? true,
  model_enabled: input.model_enabled,
  model_health: input.model_health,
  is_full_url: input.is_full_url,
});
/** Create the independent provider store used by both Settings and Tomny CLI. */
export const createProviderStore = (options: ProviderStoreOptions = {}): IProviderStore => {
  const fsImpl = options.fs ?? defaultFs;
  const crypto = options.crypto ?? defaultCrypto;
  const newId = options.newId ?? randomUUID;
  const dir = options.dir ?? app.getPath('userData');
  const filePath = path.join(dir, PROVIDERS_FILE);
  let cache: StoredProvider[] = [];
  let loaded = false;
  const decode = (stored: StoredProvider): IProvider => {
    let secrets: ProviderSecrets = { apiKey: '' };
    try {
      const value = JSON.parse(crypto.decrypt(stored.encryptedSecrets, stored.osEncrypted)) as unknown;
      if (isObject(value)) {
        secrets = {
          apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
          bedrockSecretAccessKey:
            typeof value.bedrockSecretAccessKey === 'string' ? value.bedrockSecretAccessKey : undefined,
        };
      }
    } catch {
      /* Corrupted secrets do not hide non-secret metadata. */
    }
    const bedrock_config = stored.bedrock_config
      ? { ...stored.bedrock_config, secret_access_key: secrets.bedrockSecretAccessKey }
      : undefined;
    const { encryptedSecrets: _encryptedSecrets, osEncrypted: _osEncrypted, ...provider } = stored;
    return { ...provider, api_key: secrets.apiKey, bedrock_config };
  };
  const encode = (provider: IProvider): StoredProvider => {
    const secrets: ProviderSecrets = {
      apiKey: provider.api_key,
      bedrockSecretAccessKey: provider.bedrock_config?.secret_access_key,
    };
    const bedrock_config = provider.bedrock_config
      ? {
          auth_method: provider.bedrock_config.auth_method,
          region: provider.bedrock_config.region,
          access_key_id: provider.bedrock_config.access_key_id,
          profile: provider.bedrock_config.profile,
        }
      : undefined;
    const { api_key: _apiKey, bedrock_config: _bedrockConfig, ...metadata } = provider;
    return {
      ...metadata,
      bedrock_config,
      encryptedSecrets: crypto.encrypt(JSON.stringify(secrets)),
      osEncrypted: crypto.isAvailable(),
    };
  };
  const ensureLoaded = async (): Promise<void> => {
    if (loaded) return;
    try {
      const parsed = JSON.parse(await fsImpl.readFile(filePath, 'utf-8')) as unknown;
      cache = Array.isArray(parsed) ? parsed.filter(isStoredProvider) : [];
    } catch (error) {
      if (!isNotFound(error)) console.warn('[ProviderStore] read failed; using an empty provider list:', error);
      cache = [];
    }
    loaded = true;
  };
  const persist = async (next: StoredProvider[]): Promise<void> => {
    const tempPath = `${filePath}.tmp`;
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    await fsImpl.writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tempPath, filePath);
    cache = next;
  };
  return {
    async list() {
      await ensureLoaded();
      return cache.map(decode);
    },
    async get(id) {
      await ensureLoaded();
      const found = cache.find((provider) => provider.id === id);
      return found ? decode(found) : undefined;
    },
    async create(input) {
      await ensureLoaded();
      const id = input.id?.trim() || newId();
      if (cache.some((provider) => provider.id === id)) throw new Error(`Provider already exists: ${id}`);
      const provider = normalizeCreate(input, id);
      await persist([...cache, encode(provider)]);
      return provider;
    },
    async update(id, input) {
      await ensureLoaded();
      const index = cache.findIndex((provider) => provider.id === id);
      if (index < 0) throw new Error(`Provider not found: ${id}`);
      const current = decode(cache[index]);
      const provider: IProvider = {
        ...current,
        ...input,
        id,
        platform: input.platform?.trim() ?? current.platform,
        name: input.name?.trim() ?? current.name,
        base_url: input.base_url?.trim() ?? current.base_url,
      };
      const next = [...cache];
      next[index] = encode(provider);
      await persist(next);
      return provider;
    },
    async remove(id) {
      await ensureLoaded();
      await persist(cache.filter((provider) => provider.id !== id));
    },
  };
};
