/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server for the agent-company model (Requirement 3.1 — Agent
 * plane).
 *
 * Runs as a standalone stdio process spawned by the MCP client, mirroring
 * `imageGenServer.ts` / `resourceServer.ts`. It exposes a small set of
 * read/safe tools so an agent can shape and inspect a company without driving a
 * live delegation:
 *
 * - `company_create`        — design a company role chart from a free-text
 *   description (criterion 3.11) and persist it.
 * - `company_get_structure` — return the elastic role tree for a company.
 * - `company_list_roles`    — flatten that tree into a role list.
 * - `company_get_rules`     — read a company's user-defined rules (criterion 3.10).
 * - `company_set_rules`     — replace a company's rules (criterion 3.10).
 *
 * `design.md` refers to these capabilities with dotted names (`company.create`,
 * `company.getStructure`, ...); like the image-gen tool (`aionui_image_generation`)
 * we use snake_case here while preserving the intent.
 *
 * ## Process boundary & shared state
 *
 * This server boots in a separate `node` process (not the Electron Main
 * process), so it cannot reach Electron's `app.getPath` or the live Main-process
 * company service singletons. Instead — exactly like `resourceServer.ts` reads
 * the coordinator's persisted `resource-state.json` — it reads/writes the same
 * on-disk `company.json` / memory tree that the {@link companyBridge} (UI plane)
 * uses. The companies data directory is injected through
 * {@link COMPANY_ENV_KEYS.dataDir}; both planes therefore see the *same state*
 * via that shared directory (design note: "cùng một service").
 *
 * The agent/LLM used to design a role chart is configured through the same env
 * mechanism the image-gen server uses for its provider (see
 * {@link COMPANY_ENV_KEYS}); **no model is hardcoded**. When the provider is not
 * configured, `company_create` returns a clear, non-fatal error.
 *
 * NOTE: registering this server (spawn command/args/env) into
 * `builtinMcp/constants.ts` and the bootstrap is Task 15.1; this module only
 * exports the identifiers/env keys that task will wire.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ClientFactory } from '@/common/api/ClientFactory';
import type { TProviderWithModel } from '@/common/config/storage';
import {
  applyRulesToContext,
  createCompanyConfigStore,
  createFromDescription,
  toStructureSpec,
  type CompanyConfig,
  type GenerateFn,
  type ICompanyConfigStore,
} from '@process/company/companyConfig';
import {
  createCompanyOrchestrator,
  type CompanyStructure,
  type CompanyStructureSpec,
  type RoleNode,
  type TeamGateway,
} from '@process/company/companyOrchestrator';
import { ContextLayering } from '@process/company/contextLayering';
import { createMemoryStore } from '@process/company/memoryStore';
import { createCallTemplateManager, createFileCallTemplateStore } from '@process/company/callTemplate';

/** Stable identifier of the built-in Company MCP server (consumed by Task 15.1). */
export const BUILTIN_COMPANY_ID = 'builtin-company';

/** Canonical name of the built-in Company MCP server (consumed by Task 15.1). */
export const BUILTIN_COMPANY_NAME = 'aionui-company';

/**
 * Environment variables the spawning code (Task 15.1) injects into this
 * standalone process. `dataDir` carries the companies data directory (this
 * process cannot reach Electron's `app.getPath`); the remaining keys describe
 * the agent/LLM used to design a role chart — mirroring how the image-gen
 * server receives its provider via env (`imageGenerationMcpEnv.ts`). Kept local
 * (not in `constants.ts`) because this task must not modify that file; Task 15.1
 * may relocate them there.
 */
export const COMPANY_ENV_KEYS = {
  /** Directory holding the per-company `company.json` / memory tree. */
  dataDir: 'AIONUI_COMPANY_DATA_DIR',
  /** Provider platform of the role-chart generator (e.g. `openai`, `anthropic`). */
  platform: 'AIONUI_COMPANY_PLATFORM',
  /** Base URL of the role-chart generator provider. */
  baseUrl: 'AIONUI_COMPANY_BASE_URL',
  /** API key of the role-chart generator provider. */
  apiKey: 'AIONUI_COMPANY_API_KEY',
  /** Model id used to design the role chart. */
  model: 'AIONUI_COMPANY_MODEL',
  /** Optional outbound proxy for the generator provider. */
  proxy: 'AIONUI_COMPANY_PROXY',
} as const;

/**
 * Minimal structural view of a rotating chat client. All three concrete clients
 * (`OpenAIRotatingClient`, `GeminiRotatingClient`, `AnthropicRotatingClient`)
 * expose `createChatCompletion({ model, messages })` returning
 * `{ choices: [{ message: { content } }] }`. We project onto this shape (one
 * cast through `unknown`) to avoid the union-of-signatures call problem without
 * resorting to `any`.
 */
type MinimalChatClient = {
  createChatCompletion(params: { model: string; messages: Array<{ role: string; content: string }> }): Promise<{
    choices: Array<{ message: { content: string | null } }>;
  }>;
};

/** Standard MCP text payload, optionally flagged as an error. */
const textResult = (
  text: string,
  isError = false
): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

