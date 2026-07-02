/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Remote IDE MCP for peer sessions. It gives an agent running on the peer a full
 * IDE-grade tool surface while every repo operation is proxied to the host's
 * `/team/*` HTTP API and therefore flows through the host-side request queue.
 * No source tree is mirrored onto the peer disk.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { app } from 'electron';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { mcpService } from '@/common/adapter/ipcBridge';
import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import { teamRemoteClient } from './teamRemoteClient';
import type { TeamTreeEntry } from './teamSessionHost';

export const REMOTE_IDE_MCP_NAME = 'aionui-remote-ide';

const SSE_PATH = '/sse';
const MESSAGE_PATH = '/message';
const MAX_LIST_RESULTS = 800;
const MAX_SEARCH_FILES = 300;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILE_BYTES = 512_000;

export type RemoteIdeMcpSession = {
  kind?: 'team' | 'cloud';
  baseUrl: string;
  token: string;
  repoName: string;
  workspacePath: string;
  backend?: RemoteIdeMcpBackend;
};

export type RemoteIdeMcpBackend = {
  listDir: (dir: string) => Promise<TeamTreeEntry[]>;
  readFile: (relPath: string) => Promise<string>;
  writeFile: (relPath: string, content: string) => Promise<string>;
  editFile: (relPath: string, oldText: string, newText: string) => Promise<string>;
  status: () => Promise<string>;
};

type RemoteIdeMcpHost = {
  url: string;
  healthUrl: string;
  port: number;
  close: () => Promise<void>;
};

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

type ListedEntry = TeamTreeEntry & { relPath: string };

let activeSession: RemoteIdeMcpSession | null = null;
let host: RemoteIdeMcpHost | undefined;

const textResult = (text: string, isError = false): TextResult => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {}),
});

const guard = async (fn: () => Promise<string>): Promise<TextResult> => {
  try {
    return textResult(await fn());
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true);
  }
};

const requireSession = (): RemoteIdeMcpSession => {
  if (!activeSession) throw new Error('No active remote IDE session. Join a team workspace first.');
  return activeSession;
};

const createTeamBackend = (session: Omit<RemoteIdeMcpSession, 'workspacePath' | 'backend'>): RemoteIdeMcpBackend => ({
  listDir: async (dir) => {
    const res = await teamRemoteClient.tree(session.baseUrl, session.token, dir);
    if ('error' in res) throw new Error(res.error);
    return res.entries;
  },
  readFile: async (relPath) => {
    const res = await teamRemoteClient.file(session.baseUrl, session.token, relPath);
    if ('error' in res) throw new Error(res.error);
    return res.read.content;
  },
  writeFile: async (relPath, content) => {
    const res = await teamRemoteClient.write(session.baseUrl, session.token, relPath, content);
    if ('error' in res) throw new Error(res.error);
    return res.result.ok ? `Wrote ${relPath} via host queue.` : `Write failed: ${JSON.stringify(res.result)}`;
  },
  editFile: async (relPath, oldText, newText) => {
    const res = await teamRemoteClient.edit(session.baseUrl, session.token, relPath, oldText, newText);
    if ('error' in res) throw new Error(res.error);
    return res.result.ok ? `Edited ${relPath} via host queue.` : `Edit failed: ${JSON.stringify(res.result)}`;
  },
  status: async () => {
    const [snapshot, queue] = await Promise.all([
      teamRemoteClient.snapshot(session.baseUrl, session.token),
      teamRemoteClient.queue(session.baseUrl, session.token),
    ]);
    if (snapshot.ok === false) throw new Error(snapshot.error);
    const queueStatus = 'error' in queue ? queue.error : queue.status;
    return JSON.stringify({ repoName: session.repoName, snapshot: snapshot.snapshot, queue: queueStatus }, null, 2);
  },
});

const requireBackend = (session: RemoteIdeMcpSession): RemoteIdeMcpBackend => {
  if (!session.backend) throw new Error('Remote IDE backend is not configured.');
  return session.backend;
};

export const normalizeRemoteRelPath = (input: string, workspacePath?: string): string => {
  let value = input.trim().replace(/\\/g, '/');
  const root = workspacePath?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && (value === root || value.startsWith(`${root}/`))) value = value.slice(root.length);
  value = value.replace(/^\/+/, '').replace(/^\.\//, '');
  const parts = value.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error('Parent path segments are not allowed.');
  return parts.join('/');
};

const normalizeDir = (input: string | undefined, session: RemoteIdeMcpSession): string =>
  input ? normalizeRemoteRelPath(input, session.workspacePath) : '';

const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');

