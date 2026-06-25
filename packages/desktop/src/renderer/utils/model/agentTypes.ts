/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';

/** SWR key for agent metadata rows (from `/api/agents`). */
export const DETECTED_AGENTS_SWR_KEY = 'agents.detected';

/** Type of an agent. */
export type AgentType = 'acp' | 'remote' | 'aionrs' | 'openclaw-gateway' | 'nanobot';

/** Source tier of an agent row, mirroring backend `agent_source` enum. */
export type AgentSource = 'internal' | 'builtin' | 'extension' | 'custom';

/** Source-specific bookkeeping (how to probe, how to upgrade). */
export type AgentSourceInfo = {
  binary_name?: string;
  bridge_binary?: string;
  hub_package_id?: string;
  version?: string;
};

/** Environment variable entry passed to a spawned agent process. */
export type AgentEnvEntry = {
  name: string;
  value: string;
  description?: string;
};

/**
 * Adapter-side behaviour switches. New flags are added here by extending
 * the struct on the backend — the frontend should read them defensively
 * because older rows may not have every field populated.
 *
 * Whether the agent supports session/load is NOT in this bag — read
 * `handshake.agent_capabilities.load_session` instead, since the CLI
 * advertises that during init.
 */
export type BehaviorPolicy = {
  supports_side_question?: boolean;
};

/**
 * Handshake-derived fields captured from the ACP init/session-response.
 * Each field is opaque JSON the backend passes through verbatim; typing
 * happens in whatever call site actually consumes it.
 */
export type AgentHandshake = {
  agent_capabilities?: unknown;
  auth_methods?: unknown;
  config_options?: unknown;
  available_modes?: unknown;
  available_models?: unknown;
  available_commands?: unknown;
};

/**
 * Unified agent metadata returned by `/api/agents`.
 *
 * Replaces the old split of `DetectedAgent` / `AvailableAgent` — the
 * backend now stores the same shape in the `agent_metadata` table,
 * caches it in-process, and serves it directly over HTTP.
 */
export type AgentMetadata = {
  id: string;
  icon?: string;
  name: string;
  name_i18n?: Record<string, string>;
  description?: string;
  description_i18n?: Record<string, string>;

  /** Vendor label (e.g. "claude"). Absent for agents without vendor grouping. */
  backend?: string;
  /** Top-level runtime discriminant: "acp" | "remote" | "nanobot" | "aionrs" | … */
  agent_type: AgentType;
  agent_source: AgentSource;
  agent_source_info?: AgentSourceInfo;

  enabled: boolean;
  /** True iff the backend resolved the spawn command on `$PATH` at hydrate time. */
  available: boolean;
  /** True when the agent supports team mode (MCP stdio capable). Computed by backend. */
  team_capable?: boolean;

  /** Pre-resolution spawn command as stored in the catalog (e.g. "bun"). */
  command?: string;
  args?: string[];
  env?: AgentEnvEntry[];
  native_skills_dirs?: string[];

  behavior_policy?: BehaviorPolicy;

  /** Native mode id that AionUi's legacy `yolo` / `yoloNoSandbox`
   *  aliases resolve to before calling `session/set_mode`. Absent
   *  when the backend has no yolo equivalent. */
  yolo_id?: string;

  handshake?: AgentHandshake;
};

type BootstrapCliAgent = {
  name: string;
  command: string;
  args: string[];
  icon: string;
  description: string;
  yolo_id: string;
};

function resolveAntigravityCommand(): string {
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')) {
    return 'agi.exe';
  }
  return 'agi';
}

const BOOTSTRAP_CLI_AGENTS: BootstrapCliAgent[] = [
  {
    name: 'DeepSeek TUI',
    command: 'deepseek-tui',
    args: ['acp'],
    icon: 'ai-china/deepseek.svg',
    description: 'DeepSeek Terminal UI (codewhale)',
    yolo_id: 'yolo',
  },
  {
    name: 'Antigravity',
    command: resolveAntigravityCommand(),
    args: ['acp'],
    icon: 'tools/antigravity.svg',
    description: 'Antigravity CLI (agi.exe / agi)',
    yolo_id: 'yolo',
  },
];

let lastBootstrapCliAgentAttempt = 0;
const BOOTSTRAP_CLI_AGENT_RETRY_MS = 60_000;

function hasBootstrapCliAgent(agents: AgentMetadata[], entry: BootstrapCliAgent): boolean {
  return agents.some(
    (agent) =>
      agent.name === entry.name ||
      agent.command === entry.command ||
      agent.id === entry.command ||
      agent.id === entry.name
  );
}

async function ensureBootstrapCliAgents(agents: AgentMetadata[]): Promise<boolean> {
  const missing = BOOTSTRAP_CLI_AGENTS.filter((entry) => !hasBootstrapCliAgent(agents, entry));
  if (missing.length === 0) {
    return false;
  }

  const now = Date.now();
  if (now - lastBootstrapCliAgentAttempt < BOOTSTRAP_CLI_AGENT_RETRY_MS) {
    return false;
  }
  lastBootstrapCliAgentAttempt = now;

  const results = await Promise.allSettled(
    missing.map((entry) =>
      ipcBridge.acpConversation.createCustomAgent.invoke({
        name: entry.name,
        command: entry.command,
        icon: entry.icon,
        args: entry.args,
        advanced: {
          description: entry.description,
          yolo_id: entry.yolo_id,
        },
      })
    )
  );

  const created = results.some((result) => result.status === 'fulfilled');
  if (created) {
    await ipcBridge.acpConversation.refreshCustomAgents.invoke().catch((): undefined => undefined);
  }
  return created;
}

/** Shared fetcher for DETECTED_AGENTS_SWR_KEY — single source of truth. */
export async function fetchDetectedAgents(): Promise<AgentMetadata[]> {
  try {
    const agents = await ipcBridge.acpConversation.getAvailableAgents.invoke();
    if (Array.isArray(agents)) {
      const detectedAgents = agents as AgentMetadata[];
      if (await ensureBootstrapCliAgents(detectedAgents)) {
        const refreshedAgents = await ipcBridge.acpConversation.getAvailableAgents.invoke();
        return Array.isArray(refreshedAgents) ? (refreshedAgents as AgentMetadata[]) : detectedAgents;
      }
      return detectedAgents;
    }
  } catch {
    // fallback to empty
  }
  return [];
}

/**
 * Extract the list of MCP transport types an agent supports.
 *
 * Reads `handshake.agent_capabilities.mcp_capabilities.{stdio,http,sse}`
 * (populated by the ACP init response). Returns `undefined` when the
 * agent has not completed a handshake — callers should treat that as
 * "unknown" rather than "nothing supported".
 */
export function getSupportedMcpTransports(agent: AgentMetadata): string[] | undefined {
  const caps = (agent.handshake?.agent_capabilities as { mcp_capabilities?: unknown } | undefined)?.mcp_capabilities;
  if (!caps || typeof caps !== 'object') {
    return undefined;
  }
  const flags = caps as { stdio?: unknown; http?: unknown; sse?: unknown };
  const transports: string[] = [];
  if (flags.stdio === true) transports.push('stdio');
  if (flags.http === true) transports.push('http');
  if (flags.sse === true) transports.push('sse');
  return transports;
}
