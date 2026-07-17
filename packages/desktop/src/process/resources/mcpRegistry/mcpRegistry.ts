/**
 * Main-process MCP catalog. This is the durable source of truth used by the
 * renderer and by built-in MCP registration; it never calls the legacy HTTP
 * backend.
 */
import { randomUUID } from 'node:crypto';
import type { IMcpServer } from '@/common/config/storage';

export type McpRegistryStore = {
  get(key: 'mcp.config'): Promise<IMcpServer[] | undefined>;
  set(key: 'mcp.config', value: IMcpServer[]): Promise<void>;
};

export type McpServerDraft = Pick<IMcpServer, 'name' | 'description' | 'transport' | 'original_json' | 'builtin'>;

export type McpServerImport = Partial<IMcpServer> & Pick<IMcpServer, 'name' | 'transport'>;

const normalizeName = (name: string): string => name.trim();

const cloneServer = (server: IMcpServer): IMcpServer => structuredClone(server);

export class McpRegistry {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: McpRegistryStore,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = randomUUID
  ) {}

  async list(): Promise<IMcpServer[]> {
    await this.writeQueue;
    return ((await this.store.get('mcp.config')) ?? []).map(cloneServer);
  }

  create(draft: McpServerDraft): Promise<IMcpServer> {
    return this.mutate((servers) => {
      const name = normalizeName(draft.name);
      if (!name) throw new Error('MCP server name is required.');
      if (servers.some((server) => normalizeName(server.name).toLowerCase() === name.toLowerCase())) {
        throw new Error(`MCP server "${name}" already exists.`);
      }
      const timestamp = this.now();
      const server: IMcpServer = {
        ...draft,
        id: this.createId(),
        name,
        enabled: true,
        created_at: timestamp,
        updated_at: timestamp,
      };
      servers.push(server);
      return cloneServer(server);
    });
  }

  update(id: string, data: Partial<McpServerDraft>): Promise<IMcpServer> {
    return this.mutate((servers) => {
      const index = servers.findIndex((server) => server.id === id);
      if (index < 0) throw new Error(`MCP server "${id}" was not found.`);
      const nextName = data.name === undefined ? servers[index].name : normalizeName(data.name);
      if (!nextName) throw new Error('MCP server name is required.');
      if (
        servers.some(
          (server, candidateIndex) =>
            candidateIndex !== index && normalizeName(server.name).toLowerCase() === nextName.toLowerCase()
        )
      ) {
        throw new Error(`MCP server "${nextName}" already exists.`);
      }
      const next = { ...servers[index], ...data, name: nextName, updated_at: this.now() };
      servers[index] = next;
      return cloneServer(next);
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((servers) => {
      const index = servers.findIndex((server) => server.id === id);
      if (index < 0) return;
      servers.splice(index, 1);
    });
  }

  toggle(id: string): Promise<IMcpServer> {
    return this.mutate((servers) => {
      const index = servers.findIndex((server) => server.id === id);
      if (index < 0) throw new Error(`MCP server "${id}" was not found.`);
      const next = { ...servers[index], enabled: !servers[index].enabled, updated_at: this.now() };
      servers[index] = next;
      return cloneServer(next);
    });
  }

  importMany(drafts: McpServerImport[]): Promise<IMcpServer[]> {
    return this.mutate((servers) => {
      const byName = new Map(servers.map((server) => [normalizeName(server.name).toLowerCase(), server]));
      const imported: IMcpServer[] = [];
      for (const draft of drafts) {
        const name = normalizeName(draft.name);
        if (!name || byName.has(name.toLowerCase())) continue;
        const timestamp = this.now();
        const server: IMcpServer = {
          ...draft,
          id: draft.id?.trim() || this.createId(),
          name,
          description: draft.description,
          enabled: draft.enabled ?? true,
          created_at: draft.created_at ?? timestamp,
          updated_at: timestamp,
          original_json: draft.original_json ?? JSON.stringify({ mcpServers: { [name]: draft.transport } }, null, 2),
        };
        servers.push(server);
        byName.set(name.toLowerCase(), server);
        imported.push(cloneServer(server));
      }
      return imported;
    });
  }

  private mutate<T>(operation: (servers: IMcpServer[]) => T | Promise<T>): Promise<T> {
    const result = this.writeQueue.then(async () => {
      const servers = ((await this.store.get('mcp.config')) ?? []).map(cloneServer);
      const value = await operation(servers);
      await this.store.set('mcp.config', servers);
      return value;
    });
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