const globToRegex = (glob: string): RegExp => {
  const normalized = glob.replace(/\\/g, '/');
  let source = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`);
};

const matchesGlob = (relPath: string, pattern: string): boolean => {
  const normalized = relPath.replace(/\\/g, '/');
  const target = pattern.includes('/') ? normalized : path.posix.basename(normalized);
  return globToRegex(pattern).test(target);
};

const listRecursive = async (
  session: RemoteIdeMcpSession,
  dir: string,
  options: { recursive?: boolean; glob?: string; maxResults?: number }
): Promise<ListedEntry[]> => {
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 100, MAX_LIST_RESULTS));
  const out: ListedEntry[] = [];
  const queue = [dir];
  while (queue.length > 0 && out.length < maxResults) {
    const current = queue.shift() ?? '';
    // Intentionally sequential: the host already queues work, and recursive discovery should not fan out LAN reads.
    // eslint-disable-next-line no-await-in-loop
    const entries = await requireBackend(session).listDir(current);
    for (const entry of entries) {
      const relPath = current ? `${current}/${entry.name}` : entry.name;
      if (!options.glob || matchesGlob(relPath, options.glob)) out.push({ ...entry, relPath });
      if (entry.isDir && options.recursive && out.length < maxResults) queue.push(relPath);
      if (out.length >= maxResults) break;
    }
  }
  return out;
};

const readRemoteFile = async (session: RemoteIdeMcpSession, relPath: string): Promise<string> => {
  return requireBackend(session).readFile(relPath);
};

const withLineNumbers = (content: string, from?: number, to?: number, maxLines = 2000): string => {
  const lines = content.split('\n');
  const start = Math.max(1, from ?? 1);
  const end = Math.min(lines.length, to ?? Math.min(lines.length, start + Math.max(1, maxLines) - 1));
  const body = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`);
  const truncated = end < lines.length ? '; TRUNCATED - pass a narrower from/to or all=true for more' : '';
  return `[lines ${start}-${end} of ${lines.length}${truncated}]\n${body.join('\n')}`;
};

export const createRemoteIdeWorkspaceGuide = (session: RemoteIdeMcpSession): string =>
  [
    `# Remote IDE Session: ${session.repoName}`,
    '',
    'This directory is only a lightweight launch workspace for an agent running on this peer machine.',
    'The real repository is hosted by another AionUi instance and must be accessed through MCP tools.',
    '',
    'Rules:',
    '- Use repo-relative paths such as `packages/app/src/main.ts`.',
    '- Read/list/search with `ide_list_dir`, `ide_glob`, `ide_read_file`, and `ide_search`.',
    session.kind === 'cloud'
      ? '- Edit with `team_edit_file` or `team_write_file`; those writes are appended to the cloud operation log.'
      : '- Edit with `team_edit_file` or `team_write_file`; those writes go through host-side leases, MTUI, and the team request queue.',
    '- Do not use native filesystem or shell tools for repository work in this scratch directory.',
  ].join('\n');

export const ensureRemoteIdeWorkspace = async (
  session: Omit<RemoteIdeMcpSession, 'workspacePath'>
): Promise<string> => {
  const hash = crypto
    .createHash('sha256')
    .update(`${session.baseUrl}\n${session.repoName}\n${session.token}`)
    .digest('hex')
    .slice(0, 16);
  const workspacePath = path.join(app.getPath('userData'), 'remote-ide', hash);
  const guideSession: RemoteIdeMcpSession = { ...session, workspacePath };
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(
    path.join(workspacePath, 'README.md'),
    `${createRemoteIdeWorkspaceGuide(guideSession)}\n`,
    'utf-8'
  );
  await fs.writeFile(
    path.join(workspacePath, 'AGENTS.md'),
    `${createRemoteIdeWorkspaceGuide(guideSession)}\n`,
    'utf-8'
  );
  return workspacePath;
};

