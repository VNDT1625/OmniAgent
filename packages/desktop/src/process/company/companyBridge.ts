/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Company IPC bridge — exposes the Main-process agent-company services to the
 * renderer Company UI (Requirement 3.1, Task 4.10).
 *
 * This is an Electron-native bridge (not an aioncore HTTP route), built with the
 * same `@office-ai/platform` `bridge` helper that backs `ipcBridge.ts`. Because
 * `ipcBridge.ts` does not (yet) carry a `company` namespace and this task must
 * not modify it, the typed channels are declared **here** and exported so the
 * renderer (Task 4.10) and the global bootstrap (Task 15.1) can reach them. The
 * channel name constants ({@link COMPANY_CHANNELS}) are the renderer-safe
 * contract — the renderer can build matching `bridge.buildProvider(...).invoke`
 * handles from those names without importing this Node-only module.
 *
 * ## Same service as the Agent plane
 *
 * The design's "hai mặt phẳng" principle requires the UI plane (this bridge) and
 * the Agent plane (`builtinMcp/companyServer.ts`) to see the **same state**. The
 * MCP server runs in a separate `node` process, so the shared source of truth is
 * the on-disk `company.json` tree under the companies data directory (the same
 * mechanism `resourceBridge`/`resourceServer` use via `resource-state.json`).
 * Both planes go through {@link createCompanyConfigStore} rooted at that same
 * directory, so a rule set or company created on one plane is visible to the
 * other.
 *
 * Channels (see {@link COMPANY_CHANNELS}):
 * - `createFromDescription` — design + persist a company from free text (3.11).
 * - `getStructure`          — read the elastic role tree (list structure).
 * - `getRules` / `setRules` — read/replace a company's rules (3.10).
 *
 * The global bootstrap (Task 15.1) is responsible for calling
 * {@link registerCompanyBridge} once during Main-process startup; this module
 * does not wire itself in (mirrors `resourceBridge.ts`).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { httpRequest } from '@/common/adapter/httpBridge';
import { getMcpRegistry } from '@process/resources/mcpRegistry';
import { getAssistantResourceStore } from '@process/resources/nativeAssistantResourceBridge';
import {
  createCompanyConfigStore,
  createFromDescription,
  toStructureSpec,
  type AvailableAgents,
  type CompanyConfig,
  type GenerateFn,
  type ICompanyConfigStore,
} from './companyConfig';
import {
  createCompanyOrchestrator,
  type CompanyStructure,
  type CompanyStructureSpec,
  type RoleAssignment,
  type TeamGateway,
} from './companyOrchestrator';
import { ContextLayering } from './contextLayering';
import { createMemoryStore } from './memoryStore';
import { createCallTemplateManager, createFileCallTemplateStore } from './callTemplate';
import { resolveCompanyModelId } from './companyGenerator';
import {
  createCompanyConversation,
  type ConversationEvent,
  type ICompanyConversation,
  type PermissionDecision,
} from './companyConversation';
import { createCompanyChat } from './companyChat';
import { getResourceCoordinator } from '@process/resource/resourceCoordinator';

// ---------------------------------------------------------------------------
// Channel names (renderer-safe contract — Task 4.10 builds invokers from these)
// ---------------------------------------------------------------------------

/** IPC channel names for the company surface. Safe to import from the renderer. */
export const COMPANY_CHANNELS = {
  createFromDescription: 'company.create-from-description',
  getStructure: 'company.get-structure',
  getRules: 'company.get-rules',
  setRules: 'company.set-rules',
  listAgents: 'company.list-agents',
  setAssignment: 'company.set-assignment',
  acceptDrafts: 'company.accept-drafts',
  updateStructure: 'company.update-structure',
  /** Delete a company on disk (config + memory + call templates). */
  deleteCompany: 'company.delete-company',
  runConversation: 'company.run-conversation',
  resolvePermission: 'company.resolve-permission',
  cancelConversation: 'company.cancel-conversation',
  conversationEvent: 'company.conversation-event',
} as const;

// ---------------------------------------------------------------------------
// Request payloads (responses reuse the company service types)
// ---------------------------------------------------------------------------

/** Request for {@link COMPANY_CHANNELS.createFromDescription}. */
export type CreateFromDescriptionRequest = {
  /** Free-text idea the company should be designed from (criterion 3.11). */
  description: string;
  /** Stable company id to persist under. Defaults to `'company'`. */
  companyId?: string;
  /** Fallback President name when the design omits one. */
  presidentName?: string;
  /**
   * Optional user-authored guidance on which executor is strong at what. Fed
   * into the designer prompt so role assignments honour the user's own
   * capability assessment.
   */
  strengthsGuidance?: string;
};

/** Request carrying just a company id (structure / rules reads). */
export type CompanyIdRequest = {
  /** Company id to address. */
  companyId: string;
};

