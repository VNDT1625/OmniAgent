import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { IMcpServer, IMcpServerTransport } from '@/common/config/storage';

export type McpTestResult = {
  success: boolean;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown; _meta?: Record<string, unknown> }>;
  error?: string;
  needsAuth?: boolean;
  authMethod?: 'oauth' | 'basic';
  wwwAuthenticate?: string;
};

const httpHeaders = (transport: Extract<IMcpServerTransport, { url: string }>): RequestInit => ({
  headers: transport.headers,
});
const createTransport = (transport: IMcpServerTransport): Transport => {
  if (transport.type === 'stdio') return new StdioClientTransport({ ...transport, stderr: 'pipe' });
  const url = new URL(transport.url);
  if (transport.type === 'sse') return new SSEClientTransport(url, { requestInit: httpHeaders(transport) });
  return new StreamableHTTPClientTransport(url, { requestInit: httpHeaders(transport) });
};

export class NativeMcpProbe {
  constructor(private readonly timeoutMs = 15_000) {}
  async test(server: IMcpServer): Promise<McpTestResult> {
    const client = new Client({ name: 'tomny-mcp-probe', version: '1.0.0' });
    const transport = createTransport(server.transport);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP connection timed out.')), this.timeoutMs);
      });
      await Promise.race([client.connect(transport), timeout]);
      const response = await Promise.race([client.listTools(), timeout]);
      return {
        success: true,
        tools: response.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          input_schema: tool.inputSchema,
          ...(tool._meta ? { _meta: tool._meta } : {}),
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const needsAuth = error instanceof UnauthorizedError || /\b(401|unauthori[sz]ed|oauth)\b/i.test(message);
      return {
        success: false,
        error: message,
        ...(needsAuth ? { needsAuth: true, authMethod: 'oauth' as const } : {}),
      };
    } finally {
      if (timer) clearTimeout(timer);
      await client.close().catch(() => transport.close().catch(() => undefined));
    }
  }
}

type ConfigSource = { source: string; file: string };
const commonConfigSources = (home = os.homedir(), appData = process.env.APPDATA): ConfigSource[] => [
  { source: 'claude', file: path.join(home, '.claude.json') },
  { source: 'claude-project', file: path.join(process.cwd(), '.mcp.json') },
  ...(appData ? [{ source: 'claude-desktop', file: path.join(appData, 'Claude', 'claude_desktop_config.json') }] : []),
  { source: 'cursor', file: path.join(home, '.cursor', 'mcp.json') },
  { source: 'kiro', file: path.join(home, '.kiro', 'settings', 'mcp.json') },
  { source: 'windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json') },
  { source: 'opencode', file: path.join(home, '.config', 'opencode', 'opencode.json') },
];

const transportFrom = (value: unknown): IMcpServerTransport | null => {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item.command === 'string')
    return {
      type: 'stdio',
      command: item.command,
      ...(Array.isArray(item.args) ? { args: item.args.filter((v): v is string => typeof v === 'string') } : {}),
      ...(item.env && typeof item.env === 'object' ? { env: item.env as Record<string, string> } : {}),
    };
  if (typeof item.url === 'string')
    return {
      type: item.type === 'sse' ? 'sse' : 'streamable_http',
      url: item.url,
      ...(item.headers && typeof item.headers === 'object' ? { headers: item.headers as Record<string, string> } : {}),
    };
  return null;
};

export class NativeMcpConfigScanner {
  constructor(private readonly sources: ConfigSource[] = commonConfigSources()) {}
  async scan(): Promise<
    Array<{ source: string; servers: Array<IMcpServer & { importable: boolean; import_skip_reason?: string }> }>
  > {
    const result: Array<{
      source: string;
      servers: Array<IMcpServer & { importable: boolean; import_skip_reason?: string }>;
    }> = [];
    for (const source of this.sources) {
      try {
        const parsed = JSON.parse(await readFile(source.file, 'utf8')) as Record<string, unknown>;
        const raw = (parsed.mcpServers ?? parsed.mcp ?? {}) as Record<string, unknown>;
        const servers = Object.entries(raw).map(([name, value], index) => {
          const transport = transportFrom(value);
          const now = Date.now();
          const fallback: IMcpServerTransport = { type: 'stdio', command: '' };
          return {
            id: `${source.source}-${index}-${name}`,
            name,
            enabled: true,
            transport: transport ?? fallback,
            created_at: now,
            updated_at: now,
            original_json: JSON.stringify({ mcpServers: { [name]: value } }, null, 2),
            importable: transport !== null,
            ...(transport ? {} : { import_skip_reason: 'Unsupported MCP transport.' }),
          };
        });
        if (servers.length > 0) result.push({ source: source.source, servers });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          console.warn(`[MCP scanner] Ignored invalid ${source.file}:`, error);
      }
    }
    return result;
  }
}
