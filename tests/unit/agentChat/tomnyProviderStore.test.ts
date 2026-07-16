import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => 'unused' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

import {
  createProviderStore,
  type ProviderCrypto,
  type ProviderFs,
} from '../../../packages/desktop/src/process/services/tomnyProviderStore';

describe('Tomny provider store', () => {
  let files: Map<string, string>;
  let fs: ProviderFs;
  const crypto: ProviderCrypto = {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(`encrypted:${plain}`, 'utf8').toString('base64'),
    decrypt: (value) =>
      Buffer.from(value, 'base64')
        .toString('utf8')
        .replace(/^encrypted:/u, ''),
  };

  beforeEach(() => {
    files = new Map();
    fs = {
      readFile: async (filePath) => {
        const value = files.get(filePath);
        if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return value;
      },
      writeFile: async (filePath, data) => {
        files.set(filePath, data);
      },
      rename: async (oldPath, newPath) => {
        const value = files.get(oldPath);
        if (value === undefined) throw new Error('missing temp file');
        files.set(newPath, value);
        files.delete(oldPath);
      },
      mkdir: async () => undefined,
    };
  });

  it('encrypts provider secrets at rest and returns them to Main consumers', async () => {
    const store = createProviderStore({ dir: 'test-data', fs, crypto, newId: () => 'provider-1' });
    await store.create({
      platform: 'openai',
      name: 'OpenAI',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-secret-value',
      models: ['gpt-5.6'],
    });

    const persisted = [...files.values()][0] ?? '';
    expect(persisted).not.toContain('sk-secret-value');
    expect(await store.get('provider-1')).toMatchObject({
      api_key: 'sk-secret-value',
      models: ['gpt-5.6'],
      enabled: true,
    });
  });

  it('updates and removes providers without changing their identity', async () => {
    const store = createProviderStore({ dir: 'test-data', fs, crypto, newId: () => 'provider-1' });
    await store.create({
      platform: 'openai',
      name: 'Primary',
      base_url: 'https://example.test/v1',
      api_key: 'key',
      models: ['model-a'],
    });
    const updated = await store.update('provider-1', { name: 'Updated', models: ['model-b'] });
    expect(updated).toMatchObject({ id: 'provider-1', name: 'Updated', models: ['model-b'], api_key: 'key' });
    await store.remove('provider-1');
    expect(await store.list()).toEqual([]);
  });
});
