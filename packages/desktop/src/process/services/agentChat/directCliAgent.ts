import { app } from 'electron';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  AcpCoreAdapter,
  CodexAppServerAdapter,
  TomnyCoreAdapter,
  type CoreAdapter,
  type CoreMcpServer,
  type DetectedCoreTarget,
} from '@process/experimentalCore/adapters';
import { detectCoreTargets } from '@process/experimentalCore/coreRegistry';
import { createElectronSurfaceCapabilityHosts } from '@process/experimentalCore/electronSurfaceCapabilityHosts';
import type { ExperimentalPermissionMode } from '@process/experimentalCore/experimentalCoreProtocol';
import { createBuiltinSurfaceManifests } from '@process/agentRuntime/surfaceRegistry';
import { flattenMessagesToPrompt, type CliAgentDriver } from './cliAgentDriver';

export type DirectCliExecutionContext = {
  workspace?: string;
  surface?: string;
  permissionMode?: ExperimentalPermissionMode;
  requestPermission?: (request: {
    tool: string;
    detail?: string;
    agentId: string;
    workspace: string;
    surface: string;
  }) => Promise<boolean>;
};

export type DirectCliAgentDriverDeps = {
  detectTargets: () => Promise<DetectedCoreTarget[]>;
  adapters: CoreAdapter[];
  resolveWorkspace: (context?: DirectCliExecutionContext) => Promise<string>;
  resolveMcpServers: (context?: DirectCliExecutionContext) => Promise<CoreMcpServer[]>;
  createSessionId?: () => string;
};

const safeSurfaceName = (surface?: string): string => {
  const normalized =
    surface
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-') ?? '';
  return normalized.replace(/^-+|-+$/g, '').slice(0, 64) || 'chat';
};

/** Use an explicit surface workspace or an isolated app-data workspace, never the source tree. */
export const resolveDirectCliWorkspace = async (context?: DirectCliExecutionContext): Promise<string> => {
  const explicit = context?.workspace?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit))
      throw new Error('Direct CLI workspace must be an absolute path selected by the UI.');
    return path.resolve(explicit);
  }
  const workspace = path.join(
    app.getPath('userData'),
    'tomny-core',
    'surface-workspaces',
    safeSurfaceName(context?.surface)
  );
  await mkdir(workspace, { recursive: true });
  return workspace;
};

let directCapabilityHosts: ReturnType<typeof createElectronSurfaceCapabilityHosts> | undefined;
const resolveDirectSurfaceMcpServers = async (context?: DirectCliExecutionContext): Promise<CoreMcpServer[]> => {
  const surfaceId = context?.surface?.trim() || 'chat';
  const manifest = createBuiltinSurfaceManifests().find((surface) => surface.id === surfaceId);
  if (!manifest) throw new Error(`Unknown direct CLI surface ${surfaceId}.`);
  const serverNames = manifest.capabilities
    .filter((capability) => capability.kind === 'mcp' && Boolean(capability.serverName))
    .map((capability) => capability.serverName!);
  if (serverNames.length === 0) return [];
  directCapabilityHosts ??= createElectronSurfaceCapabilityHosts();
  return directCapabilityHosts.resolve(serverNames);
};

const defaultDeps = (): DirectCliAgentDriverDeps => ({
  detectTargets: detectCoreTargets,
  adapters: [new TomnyCoreAdapter(), new CodexAppServerAdapter(), new AcpCoreAdapter()],
  resolveWorkspace: resolveDirectCliWorkspace,
  resolveMcpServers: resolveDirectSurfaceMcpServers,
  createSessionId: () => crypto.randomUUID(),
});

/**
 * Drive a detected CLI directly through Tomny Core adapters. This replaces the
 * legacy REST conversation wrapper and never starts or calls AionCore.
 */
export type DirectCliAgentDriver = CliAgentDriver & { dispose: () => Promise<void> };
export const createDirectCliAgentDriver = (
  overrides: Partial<DirectCliAgentDriverDeps> = {},
  context?: DirectCliExecutionContext
): DirectCliAgentDriver => {
  const deps = { ...defaultDeps(), ...overrides };
  let targetCache: { expiresAt: number; values: DetectedCoreTarget[] } | undefined;

  const targets = async (): Promise<DetectedCoreTarget[]> => {
    const now = Date.now();
    if (targetCache && targetCache.expiresAt > now) return targetCache.values;
    const values = await deps.detectTargets();
    targetCache = { values, expiresAt: now + 30_000 };
    return values;
  };

  return {
    run: async ({ agentId, modelId, messages, signal }): Promise<string> => {
      if (signal?.aborted) throw new Error('CLI agent run cancelled.');
      const target = (await targets()).find((candidate) => candidate.id === agentId && candidate.available);
      if (!target) throw new Error(`CLI agent "${agentId}" is not available or has no direct Tomny Core target.`);
      const adapter = deps.adapters.find((candidate) => candidate.protocol === target.protocol);
      if (!adapter) throw new Error(`No direct Tomny Core adapter is registered for ${target.protocol}.`);
      const workspace = await deps.resolveWorkspace(context);
      const mcpServers = await deps.resolveMcpServers(context);
      const prompt = flattenMessagesToPrompt(messages);
      if (!prompt.trim()) throw new Error('CLI agent prompt is empty.');
      let answer = '';
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await adapter.run({
          sessionId: deps.createSessionId?.() ?? crypto.randomUUID(),
          target,
          prompt,
          workspace,
          modelKey: modelId,
          permissionMode: context?.permissionMode ?? 'read-only',
          surface: context?.surface ?? 'chat',
          mcpServers,
          signal: controller.signal,
          emit: (event) => {
            if (event.type !== 'delta') return;
            answer = event.mode === 'replace' ? event.text : answer + event.text;
          },
          requestPermission: (request) =>
            context?.requestPermission?.({
              ...request,
              agentId,
              workspace,
              surface: context.surface ?? 'chat',
            }) ?? Promise.resolve(false),
        });
      } finally {
        signal?.removeEventListener('abort', abort);
      }
      if (!answer.trim()) throw new Error(`CLI agent "${agentId}" completed without a text response.`);
      return answer;
    },
    dispose: async (): Promise<void> => {
      await Promise.allSettled(deps.adapters.map((adapter) => adapter.dispose()));
      targetCache = undefined;
    },
  };
};