/** Request for {@link COMPANY_CHANNELS.setRules}. */
export type SetRulesRequest = {
  /** Company id to update. */
  companyId: string;
  /** Full replacement list of company rule strings (criterion 3.10). */
  rules: string[];
};

/** One installed CLI engine in the assignable agent pool. */
export type AgentPoolCli = { id: string; name: string; available: boolean; teamCapable: boolean };
/** One existing AionUi assistant in the assignable agent pool. */
export type AgentPoolAssistant = { id: string; name: string; model?: string; presetAgentType: string };
/** One provider model id usable as an executor model. */
export type AgentPoolModel = { id: string; name: string };
/** One MCP server a role may be granted (user or built-in). */
export type AgentPoolMcp = { id: string; name: string; builtin: boolean };
/** One skill a role may have enabled. */
export type AgentPoolSkill = { name: string; description?: string };
/** One permission/"super" session mode option for a given engine. */
export type AgentPoolMode = { value: string; label: string; engine: string };

/** Response for {@link COMPANY_CHANNELS.listAgents}: the assignable executor pool. */
export type ListAgentsResponse = {
  /** Installed CLI engines. */
  clis: AgentPoolCli[];
  /** Existing assistants (each carries its own model + base engine). */
  assistants: AgentPoolAssistant[];
  /** Base engine ids a draft assistant may run on (`preset_agent_type`). */
  engineIds: string[];
  /** Provider model ids available to assign. */
  models: AgentPoolModel[];
  /** MCP servers (user + built-in) a role may be granted (Requirement 9). */
  mcpServers: AgentPoolMcp[];
  /** Skills a role may have enabled (Requirement 9). */
  skills: AgentPoolSkill[];
  /** Permission/super session modes, grouped by engine (Requirement 9). */
  modes: AgentPoolMode[];
};

/** Request for {@link COMPANY_CHANNELS.setAssignment}. */
export type SetAssignmentRequest = {
  /** Company id to update. */
  companyId: string;
  /** Role node id (`<companyId>:president` or `<companyId>:head:<divisionId>`). */
  roleId: string;
  /** The executor to assign to that role. */
  assignment: RoleAssignment;
};

/** Result for {@link COMPANY_CHANNELS.acceptDrafts}: drafts turned into assistants. */
export type AcceptDraftsResult = {
  /** Number of draft assignments turned into real assistants. */
  created: number;
  /** The updated company config (draft assignments rewritten to `assistant`). */
  config: CompanyConfig;
};

/** One division as edited manually in the UI (structural fields only). */
export type StructureDivisionInput = {
  divisionId: string;
  name: string;
  headName?: string;
  responsibilities?: string;
  workerCount: number;
};

/** Request for {@link COMPANY_CHANNELS.updateStructure}: manual structure edit. */
export type UpdateStructureRequest = {
  /** Company id to update (created if it does not exist yet). */
  companyId: string;
  /** Optional President display name. */
  presidentName?: string;
  /** Full replacement list of divisions (manual edit). */
  divisions: StructureDivisionInput[];
  /** Direct-worker count for the small-company case (no divisions). */
  directWorkerCount?: number;
  /** Division id for the President's direct workers in the small case. */
  directDivisionId?: string;
};

// ---------------------------------------------------------------------------
// Conversation payloads (boss ↔ employee dialogue)
// ---------------------------------------------------------------------------

/** Request for {@link COMPANY_CHANNELS.runConversation}: start a company conversation. */
export type RunConversationBridgeRequest = {
  /** Company id whose structure converses. */
  companyId: string;
  /** The goal the President should drive the company toward. */
  goal: string;
  /** Model id to run the agents with (optional; provider picks a default). */
  model?: string;
  /** Max direct reports the President delegates to this run (optional). */
  maxDelegations?: number;
};

/** Result of {@link COMPANY_CHANNELS.runConversation}. */
export type RunConversationBridgeResult = {
  /** Stable id of the started/finished run. */
  runId: string;
  /** The President's final summary (empty when stopped/errored). */
  summary: string;
  /** How the run ended. */
  status: 'done' | 'stopped' | 'error';
};

/** Request for {@link COMPANY_CHANNELS.resolvePermission}: the boss's decision. */
export type ResolvePermissionRequest = {
  /** The permission request being answered. */
  requestId: string;
  /** Whether the boss grants it. */
  approved: boolean;
  /** Optional note from the boss. */
  note?: string;
};

/** Request for {@link COMPANY_CHANNELS.cancelConversation}. */
export type CancelConversationRequest = {
  /** Run id to cancel. */
  runId: string;
};

/**
 * Envelope wrapping a streamed {@link ConversationEvent} for the
 * `conversationEvent` emitter. Boxing the discriminated union in a single-prop
 * object keeps the platform `buildEmitter<Params>` from distributing the union
 * and collapsing `emit`/`on` to `never` (same trick as `browserBridge`).
 */
