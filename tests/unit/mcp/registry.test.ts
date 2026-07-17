import { describe, expect, it } from 'vitest';
import type { IMcpServer } from '@/common/config/storage';
import { McpRegistry, type McpRegistryStore } from '@process/resources/mcpRegistry';

const transport = { type: 'sse' as const, url: 'http://127.0.0.1:9999/sse' };

class MemoryStore implements McpRegistryStore {
  value: IMcpServer[] = [];
  failNextWrite = false;

  async get(): Promise<IMcpServer[]> {
    return structuredClone(this.value);
  }

  async set(_key: 'mcp.config', value: IMcpServer[]): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('disk full');
    }
    await Promise.resolve();
    this.value = structuredClone(value);
  }
}

const draft = (name: string) => ({
  name,
  transport,
  original_json: JSON.stringify({ mcpServers: { [name]: transport } }),
});

describe('Main-process MCP registry', () => {
  it('serializes concurrent imports without losing either server', async () => {
    const store = new MemoryStore();
    let id = 0;
    const registry = new McpRegistry(store, () => 100, () => `id-${++id}`);

    await Promise.all([registry.importMany([draft('alpha')]), registry.importMany([draft('beta')])]);

    await expect(registry.list()).resolves.toMatchObject([
      { id: 'id-1', name: 'alpha', enabled: true },
      { id: 'id-2', name: 'beta', enabled: true },
    ]);
  });

  it('deduplicates names case-insensitively during imports', async () => {
    const store = new MemoryStore();
    const registry = new McpRegistry(store, () => 100, () => 'id-1');

    const imported = await registry.importMany([draft('Tomny'), draft(' tomny ')]);

    expect(imported).toHaveLength(1);
    await expect(registry.list()).resolves.toHaveLength(1);
  });

  it('rejects duplicate create and leaves the persisted catalog unchanged', async () => {
    const store = new MemoryStore();
    const registry = new McpRegistry(store, () => 100, () => 'id-1');
    await registry.create(draft('Tomny'));

    await expect(registry.create(draft(' tomny '))).rejects.toThrow('already exists');
    await expect(registry.list()).resolves.toHaveLength(1);
  });

  it('recovers its write queue after persistence fails', async () => {
    const store = new MemoryStore();
    let id = 0;
    const registry = new McpRegistry(store, () => 100, () => `id-${++id}`);
    store.failNextWrite = true;

    await expect(registry.create(draft('failed'))).rejects.toThrow('disk full');
    await expect(registry.create(draft('healthy'))).resolves.toMatchObject({ name: 'healthy' });
    await expect(registry.list()).resolves.toMatchObject([{ name: 'healthy' }]);
  });

  it('updates, toggles, and removes one server without mutating returned snapshots', async () => {
    const store = new MemoryStore();
    let now = 100;
    const registry = new McpRegistry(store, () => now++, () => 'id-1');
    const created = await registry.create(draft('alpha'));
    created.name = 'external mutation';

    await expect(registry.update('id-1', { description: 'local catalog' })).resolves.toMatchObject({
      name: 'alpha',
      description: 'local catalog',
    });
    await expect(registry.toggle('id-1')).resolves.toMatchObject({ enabled: false });
    await registry.remove('id-1');
    await expect(registry.list()).resolves.toEqual([]);
  });

  it('reports missing update targets instead of silently creating data', async () => {
    const registry = new McpRegistry(new MemoryStore());

    await expect(registry.update('missing', { description: 'nope' })).rejects.toThrow('was not found');
  });
});