const createRemoteIdeServer = (): McpServer => {
  const server = new McpServer({ name: REMOTE_IDE_MCP_NAME, version: '1.0.0' });

  server.tool(
    'ide_list_dir',
    'List remote host repository entries. dir is repo-relative; use recursive/glob for bounded file discovery.',
    {
      dir: z.string().optional(),
      glob: z.string().optional(),
      recursive: z.boolean().optional(),
      maxResults: z.number().optional(),
    },
    ({ dir, glob, recursive, maxResults }) =>
      guard(async () => {
        const session = requireSession();
        const entries = await listRecursive(session, normalizeDir(dir, session), { glob, recursive, maxResults });
        if (entries.length === 0) return 'No matching entries.';
        return entries.map((e) => `${e.isDir ? '[dir] ' : '      '}${e.relPath}`).join('\n');
      })
  );

  server.tool(
    'ide_glob',
    'Find remote host repository files by glob. pattern examples: **/*.ts, packages/**/index.ts.',
    {
      dir: z.string().optional(),
      pattern: z.string(),
      recursive: z.boolean().optional(),
      maxResults: z.number().optional(),
    },
    ({ dir, pattern, recursive, maxResults }) =>
      guard(async () => {
        const session = requireSession();
        const entries = await listRecursive(session, normalizeDir(dir, session), {
          glob: pattern,
          recursive: recursive ?? true,
          maxResults,
        });
        const files = entries.filter((entry) => !entry.isDir);
        return files.length > 0 ? files.map((entry) => entry.relPath).join('\n') : 'No files match the pattern.';
      })
  );

  server.tool(
    'ide_read_file',
    'Read a remote host file by repo-relative path with optional line range.',
    {
      filePath: z.string(),
      all: z.boolean().optional(),
      from: z.number().optional(),
      to: z.number().optional(),
      maxLines: z.number().optional(),
    },
    ({ filePath, all, from, to, maxLines }) =>
      guard(async () => {
        const session = requireSession();
        const relPath = normalizeRemoteRelPath(filePath, session.workspacePath);
        const content = await readRemoteFile(session, relPath);
        if (all) return content;
        return withLineNumbers(content, from, to, maxLines ?? 2000);
      })
  );

  server.tool(
    'ide_search',
    'Search remote host text files. Bounded to protect the host; narrow with dir/glob when possible.',
    {
      query: z.string(),
      dir: z.string().optional(),
      glob: z.string().optional(),
      caseSensitive: z.boolean().optional(),
      regex: z.boolean().optional(),
      maxResults: z.number().optional(),
    },
    ({ query, dir, glob, caseSensitive, regex, maxResults }) =>
      guard(async () => {
        const session = requireSession();
        const files = (
          await listRecursive(session, normalizeDir(dir, session), {
            glob: glob ?? '**/*',
            recursive: true,
            maxResults: MAX_SEARCH_FILES,
          })
        ).filter((entry) => !entry.isDir);
        const limit = Math.max(1, Math.min(maxResults ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS));
        const flags = caseSensitive ? 'g' : 'gi';
        const pattern = regex ? new RegExp(query, flags) : new RegExp(escapeRegex(query), flags);
        const hits: string[] = [];
        for (const file of files) {
          if (hits.length >= limit) break;
          // Intentionally sequential to keep remote search from spiking host IO.
          // eslint-disable-next-line no-await-in-loop
          const content = await readRemoteFile(session, file.relPath);
          if (content.length > MAX_SEARCH_FILE_BYTES) continue;
          const lines = content.split('\n');
          for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
            if (pattern.test(lines[index])) hits.push(`${file.relPath}:${index + 1}: ${lines[index].trim()}`);
            pattern.lastIndex = 0;
          }
        }
        return hits.length > 0 ? hits.join('\n') : 'No matches found.';
      })
  );

  server.tool(
    'team_edit_file',
    'Edit a remote host file by replacing exact oldText with newText through the host queue and MTUI.',
    {
      rootPath: z.string().optional(),
      agentId: z.string().optional(),
      relPath: z.string(),
      oldText: z.string(),
      newText: z.string(),
    },
    ({ relPath, oldText, newText }) =>
      guard(async () => {
        const session = requireSession();
        const pathValue = normalizeRemoteRelPath(relPath, session.workspacePath);
        return requireBackend(session).editFile(pathValue, oldText, newText);
      })
  );

  server.tool(
    'team_write_file',
    'Write full remote host file content through the host queue and MTUI.',
    {
      rootPath: z.string().optional(),
      agentId: z.string().optional(),
      relPath: z.string(),
      content: z.string(),
    },
    ({ relPath, content }) =>
      guard(async () => {
        const session = requireSession();
        const pathValue = normalizeRemoteRelPath(relPath, session.workspacePath);
        return requireBackend(session).writeFile(pathValue, content);
      })
  );

  server.tool('team_status', 'Show remote host participants, leases, and queue status.', {}, () =>
    guard(async () => {
      const session = requireSession();
      return requireBackend(session).status();
    })
  );

  server.tool('ide_command', 'Disabled in remote IDE mode to keep the host responsive.', { command: z.string() }, () =>
    textResult('Remote IDE mode does not run shell commands on the host. Use file/search/edit tools instead.', true)
  );

  return server;
};