export type ConversationEventEnvelope = {
  /** The streamed conversation event. */
  event: ConversationEvent;
};

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/**
 * Every company channel resolves with this envelope rather than rejecting.
 *
 * The `@office-ai/platform` bridge only forwards a provider's **resolved** value
 * back to the renderer — a thrown error or rejected promise is swallowed and the
 * renderer's `invoke()` never settles (an infinite spinner). To make failures
 * observable instead of hanging, every handler is wrapped so it ALWAYS resolves:
 * `{ ok: true, data }` on success, `{ ok: false, error, code }` on failure.
 *
 * `code: 'no-model'` flags the specific "no usable model configured" case so the
 * UI can show a targeted hint (open Settings → Model).
 */
export type CompanyResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: 'no-model' | 'error' };

/** Typed company IPC channels. Exported for Task 15.1 registration wiring. */
export const companyChannels = {
  createFromDescription: bridge.buildProvider<CompanyResult<CompanyConfig>, CreateFromDescriptionRequest>(
    COMPANY_CHANNELS.createFromDescription
  ),
  getStructure: bridge.buildProvider<CompanyResult<CompanyStructure>, CompanyIdRequest>(COMPANY_CHANNELS.getStructure),
  getRules: bridge.buildProvider<CompanyResult<string[]>, CompanyIdRequest>(COMPANY_CHANNELS.getRules),
  setRules: bridge.buildProvider<CompanyResult<CompanyConfig>, SetRulesRequest>(COMPANY_CHANNELS.setRules),
  listAgents: bridge.buildProvider<CompanyResult<ListAgentsResponse>, void>(COMPANY_CHANNELS.listAgents),
  setAssignment: bridge.buildProvider<CompanyResult<CompanyConfig>, SetAssignmentRequest>(
    COMPANY_CHANNELS.setAssignment
  ),
  acceptDrafts: bridge.buildProvider<CompanyResult<AcceptDraftsResult>, CompanyIdRequest>(
    COMPANY_CHANNELS.acceptDrafts
  ),
  updateStructure: bridge.buildProvider<CompanyResult<CompanyConfig>, UpdateStructureRequest>(
    COMPANY_CHANNELS.updateStructure
  ),
  deleteCompany: bridge.buildProvider<CompanyResult<{ deleted: boolean }>, CompanyIdRequest>(
    COMPANY_CHANNELS.deleteCompany
  ),
  runConversation: bridge.buildProvider<CompanyResult<RunConversationBridgeResult>, RunConversationBridgeRequest>(
    COMPANY_CHANNELS.runConversation
  ),
  resolvePermission: bridge.buildProvider<CompanyResult<{ resolved: boolean }>, ResolvePermissionRequest>(
    COMPANY_CHANNELS.resolvePermission
  ),
  cancelConversation: bridge.buildProvider<CompanyResult<void>, CancelConversationRequest>(
    COMPANY_CHANNELS.cancelConversation
  ),
  /** Main → renderer push of live conversation events (transcript + status board). */
  conversationEvent: bridge.buildEmitter<ConversationEventEnvelope>(COMPANY_CHANNELS.conversationEvent),
};

// ---------------------------------------------------------------------------
// Shared company services (one instance for the whole Main process)
// ---------------------------------------------------------------------------

/**
 * The Main-process company services the bridge operates on. Kept small and
 * injectable so tests (and Task 15.1) can supply alternatives; production uses
 * the lazily-constructed defaults from {@link getCompanyServices}.
 */
export type CompanyServices = {
  /** Persistent per-company `company.json` store (rules + structure metadata). */
  configStore: ICompanyConfigStore;
  /** Shared company-wide context layer (rules are mirrored into it on update). */
  contextLayering: ContextLayering;
  /** Build the elastic role tree for a spec (pure; reuses the orchestrator). */
  buildStructure: (spec: CompanyStructureSpec) => CompanyStructure;
  /**
   * The in-process conversation engine driving boss ↔ employee dialogue
   * (Requirement 3 "Phần 2"). Optional so tests / partial bootstraps can omit
   * it; when absent the conversation channels return a clear "not available"
   * error instead of hanging.
   */
  conversation?: ICompanyConversation;
};

/**
 * A {@link TeamGateway} whose methods reject. Live delegation is not part of the
 * bridge surface; the gateway exists only because
 * {@link createCompanyOrchestrator} requires one, and the bridge calls only the
 * pure `createStructure`, which never touches it.
 */