/** Resolve the companies data directory, or `undefined` when not injected. */
const companyDataDir = (): string | undefined => process.env[COMPANY_ENV_KEYS.dataDir] || undefined;

/** Build the role-chart generator provider from env, or `null` when unconfigured. */
const getProviderFromEnv = (): TProviderWithModel | null => {
  const platform = process.env[COMPANY_ENV_KEYS.platform];
  const model = process.env[COMPANY_ENV_KEYS.model];
  if (!platform || !model) return null;

  return {
    id: BUILTIN_COMPANY_ID,
    name: BUILTIN_COMPANY_NAME,
    platform,
    base_url: process.env[COMPANY_ENV_KEYS.baseUrl] || '',
    api_key: process.env[COMPANY_ENV_KEYS.apiKey] || '',
    use_model: model,
  };
};

/**
 * Build a {@link GenerateFn} that asks the env-configured provider to design a
 * role chart. The provider/model come entirely from env — nothing is hardcoded.
 */
const buildGenerate =
  (provider: TProviderWithModel): GenerateFn =>
  async (prompt: string): Promise<string> => {
    const proxy = process.env[COMPANY_ENV_KEYS.proxy] || undefined;
    const client = (await ClientFactory.createRotatingClient(provider, { proxy })) as unknown as MinimalChatClient;
    const completion = await client.createChatCompletion({
      model: provider.use_model,
      messages: [{ role: 'user', content: prompt }],
    });
    const content = completion.choices[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  };

/**
 * A {@link TeamGateway} whose every method rejects. Live delegation (spawning
 * agents) is intentionally NOT part of this read/safe MCP surface; the gateway
 * exists only because {@link createCompanyOrchestrator} requires it, and the
 * structure tools call only the pure `createStructure`, which never touches it.
 */
const notWiredTeamGateway: TeamGateway = {
  createTeam: () =>
    Promise.reject(
      new Error('[CompanyMCP] team delegation is not available from the MCP server (read/safe structure tools only).')
    ),
  spawnTeammate: () =>
    Promise.reject(
      new Error('[CompanyMCP] team delegation is not available from the MCP server (read/safe structure tools only).')
    ),
  sendMessage: () =>
    Promise.reject(
      new Error('[CompanyMCP] team delegation is not available from the MCP server (read/safe structure tools only).')
    ),
  awaitResult: () =>
    Promise.reject(
      new Error('[CompanyMCP] team delegation is not available from the MCP server (read/safe structure tools only).')
    ),
};

/** Open a config store rooted at the injected data dir (callers must ensure it exists). */
const openConfigStore = (dataDir: string): ICompanyConfigStore => createCompanyConfigStore({ localRootDir: dataDir });

/**
 * Build the elastic role tree for a spec by reusing the orchestrator's pure
 * `createStructure`. The memory/template stores and team gateway are required by
 * the factory but never exercised by `createStructure`.
 */
const buildStructure = (spec: CompanyStructureSpec, dataDir: string): CompanyStructure => {
  const orchestrator = createCompanyOrchestrator({
    contextLayering: new ContextLayering(),
    memoryStore: createMemoryStore({ companyId: spec.companyId, localRootDir: dataDir }),
    callTemplateManager: createCallTemplateManager({
      probe: () => Promise.reject(new Error('[CompanyMCP] CLI probing is not available from the MCP server.')),
      store: createFileCallTemplateStore({ baseDir: dataDir }),
    }),
    teamGateway: notWiredTeamGateway,
  });
  return orchestrator.createStructure(spec);
};

/** Flatten a role tree into a compact, agent-friendly list. */
const flattenRoles = (
  node: RoleNode
): Array<{ id: string; role: RoleNode['role']; name: string; divisionId?: string }> => [
  { id: node.id, role: node.role, name: node.name, ...(node.divisionId ? { divisionId: node.divisionId } : {}) },
  ...node.children.flatMap(flattenRoles),
];

/** Stringify any caught error for an MCP text payload. */
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function main() {
  const server = new McpServer({
    name: BUILTIN_COMPANY_NAME,
    version: '1.0.0',
  });

  // --- company_create (criterion 3.11) ------------------------------------
  server.tool(
    'company_create',
    `Design an AI agent COMPANY from a free-text description and persist it.

Use this to turn a plain-text idea (e.g. "a team to build a mobile game") into a
company role chart: a President plus divisions ("mảng", e.g. Frontend, Backend, QA),
each with a head and a number of worker agents. The chart is saved as the company's
configuration so it can be inspected and delegated to later.

Input:
- description: the free-text idea to design the company for (required)
- companyId: stable id to save under (optional; defaults to "company")
- presidentName: fallback President name if the design omits one (optional)

Returns the normalised company structure spec as JSON. Requires a generator model to be
configured; if it is not, returns a clear error.`,
    {
      description: z.string().describe('Free-text description of the project/goal to design a company for.'),
      companyId: z.string().optional().describe('Stable company id to persist under. Defaults to "company".'),
      presidentName: z.string().optional().describe('Fallback President name when the design omits one.'),
    },
    async ({ description, companyId, presidentName }) => {
      const provider = getProviderFromEnv();
      if (!provider) {
        return textResult(
          'Error: company generator model not configured. Select a model in Settings so the company MCP can design role charts.',
          true
        );
      }

      try {
        const spec = await createFromDescription(description, {
          generate: buildGenerate(provider),
          companyId,
          presidentName,
        });

        const dataDir = companyDataDir();
        if (dataDir) {
          const store = openConfigStore(dataDir);
          const existing = await store.load(spec.companyId);
          const config: CompanyConfig = {
            ...existing,
            companyId: spec.companyId,
            description,
            presidentName: spec.presidentName ?? existing.presidentName,
            divisions: spec.divisions,
            directWorkerCount: spec.directWorkerCount,
            directDivisionId: spec.directDivisionId,
          };
          await store.save(spec.companyId, config);
        }

        const note = dataDir
          ? ''
          : '\n\n(Note: company data directory was not provided, so the design was not persisted.)';
        return textResult(`${JSON.stringify(spec, null, 2)}${note}`);
      } catch (error) {
        return textResult(`Error designing company: ${describeError(error)}`, true);
      }
    }
  );

  // --- company_get_structure ----------------------------------------------
  server.tool(
    'company_get_structure',
    `Return the elastic role tree of a previously-created company.

Input:
- companyId: the company to inspect (required)

Returns the company structure (President → division heads → workers) as JSON. Requires the
company data directory to be available.`,
    {
      companyId: z.string().describe('Company id to load the structure for.'),
    },
    async ({ companyId }) => {
      const dataDir = companyDataDir();
      if (!dataDir) {
        return textResult(
          'Company data is unavailable: the company data directory was not provided to this server.',
          true
        );
      }
      try {
        const config = await openConfigStore(dataDir).load(companyId);
        const structure = buildStructure(toStructureSpec(config), dataDir);
        return textResult(JSON.stringify(structure, null, 2));
      } catch (error) {
        return textResult(`Error reading company structure: ${describeError(error)}`, true);
      }
    }
  );

  // --- company_list_roles --------------------------------------------------
  server.tool(
    'company_list_roles',
    `List the roles of a company as a flat array (id, role, name, division).

Input:
- companyId: the company to inspect (required)

Returns a JSON array describing every role in the company tree. Requires the company data
directory to be available.`,
    {
      companyId: z.string().describe('Company id to list roles for.'),
    },
    async ({ companyId }) => {
      const dataDir = companyDataDir();
      if (!dataDir) {
        return textResult(
          'Company data is unavailable: the company data directory was not provided to this server.',
          true
        );
      }
      try {
        const config = await openConfigStore(dataDir).load(companyId);
        const structure = buildStructure(toStructureSpec(config), dataDir);
        return textResult(JSON.stringify(flattenRoles(structure.root), null, 2));
      } catch (error) {
        return textResult(`Error listing company roles: ${describeError(error)}`, true);
      }
    }
  );

  // --- company_get_rules (criterion 3.10) ---------------------------------
  server.tool(
    'company_get_rules',
    `Read a company's user-defined rules (e.g. "every plan must be reviewed by the System Architect").

Input:
- companyId: the company to inspect (required)

Returns the rules as a JSON string array. Requires the company data directory to be available.`,
    {
      companyId: z.string().describe('Company id to read rules for.'),
    },
    async ({ companyId }) => {
      const dataDir = companyDataDir();
      if (!dataDir) {
        return textResult(
          'Company data is unavailable: the company data directory was not provided to this server.',
          true
        );
      }
      try {
        const rules = await openConfigStore(dataDir).getRules(companyId);
        return textResult(JSON.stringify(rules, null, 2));
      } catch (error) {
        return textResult(`Error reading company rules: ${describeError(error)}`, true);
      }
    }
  );

  // --- company_set_rules (criterion 3.10) ---------------------------------
  server.tool(
    'company_set_rules',
    `Replace a company's rules. These rules are injected into every downward delegation, so all
agents in the company must follow them.

Input:
- companyId: the company to update (required)
- rules: the full replacement list of rule strings (required)

Returns the saved company configuration as JSON. Requires the company data directory to be available.`,
    {
      companyId: z.string().describe('Company id to update rules for.'),
      rules: z.array(z.string()).describe('Full replacement list of company rule strings.'),
    },
    async ({ companyId, rules }) => {
      const dataDir = companyDataDir();
      if (!dataDir) {
        return textResult(
          'Company data is unavailable: the company data directory was not provided to this server.',
          true
        );
      }
      try {
        const config = await openConfigStore(dataDir).setRules(companyId, rules);
        // Reflect the rules into a fresh context layer so the rendering is consistent
        // with how the orchestrator composes briefings (no persisted side effect here).
        applyRulesToContext(config.rules, new ContextLayering());
        return textResult(JSON.stringify(config, null, 2));
      } catch (error) {
        return textResult(`Error setting company rules: ${describeError(error)}`, true);
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('[CompanyMCP] Fatal error:', error);
  process.exit(1);
});