const startRemoteIdeMcpHost = async (): Promise<RemoteIdeMcpHost> => {
  if (host) return host;
  const startedAt = new Date().toISOString();
  const transports = new Map<string, SSEServerTransport>();
  const server = http.createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        res
          .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ ok: true, server: REMOTE_IDE_MCP_NAME, activeSessions: transports.size, startedAt }));
        return;
      }
      if (req.method === 'GET' && url.pathname === SSE_PATH) {
        const transport = new SSEServerTransport(MESSAGE_PATH, res);
        transports.set(transport.sessionId, transport);
        transport.onclose = () => transports.delete(transport.sessionId);
        await createRemoteIdeServer().connect(transport);
        return;
      }
      if (req.method === 'POST' && url.pathname === MESSAGE_PATH) {
        const transport = transports.get(url.searchParams.get('sessionId') ?? '');
        if (!transport) {
          res.writeHead(404).end('No active session for the given sessionId.');
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    })().catch((error: unknown) => {
      console.error('[RemoteIdeMCP] request failed:', error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('[RemoteIdeMCP] Could not resolve loopback port.'));
    });
  });
  host = {
    url: `http://127.0.0.1:${port}${SSE_PATH}`,
    healthUrl: `http://127.0.0.1:${port}/health`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const transport of transports.values()) void transport.close();
        transports.clear();
        server.close(() => resolve());
      }),
  };
  console.log(`[RemoteIdeMCP] host listening on ${host.url}.`);
  return host;
};

const toSessionServer = (server: IMcpServer): ISessionMcpServer => ({
  id: server.id,
  name: server.name,
  transport: server.transport,
});

export const ensureRemoteIdeMcpRegistered = async (
  sessionInput: Omit<RemoteIdeMcpSession, 'workspacePath'>
): Promise<{ workspacePath: string; server: ISessionMcpServer }> => {
  const workspacePath = await ensureRemoteIdeWorkspace(sessionInput);
  activeSession = {
    ...sessionInput,
    kind: 'team',
    workspacePath,
    backend: sessionInput.backend ?? createTeamBackend(sessionInput),
  };
  const endpoint = await startRemoteIdeMcpHost();
  const transport = { type: 'sse' as const, url: endpoint.url };
  const description =
    'Built-in remote IDE tools for a joined team workspace. Proxies file/search/edit operations to the host queue.';
  const original_json = JSON.stringify({ mcpServers: { [REMOTE_IDE_MCP_NAME]: { url: endpoint.url } } }, null, 2);
  const existing = (await mcpService.listServers.invoke()) ?? [];
  const current = existing.find((server) => server.name === REMOTE_IDE_MCP_NAME);
  if (!current) {
    const imported = await mcpService.batchImportServers.invoke({
      servers: [{ name: REMOTE_IDE_MCP_NAME, description, enabled: false, builtin: true, transport, original_json }],
    });
    const added = imported.find((server) => server.name === REMOTE_IDE_MCP_NAME);
    if (!added) throw new Error('Remote IDE MCP catalog import did not return the server.');
    return { workspacePath, server: toSessionServer(added) };
  }
  const sameUrl = current.transport.type === 'sse' && current.transport.url === endpoint.url;
  const updated = sameUrl
    ? current
    : await mcpService.updateServer.invoke({
        id: current.id,
        data: { transport, original_json, builtin: true, description },
      });
  return { workspacePath, server: toSessionServer(updated) };
};

export const ensureCloudIdeMcpRegistered = async (
  sessionInput: Omit<RemoteIdeMcpSession, 'workspacePath'> & { backend: RemoteIdeMcpBackend }
): Promise<{ workspacePath: string; server: ISessionMcpServer }> => {
  const workspacePath = await ensureRemoteIdeWorkspace({ ...sessionInput, kind: 'cloud' });
  activeSession = { ...sessionInput, kind: 'cloud', workspacePath };
  const endpoint = await startRemoteIdeMcpHost();
  const transport = { type: 'sse' as const, url: endpoint.url };
  const description =
    'Built-in cloud IDE tools for an AionUi cloud workspace. Proxies file/search/edit operations to the relay.';
  const original_json = JSON.stringify({ mcpServers: { [REMOTE_IDE_MCP_NAME]: { url: endpoint.url } } }, null, 2);
  const existing = (await mcpService.listServers.invoke()) ?? [];
  const current = existing.find((server) => server.name === REMOTE_IDE_MCP_NAME);
  if (!current) {
    const imported = await mcpService.batchImportServers.invoke({
      servers: [{ name: REMOTE_IDE_MCP_NAME, description, enabled: false, builtin: true, transport, original_json }],
    });
    const added = imported.find((server) => server.name === REMOTE_IDE_MCP_NAME);
    if (!added) throw new Error('Cloud IDE MCP catalog import did not return the server.');
    return { workspacePath, server: toSessionServer(added) };
  }
  const sameUrl = current.transport.type === 'sse' && current.transport.url === endpoint.url;
  const updated = sameUrl
    ? current
    : await mcpService.updateServer.invoke({
        id: current.id,
        data: { transport, original_json, builtin: true, description },
      });
  return { workspacePath, server: toSessionServer(updated) };
};

export const clearRemoteIdeMcpSession = (baseUrl: string, token: string): void => {
  if (activeSession?.baseUrl === baseUrl && activeSession.token === token) activeSession = null;
};