const notWiredTeamGateway: TeamGateway = {
  createTeam: () => Promise.reject(new Error('[CompanyBridge] team delegation is not exposed by the company bridge.')),
  spawnTeammate: () =>
    Promise.reject(new Error('[CompanyBridge] team delegation is not exposed by the company bridge.')),
  sendMessage: () => Promise.reject(new Error('[CompanyBridge] team delegation is not exposed by the company bridge.')),
  awaitResult: () => Promise.reject(new Error('[CompanyBridge] team delegation is not exposed by the company bridge.')),
};

/** Lazily-built default services, shared across repeated registrations. */
let defaultServices: CompanyServices | undefined;

/**
 * Resolve the shared {@link CompanyServices}, constructing the default
 * implementation on first use.
 *
 * The config store and memory store resolve their on-disk root lazily from the
 * Electron `userData` directory (see `companyConfig.ts` / `memoryStore.ts`), so
 * no Electron `app` access happens at import time. `buildStructure` calls only
 * the orchestrator's pure `createStructure`; the memory store, call-template
 * store, and team gateway it wires are required by the factory but never
 * exercised here.
 */
export const getCompanyServices = (): CompanyServices => {
  if (defaultServices) return defaultServices;

  const configStore = createCompanyConfigStore();
  const contextLayering = new ContextLayering();

  const buildStructure = (spec: CompanyStructureSpec): CompanyStructure => {
    const orchestrator = createCompanyOrchestrator({
      contextLayering,
      memoryStore: createMemoryStore({ companyId: spec.companyId }),
      callTemplateManager: createCallTemplateManager({
        probe: () => Promise.reject(new Error('[CompanyBridge] CLI probing is not exposed by the company bridge.')),
        // baseDir is only consulted when a template is read/written, which
        // createStructure never does; an empty base keeps construction cheap.
        store: createFileCallTemplateStore({ baseDir: '' }),
      }),
      teamGateway: notWiredTeamGateway,
    });
    return orchestrator.createStructure(spec);
  };

  // The live boss ↔ employee conversation engine. Runs in-process (calls the
  // user's configured model via companyChat) and leases each agent turn through
  // the ResourceCoordinator so a busy company does not overload the machine.
  const conversation = createCompanyConversation({
    chat: createCompanyChat(),
    coordinator: getResourceCoordinator(),
  });

  defaultServices = { configStore, contextLayering, buildStructure, conversation };
  return defaultServices;
};

/**
 * Fetch the assignable executor pool from aioncore: installed CLI engines
 * (`/api/agents`), existing assistants (`/api/assistants`), and provider models
 * (`/api/providers`). Defensive — any endpoint failure degrades to an empty
 * list so the company UI still loads.
 */
const fetchAgentPool = async (): Promise<ListAgentsResponse> => {
  type RawAgent = {
    id?: string;
    name?: string;
    backend?: string;
    agent_type?: string;
    available?: boolean;
    team_capable?: boolean;
  };
  type RawAssistant = { id?: string; name?: string; models?: string[]; preset_agent_type?: string; enabled?: boolean };
  type RawProvider = { models?: string[]; enabled?: boolean };

  const [agents, assistants, providers] = await Promise.all([
    httpRequest<RawAgent[]>('GET', '/api/agents').catch((): RawAgent[] => []),
    httpRequest<RawAssistant[]>('GET', '/api/assistants').catch((): RawAssistant[] => []),
    httpRequest<RawProvider[]>('GET', '/api/providers').catch((): RawProvider[] => []),
  ]);

  const clis: AgentPoolCli[] = (agents || [])
    .filter((a) => typeof a.id === 'string' && a.id.length > 0)
    .map((a) => ({
      id: a.id as string,
      name: a.name || (a.id as string),
      available: a.available !== false,
      teamCapable: a.team_capable === true,
    }));

  const assistantList: AgentPoolAssistant[] = (assistants || [])
    .filter((a) => typeof a.id === 'string' && a.id.length > 0 && a.enabled !== false)
    .map((a) => ({
      id: a.id as string,
      name: a.name || (a.id as string),
      model: Array.isArray(a.models) && a.models.length > 0 ? a.models[0] : undefined,
      presetAgentType: a.preset_agent_type || 'claude',
    }));

  // Engine ids a draft may run on: CLI agent_type/backend/id, de-duplicated.
  const engineIds = Array.from(
    new Set(
      (agents || []).flatMap((a) =>
        [a.agent_type, a.backend, a.id].filter((v): v is string => typeof v === 'string' && v.length > 0)
      )
    )
  );
  if (engineIds.length === 0) engineIds.push('claude');

  const models: AgentPoolModel[] = Array.from(
    new Set(
      (providers || [])
        .flatMap((p) => (Array.isArray(p.models) ? p.models : []))
        .filter((m): m is string => typeof m === 'string' && m.length > 0)
    )
  ).map((id) => ({ id, name: id }));

  // MCP servers (user + built-in) and skills the user may grant to a role
  // (Requirement 9). Both are best-effort: a failed fetch degrades to empty so
  // the company UI still loads.
  type RawMcp = { id?: string; name?: string; builtin?: boolean };
  type RawSkill = { name?: string; description?: string };
  const [mcpRaw, skillRaw] = await Promise.all([
    getMcpRegistry()
      .list()
      .catch((): RawMcp[] => []),
    httpRequest<RawSkill[]>('GET', '/api/skills').catch((): RawSkill[] => []),
  ]);
  const mcpServers: AgentPoolMcp[] = (mcpRaw || [])
    .filter((m) => typeof m.id === 'string' && m.id.length > 0)
    .map((m) => ({ id: m.id as string, name: m.name || (m.id as string), builtin: m.builtin === true }));
  const skills: AgentPoolSkill[] = (skillRaw || [])
    .filter((s) => typeof s.name === 'string' && s.name.length > 0)
    .map((s) => ({ name: s.name as string, description: s.description }));

  // Permission/super session modes per engine (mirrors renderer agentModes.ts;
  // inlined here because that helper is a renderer module). Only engines present
  // in the detected pool are surfaced.
  const modes = buildModePool(engineIds);

  return { clis, assistants: assistantList, engineIds, models, mcpServers, skills, modes };
};

