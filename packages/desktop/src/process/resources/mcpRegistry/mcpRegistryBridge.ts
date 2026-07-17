import { bridge } from '@office-ai/platform';
import type { IMcpServer } from '@/common/config/storage';
import { ProcessConfig } from '@process/utils/initStorage';
import { McpRegistry, type McpServerDraft, type McpServerImport } from './mcpRegistry';

export const MCP_REGISTRY_CHANNELS = {
  list: 'mcp-registry.list',
  create: 'mcp-registry.create',
  import: 'mcp-registry.import',
  update: 'mcp-registry.update',
  remove: 'mcp-registry.remove',
  toggle: 'mcp-registry.toggle',
} as const;

export const mcpRegistryChannels = {
  list: bridge.buildProvider<IMcpServer[], void>(MCP_REGISTRY_CHANNELS.list),
  create: bridge.buildProvider<IMcpServer, McpServerDraft>(MCP_REGISTRY_CHANNELS.create),
  import: bridge.buildProvider<IMcpServer[], { servers: McpServerImport[] }>(MCP_REGISTRY_CHANNELS.import),
  update: bridge.buildProvider<IMcpServer, { id: string; data: Partial<McpServerDraft> }>(MCP_REGISTRY_CHANNELS.update),
  remove: bridge.buildProvider<void, { id: string }>(MCP_REGISTRY_CHANNELS.remove),
  toggle: bridge.buildProvider<IMcpServer, { id: string }>(MCP_REGISTRY_CHANNELS.toggle),
};

let registry: McpRegistry | undefined;

export const getMcpRegistry = (): McpRegistry => {
  registry ??= new McpRegistry(ProcessConfig);
  return registry;
};

export const registerMcpRegistryBridge = (service: McpRegistry = getMcpRegistry()): void => {
  mcpRegistryChannels.list.provider(() => service.list());
  mcpRegistryChannels.create.provider((draft) => service.create(draft));
  mcpRegistryChannels.import.provider(({ servers }) => service.importMany(servers));
  mcpRegistryChannels.update.provider(({ id, data }) => service.update(id, data));
  mcpRegistryChannels.remove.provider(({ id }) => service.remove(id));
  mcpRegistryChannels.toggle.provider(({ id }) => service.toggle(id));
};
