import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantResourceStore } from '@process/resources/nativeAssistantResourceBridge';

const roots: string[] = [];
const createStore = async (): Promise<AssistantResourceStore> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tomny-assistant-resources-'));
  roots.push(root);
  return new AssistantResourceStore(root);
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('assistant resource store', () => {
  it('persists rule and skill resources independently by locale', async () => {
    const store = await createStore();
    await store.write({ assistant_id: 'writer', locale: 'vi-VN', content: 'rule vi' }, 'rule');
    await store.write({ assistant_id: 'writer', locale: 'vi-VN', content: 'skill vi' }, 'skill');
    await store.write({ assistant_id: 'writer', locale: 'en-US', content: 'rule en' }, 'rule');

    await expect(store.read({ assistant_id: 'writer', locale: 'vi-VN' }, 'rule')).resolves.toBe('rule vi');
    await expect(store.read({ assistant_id: 'writer', locale: 'vi-VN' }, 'skill')).resolves.toBe('skill vi');
    await expect(store.read({ assistant_id: 'writer', locale: 'en-US' }, 'rule')).resolves.toBe('rule en');
  });

  it('returns empty content for resources that do not exist', async () => {
    const store = await createStore();
    await expect(store.read({ assistant_id: 'missing' }, 'rule')).resolves.toBe('');
  });

  it('deletes all locales only for the requested resource kind', async () => {
    const store = await createStore();
    await store.write({ assistant_id: 'writer', locale: 'vi-VN', content: 'vi' }, 'rule');
    await store.write({ assistant_id: 'writer', locale: 'en-US', content: 'en' }, 'rule');
    await store.write({ assistant_id: 'writer', locale: 'vi-VN', content: 'skill' }, 'skill');

    await expect(store.remove({ assistant_id: 'writer' }, 'rule')).resolves.toBe(true);
    await expect(store.read({ assistant_id: 'writer', locale: 'vi-VN' }, 'rule')).resolves.toBe('');
    await expect(store.read({ assistant_id: 'writer', locale: 'en-US' }, 'rule')).resolves.toBe('');
    await expect(store.read({ assistant_id: 'writer', locale: 'vi-VN' }, 'skill')).resolves.toBe('skill');
  });

  it('rejects path traversal in assistant and locale identifiers', async () => {
    const store = await createStore();
    await expect(store.write({ assistant_id: '../escape', content: 'x' }, 'rule')).rejects.toThrow('safe identifier');
    await expect(store.write({ assistant_id: 'safe', locale: '../escape', content: 'x' }, 'rule')).rejects.toThrow(
      'safe identifier'
    );
  });
});