/** Static permission/super mode table per engine (mirror of renderer `AGENT_MODES`). */
const ENGINE_MODES: Record<string, Array<{ value: string; label: string }>> = {
  claude: [
    { value: 'default', label: 'Default' },
    { value: 'acceptEdits', label: 'Accept Edits' },
    { value: 'plan', label: 'Plan' },
    { value: 'bypassPermissions', label: 'YOLO (bypass permissions)' },
  ],
  codex: [
    { value: 'read-only', label: 'Read Only' },
    { value: 'default', label: 'Default' },
    { value: 'full-access', label: 'Full Access' },
  ],
  qwen: [
    { value: 'default', label: 'Default' },
    { value: 'yolo', label: 'YOLO' },
  ],
  gemini: [
    { value: 'default', label: 'Default' },
    { value: 'autoEdit', label: 'Auto-Accept Edits' },
    { value: 'yolo', label: 'YOLO' },
  ],
  cursor: [
    { value: 'agent', label: 'Agent' },
    { value: 'plan', label: 'Plan' },
    { value: 'ask', label: 'Ask' },
  ],
  aionrs: [
    { value: 'default', label: 'Default' },
    { value: 'auto_edit', label: 'Auto-Accept Edits' },
    { value: 'yolo', label: 'YOLO' },
  ],
  deepseek: [
    { value: 'default', label: 'Default' },
    { value: 'acceptEdits', label: 'Accept Edits' },
    { value: 'yolo', label: 'YOLO' },
  ],
  antigravity: [
    { value: 'default', label: 'Default' },
    { value: 'yolo', label: 'YOLO' },
  ],
};

