import { describe, expect, it } from 'vitest';
import { createRepoSecretStore, type RepoSecretCrypto, type RepoSecretFs } from '@/process/ide/memory/repoSecretStore';

const memoryFs = (): RepoSecretFs => {
  const files = new Map<string, string>();
  return {
    readFile: async (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) {
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return value;
    },
    writeFile: async (filePath, data) => void files.set(filePath, data),
    rename: async (from, to) => {
      const value = files.get(from);
      if (value !== undefined) files.set(to, value);
      files.delete(from);
    },
    mkdir: async () => undefined,
  };
};

const crypto = (): RepoSecretCrypto => ({
  isAvailable: () => true,
  encrypt: (value) => Buffer.from(`sealed:${value}`).toString('base64'),
  decrypt: (value) => Buffer.from(value, 'base64').toString('utf-8').slice('sealed:'.length),
});

describe('RepoSecretStore', () => {
  it('returns metadata only while resolving values only for selected child environments', async () => {
    const store = createRepoSecretStore({ dir: 'C:/vault', fs: memoryFs(), crypto: crypto(), now: () => 1 });
    await store.save('C:/Repo', 'PAYMENTS_API_KEY', 'Payments sandbox', 'secret-value-123');

    expect(await store.list('c:/repo')).toEqual([
      { alias: 'PAYMENTS_API_KEY', description: 'Payments sandbox', status: 'set', updatedAt: 1 },
    ]);
    expect(JSON.stringify(await store.list('c:/repo'))).not.toContain('secret-value-123');
    await expect(store.reveal('C:/repo', 'payments_api_key')).resolves.toBe('secret-value-123');
    expect(await store.resolveEnvironment('C:/repo', ['payments_api_key'])).toEqual({
      PAYMENTS_API_KEY: 'secret-value-123',
    });
    expect(store.redact('token=secret-value-123', { PAYMENTS_API_KEY: 'secret-value-123' })).toBe('token=[REDACTED]');
  });

  it('lets an agent declare metadata without creating a readable value', async () => {
    const store = createRepoSecretStore({ dir: 'C:/vault', fs: memoryFs(), crypto: crypto(), now: () => 1 });
    await store.declare('C:/Repo', 'NEW_API_KEY', 'Needed for deploy');

    expect(await store.list('C:/repo')).toEqual([
      { alias: 'NEW_API_KEY', description: 'Needed for deploy', status: 'needs_value', updatedAt: 1 },
    ]);
    await expect(store.resolveEnvironment('C:/repo', ['NEW_API_KEY'])).rejects.toThrow('has no stored value');
    await expect(store.reveal('C:/repo', 'NEW_API_KEY')).rejects.toThrow('has no stored value');
  });

  it('expands explicit secret markers only for the requested repository', async () => {
    const store = createRepoSecretStore({ dir: 'C:/vault', fs: memoryFs(), crypto: crypto(), now: () => 1 });
    await store.save('C:/Repo-A', 'TEST', 'Test fixture', 'actual-value');
    await store.save('C:/Repo-B', 'TEST', 'Other fixture', 'other-value');

    await expect(store.renderMarkers('C:/Repo-A', 'test is {{secret:test}}.')).resolves.toEqual({
      text: 'test is actual-value.',
      resolvedAliases: ['TEST'],
    });
    await expect(store.renderMarkers('C:/Repo-B', 'test is {{secret:TEST}}.')).resolves.toEqual({
      text: 'test is other-value.',
      resolvedAliases: ['TEST'],
    });
  });

  it('does not change malformed or non-secret text', async () => {
    const store = createRepoSecretStore({ dir: 'C:/vault', fs: memoryFs(), crypto: crypto(), now: () => 1 });

    await expect(store.renderMarkers('C:/Repo', 'Keep {{secret:bad-key}} unchanged.')).resolves.toEqual({
      text: 'Keep {{secret:bad-key}} unchanged.',
      resolvedAliases: [],
    });
  });
});
