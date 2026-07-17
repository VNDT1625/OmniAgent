/**
 * Repository-scoped Secret Context vault.
 *
 * Values are encrypted with Electron safeStorage, kept in app data (never the
 * repository), and are intentionally absent from every renderer/MCP response.
 */
import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

const VAULT_FILE = 'ide-repo-secret-context.json';
const ALIAS = /^[A-Z][A-Z0-9_]{0,79}$/;
const SECRET_MARKER = /\{\{secret:([A-Z][A-Z0-9_]{0,79})\}\}/gi;

export type RepoSecretContext = {
  alias: string;
  description: string;
  status: 'set' | 'needs_value';
  updatedAt: number;
};

/** Result returned only to the local renderer after explicit marker rendering. */
export type RepoSecretMarkerRender = {
  text: string;
  resolvedAliases: string[];
};

type StoredSecretContext = RepoSecretContext & {
  repository: string;
  encryptedValue?: string;
  osEncrypted?: boolean;
};

type RepoSecretStore = {
  list(repository: string): Promise<RepoSecretContext[]>;
  declare(repository: string, alias: string, description: string): Promise<RepoSecretContext>;
  save(repository: string, alias: string, description: string, value: string): Promise<RepoSecretContext>;
  remove(repository: string, alias: string): Promise<void>;
  /**
   * Returns a value only to the local, trusted renderer after an explicit
   * user reveal action. This method is never wired into MCP or agent tools.
   */
  reveal(repository: string, alias: string): Promise<string>;
  /** Replaces only `{{secret:ALIAS}}` for a renderer explicitly requesting it. */
  renderMarkers(repository: string, text: string): Promise<RepoSecretMarkerRender>;
  /** Main-process only: inject selected aliases into a child process environment. */
  resolveEnvironment(repository: string, aliases: string[]): Promise<Record<string, string>>;
  /** Remove every resolved value from a tool result before it reaches the model. */
  redact(text: string, values: Record<string, string>): string;
};

export type RepoSecretFs = {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  writeFile(path: string, data: string, options: { encoding: 'utf-8'; mode: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
};

export type RepoSecretCrypto = {
  isAvailable(): boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
};

const normalizeRepository = (repository: string): string => path.resolve(repository.trim()).toLowerCase();
const normalizeAlias = (alias: string): string => alias.trim().toUpperCase();

const defaultFs: RepoSecretFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (from, to) => fs.promises.rename(from, to),
  mkdir: (directory, options) => fs.promises.mkdir(directory, options),
};

const defaultCrypto: RepoSecretCrypto = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
};