/** Build the flat mode pool for every engine present in the detected pool. */
const buildModePool = (engineIds: string[]): AgentPoolMode[] => {
  const out: AgentPoolMode[] = [];
  const seen = new Set<string>();
  for (const engine of engineIds) {
    const modes = ENGINE_MODES[engine];
    if (!modes) continue;
    for (const m of modes) {
      const key = `${engine}:${m.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ value: m.value, label: m.label, engine });
    }
  }
  return out;
};

/** Map the executor pool to the compact {@link AvailableAgents} the generator expects. */
const toAvailableAgents = (pool: ListAgentsResponse): AvailableAgents => ({
  clis: pool.clis.map((c) => ({ id: c.id, name: c.name })),
  assistants: pool.assistants.map((a) => ({ id: a.id, name: a.name, model: a.model })),
  engineIds: pool.engineIds,
  models: pool.models.map((m) => m.id),
  mcpServers: pool.mcpServers.map((m) => ({ id: m.id, name: m.name })),
  skills: pool.skills.map((s) => s.name),
  modes: Array.from(new Set(pool.modes.map((m) => m.value))),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Options for {@link registerCompanyBridge}. */
export type RegisterCompanyBridgeOptions = {
  /** Override the shared company services (tests / bootstrap). Defaults to {@link getCompanyServices}. */
  services?: CompanyServices;
  /**
   * The agent/LLM call used by `createFromDescription` to design a role chart
   * (criterion 3.11). Injected so no model is hardcoded.
   *
   * TODO(15.1): wire this to the real agent/conversation mechanism during global
   * bootstrap. When omitted, `createFromDescription` returns a clear error
   * instead of designing a company.
   */
  generate?: GenerateFn;
};

/**
 * Register the company IPC handlers.
 *
 * Idempotent: calling it again re-registers the providers (the underlying
 * `bridge` replaces the handler bound to each channel). Intended to be invoked
 * once during Main-process bootstrap (Task 15.1).
 *
 * @param options Optional injected services and the role-chart `generate` fn.
 */
export function registerCompanyBridge(options: RegisterCompanyBridgeOptions = {}): void {
  const services = options.services ?? getCompanyServices();
  const { configStore, contextLayering, buildStructure } = services;

  /** Detect the "no usable model" error so the UI can show a targeted hint. */
  const classify = (error: unknown): 'no-model' | 'error' => {
    const message = error instanceof Error ? error.message : String(error);
    return /no usable model|requires a generator|not wired|no model/i.test(message) ? 'no-model' : 'error';
  };

  /**
   * Wrap a handler so it ALWAYS resolves with a {@link CompanyResult}. The
   * platform bridge swallows rejected promises (hanging the renderer), so every
   * failure is converted into `{ ok: false, error }` and logged here.
   */
  const safe =
    <Req, Res>(label: string, handler: (req: Req) => Promise<Res>) =>
    async (req: Req): Promise<CompanyResult<Res>> => {
      try {
        return { ok: true, data: await handler(req) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[CompanyBridge] ${label} failed:`, error);
        return { ok: false, error: message, code: classify(error) };
      }
    };

  // Design + persist a company from a free-text description (criterion 3.11).
  companyChannels.createFromDescription.provider(
    safe('createFromDescription', async ({ description, companyId, presidentName, strengthsGuidance }) => {
      if (!options.generate) {
        throw new Error('[CompanyBridge] createFromDescription requires a generator (no usable model configured).');
      }
      // Give the designer the real executor pool so it assigns CLIs/assistants
      // that actually exist, or proposes drafts when nothing fits.
      const pool = await fetchAgentPool().catch(
        (): ListAgentsResponse => ({
          clis: [],
          assistants: [],
          engineIds: ['claude'],
          models: [],
          mcpServers: [],
          skills: [],
          modes: [],
        })
      );
      const spec = await createFromDescription(description, {
        generate: options.generate,
        companyId,
        presidentName,
        availableAgents: toAvailableAgents(pool),
        strengthsGuidance,
      });
      const existing = await configStore.load(spec.companyId);
      // Merge designed rules with any rules the company already had (designed
      // rules win on duplicates). This is the fix for "Tạo bằng mô tả không set
      // được Quy tắc công ty" — rules stated in the description are now honoured.
      const mergedRules = Array.from(new Set([...(spec.rules ?? []), ...(existing.rules ?? [])]));
      // A "create from description" is a FRESH design: the structure, president,
      // division, and worker assignments come entirely from the new spec — we do
      // NOT inherit the previous company's assignments. Inheriting them was the
      // bug behind "re-create with the same id keeps the OLD president/structure"
      // (especially when the old company was not deleted first). Only the rules
      // are merged (above), because rules are user policy, not generated wiring.
      const config: CompanyConfig = {
        companyId: spec.companyId,
        description,
        presidentName: spec.presidentName,
        divisions: spec.divisions,
        directWorkerCount: spec.directWorkerCount,
        directDivisionId: spec.directDivisionId,
        presidentAssignment: spec.presidentAssignment,
        rules: mergedRules,
      };
      await configStore.save(spec.companyId, config);
      // Mirror the rules into the shared context layer so they ride along with
      // every downward delegation (matches setRules behaviour).
      if (mergedRules.length > 0) {
        contextLayering.setCompanyContext({ ...contextLayering.getCompanyContext(), rules: mergedRules });
      }
      return config;
    })
  );

  // Read the elastic role tree (list structure) for a company, annotated with
  // the model that powers its agents (display only).
  companyChannels.getStructure.provider(
    safe('getStructure', async ({ companyId }) => {
      const config = await configStore.load(companyId);
      const structure = buildStructure(toStructureSpec(config));
      const poweredByModel = await resolveCompanyModelId().catch((): string | undefined => undefined);
      return poweredByModel ? { ...structure, poweredByModel } : structure;
    })
  );

  // Read a company's user-defined rules (criterion 3.10).
  companyChannels.getRules.provider(safe('getRules', ({ companyId }) => configStore.getRules(companyId)));

  // Replace a company's rules and mirror them into the shared context layer so
  // they ride along with every downward delegation (criterion 3.10).
  companyChannels.setRules.provider(
    safe('setRules', async ({ companyId, rules }) => {
      const config = await configStore.setRules(companyId, rules);
      contextLayering.setCompanyContext({ ...contextLayering.getCompanyContext(), rules: config.rules });
      return config;
    })
  );

  // List the assignable executor pool (CLIs + assistants + models).
  companyChannels.listAgents.provider(safe('listAgents', () => fetchAgentPool()));

  // Assign an executor (CLI / assistant / draft) to one role.
  companyChannels.setAssignment.provider(
    safe('setAssignment', async ({ companyId, roleId, assignment }) => {
      const config = await configStore.load(companyId);
      const presidentId = `${companyId}:president`;
      const headPrefix = `${companyId}:head:`;
      const workerPrefix = `${companyId}:worker:`;
      if (roleId === presidentId) {
        config.presidentAssignment = assignment;
      } else if (roleId.startsWith(headPrefix)) {
        const divisionId = roleId.slice(headPrefix.length);
        const division = config.divisions.find((d) => d.divisionId === divisionId);
        if (!division) {
          throw new Error(`[CompanyBridge] setAssignment: unknown role "${roleId}" for company "${companyId}".`);
        }
        division.assignment = assignment;
      } else if (roleId.startsWith(workerPrefix)) {
        // Workers are generated from workerCount, so their assignment lives in a
        // side map keyed by the worker node id.
        config.workerAssignments = { ...config.workerAssignments, [roleId]: assignment };
      } else {
        throw new Error(`[CompanyBridge] setAssignment: unknown role "${roleId}" for company "${companyId}".`);
      }
      await configStore.save(companyId, config);
      return config;
    })
  );

  // Turn every draft assignment into a real assistant (batch accept), then
  // rewrite those assignments to point at the freshly-created assistants.
  companyChannels.acceptDrafts.provider(
    safe('acceptDrafts', async ({ companyId }) => {
      const config = await configStore.load(companyId);

      const draftRoles: Array<{ assignment: RoleAssignment; apply: (a: RoleAssignment) => void }> = [];
      if (config.presidentAssignment?.kind === 'draft') {
        draftRoles.push({ assignment: config.presidentAssignment, apply: (a) => (config.presidentAssignment = a) });
      }
      for (const division of config.divisions) {
        if (division.assignment?.kind === 'draft') {
          const d = division;
          draftRoles.push({ assignment: d.assignment, apply: (a) => (d.assignment = a) });
        }
      }
      // Worker draft assignments (keyed by worker node id in the side map).
      if (config.workerAssignments) {
        for (const [workerId, assignment] of Object.entries(config.workerAssignments)) {
          if (assignment?.kind === 'draft') {
            const wid = workerId;
            draftRoles.push({ assignment, apply: (a) => ((config.workerAssignments ??= {})[wid] = a) });
          }
        }
      }

      let created = 0;
      // Resolve the set of real, installed engine ids once so a draft's
      // LLM-proposed `presetAgentType` can be clamped to something runnable.
      // An assistant created with a non-existent engine id is unrunnable
      // (aioncore: "ACP agent requires either agent_id or backend in extra").
      const pool = await fetchAgentPool().catch(
        (): ListAgentsResponse => ({
          clis: [],
          assistants: [],
          engineIds: ['claude'],
          models: [],
          mcpServers: [],
          skills: [],
          modes: [],
        })
      );
      const availableEngineIds = new Set(pool.engineIds);
      const firstRunnableEngine = pool.clis.find((c) => c.available)?.id ?? pool.engineIds[0] ?? 'claude';
      const clampEngine = (engine: string | undefined): string =>
        engine && availableEngineIds.has(engine) ? engine : firstRunnableEngine;

      for (const role of draftRoles) {
        const draft = role.assignment.draft;
        if (!draft) continue;
        try {
          const body = {
            name: draft.name,
            preset_agent_type: clampEngine(draft.presetAgentType),
            ...(draft.model ? { models: [draft.model] } : {}),
            ...(Array.isArray(draft.skills) && draft.skills.length > 0 ? { enabled_skills: draft.skills } : {}),
          };
          const assistant = await httpRequest<{ id?: string; name?: string }>('POST', '/api/assistants', body);
          const newId = assistant && typeof assistant.id === 'string' ? assistant.id : undefined;
          if (!newId) throw new Error('assistant create returned no id');
          // Persist the proposed rules as the assistant's rule file (best-effort).
          if (draft.rules && draft.rules.trim().length > 0) {
            await getAssistantResourceStore()
              .write({ assistant_id: newId, locale: 'en-US', content: draft.rules }, 'rule')
              .catch((): undefined => undefined);
          }
          role.apply({ kind: 'assistant', refId: newId, label: draft.name, model: draft.model });
          created += 1;
        } catch (error) {
          console.warn(`[CompanyBridge] acceptDrafts: failed to create assistant "${draft.name}":`, error);
        }
      }

      if (created > 0) await configStore.save(companyId, config);
      return { created, config };
    })
  );

  // Manually edit the company structure (add/remove/rename divisions, change
  // worker counts) while preserving rules + existing executor assignments for
  // divisions/workers that still exist.
  companyChannels.updateStructure.provider(
    safe('updateStructure', async ({ companyId, presidentName, divisions, directWorkerCount, directDivisionId }) => {
      const config = await configStore.load(companyId);

      // De-duplicate division ids and merge with existing assignments.
      const usedIds = new Set<string>();
      const nextDivisions = divisions.map((d) => {
        const baseId = (d.divisionId || d.name || 'division').trim();
        let id = baseId;
        let suffix = 2;
        while (usedIds.has(id)) {
          id = `${baseId}-${suffix}`;
          suffix += 1;
        }
        usedIds.add(id);
        const existing = config.divisions.find((e) => e.divisionId === id);
        return {
          divisionId: id,
          name: d.name || id,
          workerCount: Math.max(0, Math.floor(d.workerCount || 0)),
          ...(d.headName ? { headName: d.headName } : {}),
          ...(d.responsibilities ? { responsibilities: d.responsibilities } : {}),
          ...(existing?.assignment ? { assignment: existing.assignment } : {}),
        };
      });

      // Prune worker assignments whose worker no longer exists.
      const validWorkerIds = new Set<string>();
      if (nextDivisions.length === 0) {
        const did = directDivisionId ?? 'general';
        const count = Math.max(1, directWorkerCount ?? 2);
        for (let i = 0; i < count; i++) validWorkerIds.add(`${companyId}:worker:${did}:${i}`);
      } else {
        for (const d of nextDivisions) {
          for (let i = 0; i < d.workerCount; i++) validWorkerIds.add(`${companyId}:worker:${d.divisionId}:${i}`);
        }
      }
      const prunedWorkers: Record<string, RoleAssignment> = {};
      for (const [wid, a] of Object.entries(config.workerAssignments ?? {})) {
        if (validWorkerIds.has(wid)) prunedWorkers[wid] = a;
      }

      config.presidentName = presidentName ?? config.presidentName;
      config.divisions = nextDivisions;
      config.directWorkerCount = directWorkerCount;
      config.directDivisionId = directDivisionId;
      config.workerAssignments = Object.keys(prunedWorkers).length > 0 ? prunedWorkers : undefined;

      await configStore.save(companyId, config);
      return config;
    })
  );

  // Permanently delete a company (entire `<root>/<companyId>/` folder). The
  // renderer pairs this with forgetting the local roster id so the list and the
  // disk stay consistent. Recreating with the same id afterwards starts fresh —
  // no stale rules / assignments / role-conversation mappings linger.
  companyChannels.deleteCompany.provider(
    safe('deleteCompany', async ({ companyId }) => configStore.deleteCompany(companyId))
  );

  // -------------------------------------------------------------------------
  // Conversation handlers (boss ↔ employee dialogue, permission gate)
  // -------------------------------------------------------------------------

  const conversation = services.conversation;

  // Run a company conversation: the President briefs its direct reports, they
  // reply (asking permission when needed), and the President summarises. Live
  // steps stream through the `conversationEvent` emitter; this resolves with the
  // final summary. Never hangs — model/permission failures surface as events.
  companyChannels.runConversation.provider(
    safe('runConversation', async ({ companyId, goal, model, maxDelegations }) => {
      if (!conversation) {
        throw new Error('[CompanyBridge] Conversation engine is not available (not wired).');
      }
      const config = await configStore.load(companyId);
      const structure = buildStructure(toStructureSpec(config));
      const rules = await configStore.getRules(companyId).catch((): string[] => []);
      let finalSummary = '';
      let finalStatus: 'done' | 'stopped' | 'error' = 'done';
      const runId = await conversation.run(
        { structure, companyName: companyId, rules, goal, model, maxDelegations },
        (event) => {
          if (event.type === 'run-finished') {
            finalSummary = event.summary;
            finalStatus = event.status;
          } else if (event.type === 'run-error') {
            finalStatus = 'error';
          }
          companyChannels.conversationEvent.emit({ event });
        }
      );
      return { runId, summary: finalSummary, status: finalStatus };
    })
  );

  // Answer a pending permission request (boss authority — approve / deny).
  companyChannels.resolvePermission.provider(
    safe('resolvePermission', ({ requestId, approved, note }: ResolvePermissionRequest) => {
      if (!conversation) throw new Error('[CompanyBridge] Conversation engine is not available (not wired).');
      const decision: PermissionDecision = { requestId, approved, note };
      return Promise.resolve({ resolved: conversation.resolvePermission(decision) });
    })
  );

  // Cancel an in-flight conversation run (best-effort, cooperative).
  companyChannels.cancelConversation.provider(
    safe('cancelConversation', ({ runId }: CancelConversationRequest) => {
      conversation?.cancel(runId);
      return Promise.resolve();
    })
  );
}

/**
 * Reset the lazily-built default services. Useful for deterministic teardown
 * (tests, hot-reload); registered providers remain bound to their channels.
 */
export function disposeCompanyBridge(): void {
  defaultServices = undefined;
}