export const createRepoSecretStore = (options?: {
  dir?: string;
  now?: () => number;
  fs?: RepoSecretFs;
  crypto?: RepoSecretCrypto;
}): RepoSecretStore => {
  const dir = options?.dir ?? app.getPath('userData');
  const now = options?.now ?? Date.now;
  const fsImpl = options?.fs ?? defaultFs;
  const crypto = options?.crypto ?? defaultCrypto;
  const filePath = path.join(dir, VAULT_FILE);
  let cache: StoredSecretContext[] | null = null;

  const load = async (): Promise<StoredSecretContext[]> => {
    if (cache) return cache;
    try {
      const raw: unknown = JSON.parse(await fsImpl.readFile(filePath, 'utf-8'));
      cache = Array.isArray(raw)
        ? raw.filter(
            (item): item is StoredSecretContext =>
              typeof item === 'object' &&
              item !== null &&
              typeof (item as StoredSecretContext).repository === 'string' &&
              typeof (item as StoredSecretContext).alias === 'string' &&
              typeof (item as StoredSecretContext).description === 'string' &&
              typeof (item as StoredSecretContext).updatedAt === 'number'
          )
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[RepoSecretStore] read failed:', error);
      cache = [];
    }
    return cache;
  };

  const persist = async (next: StoredSecretContext[]): Promise<void> => {
    cache = next;
    await fsImpl.mkdir(dir, { recursive: true });
    const temporary = `${filePath}.tmp`;
    await fsImpl.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(temporary, filePath);
  };

  const metadata = (entry: StoredSecretContext): RepoSecretContext => ({
    alias: entry.alias,
    description: entry.description,
    status: entry.encryptedValue ? 'set' : 'needs_value',
    updatedAt: entry.updatedAt,
  });

  const validate = (
    repository: string,
    alias: string,
    description: string
  ): { repository: string; alias: string; description: string } => {
    const normalizedRepository = normalizeRepository(repository);
    const normalizedAlias = normalizeAlias(alias);
    const normalizedDescription = description.trim().slice(0, 240);
    if (!repository.trim()) throw new Error('A repository is required.');
    if (!ALIAS.test(normalizedAlias)) throw new Error('Alias must use uppercase letters, numbers, and underscores.');
    if (!normalizedDescription) throw new Error('A purpose is required.');
    return { repository: normalizedRepository, alias: normalizedAlias, description: normalizedDescription };
  };

  const update = async (
    repository: string,
    alias: string,
    description: string,
    value?: string
  ): Promise<RepoSecretContext> => {
    const input = validate(repository, alias, description);
    const entries = await load();
    const existing = entries.find((entry) => entry.repository === input.repository && entry.alias === input.alias);
    if (value !== undefined && !crypto.isAvailable()) {
      throw new Error('System keychain is unavailable; Secret Context cannot store values securely.');
    }
    const sealed = value === undefined ? undefined : { encryptedValue: crypto.encrypt(value), osEncrypted: true };
    const next: StoredSecretContext = {
      repository: input.repository,
      alias: input.alias,
      description: input.description,
      status: (sealed?.encryptedValue ?? existing?.encryptedValue) ? 'set' : 'needs_value',
      updatedAt: now(),
      encryptedValue: sealed?.encryptedValue ?? existing?.encryptedValue,
      osEncrypted: sealed?.osEncrypted ?? existing?.osEncrypted,
    };
    await persist([
      ...entries.filter((entry) => entry.repository !== input.repository || entry.alias !== input.alias),
      next,
    ]);
    return metadata(next);
  };

  return {
    async list(repository) {
      const root = normalizeRepository(repository);
      return (await load())
        .filter((entry) => entry.repository === root)
        .map(metadata)
        .sort((left, right) => left.alias.localeCompare(right.alias));
    },
    declare: (repository, alias, description) => update(repository, alias, description),
    save: (repository, alias, description, value) => {
      if (!value.trim()) throw new Error('A secret value is required.');
      return update(repository, alias, description, value);
    },
    async remove(repository, alias) {
      const root = normalizeRepository(repository);
      const key = normalizeAlias(alias);
      await persist((await load()).filter((entry) => entry.repository !== root || entry.alias !== key));
    },
    async reveal(repository, alias) {
      const root = normalizeRepository(repository);
      const key = normalizeAlias(alias);
      const entry = (await load()).find((candidate) => candidate.repository === root && candidate.alias === key);
      if (!entry?.encryptedValue) throw new Error(`Secret Context alias ${key} has no stored value.`);
      if (!entry.osEncrypted) throw new Error(`Secret Context alias ${key} is not protected by the system keychain.`);
      try {
        return crypto.decrypt(entry.encryptedValue);
      } catch {
        throw new Error(`Secret Context alias ${key} could not be decrypted on this system.`);
      }
    },
    async renderMarkers(repository, text) {
      const root = normalizeRepository(repository);
      const aliases = Array.from(
        new Set(Array.from(text.matchAll(SECRET_MARKER), (match) => normalizeAlias(match[1])))
      );
      if (aliases.length === 0) return { text, resolvedAliases: [] };

      const values = new Map(
        await Promise.all(aliases.map(async (alias) => [alias, await this.reveal(root, alias)] as const))
      );
      return {
        text: text.replace(SECRET_MARKER, (marker, rawAlias: string) => values.get(normalizeAlias(rawAlias)) ?? marker),
        resolvedAliases: aliases,
      };
    },
    async resolveEnvironment(repository, aliases) {
      const root = normalizeRepository(repository);
      const requested = Array.from(new Set(aliases.map(normalizeAlias)));
      const resolved: Record<string, string> = {};
      for (const alias of requested) {
        resolved[alias] = await this.reveal(root, alias);
      }
      return resolved;
    },
    redact(text, values) {
      return Object.values(values).reduce(
        (safe, value) => (value.length > 0 ? safe.split(value).join('[REDACTED]') : safe),
        text
      );
    },
  };
};

let store: RepoSecretStore | null = null;

export const getRepoSecretStore = (): RepoSecretStore => {
  store ??= createRepoSecretStore();
  return store;
};
