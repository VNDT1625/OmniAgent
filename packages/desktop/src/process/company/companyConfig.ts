/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-company configuration for the agent-company model (Requirement 3,
 * criteria 3.10 & 3.11).
 *
 * This module owns the `company.json` file described in `design.md` (Yêu cầu 3 —
 * "trí nhớ dạng file"):
 *
 * ```
 * <userData>/companies/<companyId>/company.json
 *   → { name, description, rules, divisions, ... }
 * ```
 *
 * It covers two acceptance criteria:
 *
 * - **3.10 — Company rules.** Each company carries a user-defined list of
 *   `rules` (e.g. "every plan must be reviewed by the System Architect
 *   division"). They are persisted in `company.json` and, via
 *   {@link applyRulesToContext}, written into the {@link ContextLayering}
 *   company layer so the orchestrator's `buildDelegationContext` includes them
 *   in every worker briefing.
 * - **3.11 — Create a company from a free-text description.** {@link createFromDescription}
 *   asks an injected agent/LLM to turn a plain-text idea into a role chart, then
 *   parses and defensively normalises that output into a {@link CompanyStructureSpec}
 *   that feeds straight into `companyOrchestrator.createStructure`.
 *
 * ## Relationship to the orchestrator
 *
 * This file is intentionally **self-contained**: it never imports the
 * orchestrator's runtime, only its *types* ({@link CompanyStructureSpec},
 * {@link DivisionSpec}). The orchestrator can later consume {@link toStructureSpec}
 * / {@link createFromDescription} (which return a `CompanyStructureSpec`) and
 * {@link applyRulesToContext} (which mutates a {@link ContextLayering} instance)
 * during wiring without this module depending on it.
 *
 * ## Testability
 *
 * The filesystem layer ({@link CompanyConfigFs}) and the root directory
 * (`localRootDir`) are injectable so tests can target a temp dir (or an
 * in-memory fs) without touching real disk or a live Electron `app`. The atomic
 * write-to-tmp-then-rename strategy (and `mode: 0o600`) mirrors
 * `memoryStore.ts` / `resourceState.ts`. The role-chart generator
 * ({@link GenerateFn}) is injected too, so no real model is hardcoded.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CompanyStructureSpec,
  DivisionSpec,
  RoleAssignment,
  RoleAssignmentDraft,
  RoleAssignmentKind,
} from './companyOrchestrator';
import type { CompanyContext, ContextLayering } from './contextLayering';

/** Name of the directory (under the data root) holding per-company folders. */
const COMPANIES_DIR = 'companies';
/** Name of the per-company configuration file. */
const COMPANY_CONFIG_FILE = 'company.json';

/**
 * Upper bound on workers per division applied when normalising a generated role
 * chart, so a malformed/over-eager model response cannot request an absurd
 * number of agents. The resource coordinator still governs how many actually
 * run in parallel (criterion 3.12); this is only an input-sanitisation cap.
 */
const MAX_WORKERS_PER_DIVISION = 50;

/** Worker count assigned to a division when the model omits or mis-types it. */
const DEFAULT_WORKER_COUNT = 1;

/** Company id used by {@link createFromDescription} when the caller omits one. */
const DEFAULT_COMPANY_ID = 'company';

// ---------------------------------------------------------------------------
// Config shape
// ---------------------------------------------------------------------------

/**
 * The full configuration persisted to `company.json` for one company.
 *
 * Carries the user-defined company {@link CompanyConfig.rules} (criterion 3.10)
 * plus the structural metadata needed to rebuild a {@link CompanyStructureSpec}
 * (the divisions and their worker counts) via {@link toStructureSpec}.
 */
export type CompanyConfig = {
  /** Company id; also used to derive the on-disk folder and node ids. */
  companyId: string;
  /** Optional human-readable company name. */
  name?: string;
  /** Optional free-text description (e.g. the prompt it was created from). */
  description?: string;
  /** Optional President display name passed through to `createStructure`. */
  presidentName?: string;
  /**
   * User-defined company-wide rules (criterion 3.10). Every agent must follow
   * them; {@link applyRulesToContext} pushes them into the shared context layer.
   */
  rules: string[];
  /**
   * Divisions ("mảng") of the company. Empty = small company (President manages
   * a flat pool of workers directly); non-empty = full hierarchy.
   */
  divisions: DivisionSpec[];
  /** Direct-worker count for the small-company case. See {@link CompanyStructureSpec}. */
  directWorkerCount?: number;
  /** Division id assigned to the President's direct workers in the small case. */
  directDivisionId?: string;
  /** Executor assigned to the President role (CLI / assistant / draft). */
  presidentAssignment?: RoleAssignment;
  /** Per-worker executor assignments, keyed by worker node id. */
  workerAssignments?: Record<string, RoleAssignment>;
};

/**
 * Build a fresh, empty {@link CompanyConfig} for `companyId` — no rules, no
 * divisions. Returned by {@link ICompanyConfigStore.load} when no file exists.
 */
export const emptyCompanyConfig = (companyId: string): CompanyConfig => ({ companyId, rules: [], divisions: [] });

/**
 * Project a {@link CompanyConfig} onto a {@link CompanyStructureSpec} so it can
 * be fed straight into `companyOrchestrator.createStructure`. Only the
 * structural fields are carried over; the rules travel separately through
 * {@link applyRulesToContext}.
 */
export const toStructureSpec = (config: CompanyConfig): CompanyStructureSpec => ({
  companyId: config.companyId,
  presidentName: config.presidentName,
  divisions: config.divisions,
  directWorkerCount: config.directWorkerCount,
  directDivisionId: config.directDivisionId,
  presidentAssignment: config.presidentAssignment,
  workerAssignments: config.workerAssignments,
});

// ---------------------------------------------------------------------------
// Filesystem layer (injectable, mirrors memoryStore.ts / resourceState.ts)
// ---------------------------------------------------------------------------

/**
 * Minimal subset of `fs/promises` used by this module. Declared explicitly so
 * tests can supply an in-memory implementation without pulling in all of `fs`.
 */
export type CompanyConfigFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  /** Recursively remove a directory; tolerate ENOENT (caller handles "did exist"). */
  rm(dirPath: string, options: { recursive: true; force: true }): Promise<void>;
};

/** Default file-system adapter backed by Node's `fs/promises`. */
export const defaultCompanyConfigFs: CompanyConfigFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
  rm: (dirPath, options) => fs.promises.rm(dirPath, options),
};

/** Options for {@link createCompanyConfigStore}. Both fields default sensibly. */
export type CompanyConfigStoreOptions = {
  /**
   * Root directory holding the per-company folders. Defaults to
   * `<userData>/companies`. Inject a temp dir in tests. Resolved lazily so
   * callers that always inject it never depend on a live Electron `app`.
   */
  localRootDir?: string;
  /** File-system implementation. Injectable for tests; defaults to `fs/promises`. */
  fs?: CompanyConfigFs;
};

// ---------------------------------------------------------------------------
// Safe-id guard + defensive value coercion (no `any`)
// ---------------------------------------------------------------------------

/** Characters / sequences that would let an id escape the companies directory. */
const UNSAFE_ID_PATTERN = /[/\\]|\.\./;

/**
 * Guard against path traversal: a `companyId` must not contain path separators
 * or `..`, otherwise it could read/write outside the companies tree.
 */
const assertSafeCompanyId = (companyId: string): void => {
  if (companyId.length === 0 || UNSAFE_ID_PATTERN.test(companyId)) {
    throw new Error(
      `[Company] Invalid companyId ${JSON.stringify(companyId)}: must be non-empty and contain no path separators or "..".`
    );
  }
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** Type guard: a parsed JSON value is a plain (non-array) object. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Returns `value` when it is a string, otherwise `undefined`. */
const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Returns a trimmed non-empty string, otherwise `undefined`. */
const asNonEmptyString = (value: unknown): string | undefined => {
  const text = asString(value)?.trim();
  return text && text.length > 0 ? text : undefined;
};

/** Returns `value` when it is a finite number, otherwise `undefined`. */
const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Coerce arbitrary input into a clean `string[]`: keep trimmed, non-empty entries. */
const sanitiseRules = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const rules: string[] = [];
  for (const entry of value) {
    const rule = asNonEmptyString(entry);
    if (rule) rules.push(rule);
  }
  return rules;
};

/** Lower-cases and dashes a name into a slug usable as a `divisionId`. */
const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Clamp a (possibly missing) worker count into `[0, MAX_WORKERS_PER_DIVISION]`. */
const clampWorkerCount = (value: unknown, max: number): number => {
  const n = asFiniteNumber(value);
  if (n === undefined) return DEFAULT_WORKER_COUNT;
  return Math.min(Math.max(0, Math.floor(n)), max);
};

/** Valid {@link RoleAssignmentKind} values, for defensive parsing. */
const ASSIGNMENT_KINDS: readonly RoleAssignmentKind[] = ['cli', 'assistant', 'draft'];

/** Defensively coerce a parsed draft sub-object into a {@link RoleAssignmentDraft}. */
const normaliseDraft = (value: unknown): RoleAssignmentDraft | undefined => {
  if (!isRecord(value)) return undefined;
  const name = asNonEmptyString(value.name);
  const presetAgentType = asNonEmptyString(value.presetAgentType) ?? asNonEmptyString(value.preset_agent_type);
  if (!name || !presetAgentType) return undefined;
  const draft: RoleAssignmentDraft = { name, presetAgentType };
  const model = asNonEmptyString(value.model);
  if (model) draft.model = model;
  const rules = asNonEmptyString(value.rules);
  if (rules) draft.rules = rules;
  if (Array.isArray(value.skills)) {
    const skills = value.skills.map(asNonEmptyString).filter((s): s is string => Boolean(s));
    if (skills.length > 0) draft.skills = skills;
  }
  return draft;
};

/**
 * Defensively coerce a parsed assignment object into a {@link RoleAssignment},
 * or `undefined` when it has no usable shape. Never throws.
 */
const normaliseAssignment = (value: unknown): RoleAssignment | undefined => {
  if (!isRecord(value)) return undefined;
  const kindRaw = asNonEmptyString(value.kind);
  const kind = (kindRaw && (ASSIGNMENT_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : undefined) as
    | RoleAssignmentKind
    | undefined;
  if (!kind) return undefined;

  const draft = normaliseDraft(value.draft);
  // A draft assignment must carry a draft payload; fall back to it for refId/label.
  const refId =
    asNonEmptyString(value.refId) ?? (kind === 'draft' && draft ? slugify(draft.name) || 'draft' : undefined);
  if (!refId) return undefined;
  const label = asNonEmptyString(value.label) ?? (draft ? draft.name : refId);

  const assignment: RoleAssignment = { kind, refId, label };
  // A CLI manages its own model — the company-level model only applies to the
  // `aionrs` backend. Dropping it for `cli` avoids showing/persisting a bogus
  // model id (e.g. one the designer invented) next to a CLI role.
  const model = kind === 'cli' ? undefined : (asNonEmptyString(value.model) ?? draft?.model);
  if (model) assignment.model = model;
  if (kind === 'draft' && draft) assignment.draft = draft;
  const capabilities = normaliseCapabilities(value.capabilities);
  if (capabilities) assignment.capabilities = capabilities;
  return assignment;
};

/** Coerce a string array (drop non-strings / empties / dups). */
const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const s = asNonEmptyString(entry);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
};

/** Normalise a role's capabilities block (MCP / skills / session mode); undefined when empty. */
const normaliseCapabilities = (value: unknown) => {
  if (!isRecord(value)) return undefined;
  const mcpServerIds = asStringArray(value.mcpServerIds);
  const skills = asStringArray(value.skills);
  const sessionMode = asNonEmptyString(value.sessionMode);
  if (mcpServerIds.length === 0 && skills.length === 0 && !sessionMode) return undefined;
  return {
    ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(sessionMode ? { sessionMode } : {}),
  };
};

// ---------------------------------------------------------------------------
// Config validation / normalisation
// ---------------------------------------------------------------------------

/** Normalise one parsed division entry, or `undefined` if it has no usable name/id. */
const normaliseDivision = (value: unknown, usedIds: Set<string>, max: number): DivisionSpec | undefined => {
  if (!isRecord(value)) return undefined;
  const name = asNonEmptyString(value.name) ?? asNonEmptyString(value.divisionId);
  if (!name) return undefined;

  // Prefer an explicit divisionId; otherwise derive a slug from the name.
  let divisionId = asNonEmptyString(value.divisionId);
  if (divisionId) divisionId = slugify(divisionId);
  if (!divisionId) divisionId = slugify(name);
  if (!divisionId) divisionId = 'division';

  // De-duplicate ids so each division maps to a distinct context key.
  let uniqueId = divisionId;
  let suffix = 2;
  while (usedIds.has(uniqueId)) {
    uniqueId = `${divisionId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(uniqueId);

  const division: DivisionSpec = {
    divisionId: uniqueId,
    name,
    workerCount: clampWorkerCount(value.workerCount, max),
  };
  const headName = asNonEmptyString(value.headName);
  if (headName) division.headName = headName;
  const responsibilities = asNonEmptyString(value.responsibilities);
  if (responsibilities) division.responsibilities = responsibilities;
  const assignment = normaliseAssignment(value.assignment);
  if (assignment) division.assignment = assignment;
  return division;
};

/** Normalise an arbitrary list of parsed divisions into clean {@link DivisionSpec}s. */
const normaliseDivisions = (value: unknown, max: number): DivisionSpec[] => {
  if (!Array.isArray(value)) return [];
  const usedIds = new Set<string>();
  const divisions: DivisionSpec[] = [];
  for (const entry of value) {
    const division = normaliseDivision(entry, usedIds, max);
    if (division) divisions.push(division);
  }
  return divisions;
};

/**
 * Coerce an arbitrary parsed JSON value into a valid {@link CompanyConfig},
 * filling defaults for anything missing or malformed. Never throws — a corrupt
 * file degrades to an empty config so a fresh one can take over.
 */
const coerceConfig = (companyId: string, value: unknown): CompanyConfig => {
  const base = emptyCompanyConfig(companyId);
  if (!isRecord(value)) return base;

  const config: CompanyConfig = {
    ...base,
    rules: sanitiseRules(value.rules),
    divisions: normaliseDivisions(value.divisions, MAX_WORKERS_PER_DIVISION),
  };

  const name = asNonEmptyString(value.name);
  if (name) config.name = name;
  const description = asNonEmptyString(value.description);
  if (description) config.description = description;
  const presidentName = asNonEmptyString(value.presidentName);
  if (presidentName) config.presidentName = presidentName;

  const directWorkerCount = asFiniteNumber(value.directWorkerCount);
  if (directWorkerCount !== undefined) config.directWorkerCount = Math.max(0, Math.floor(directWorkerCount));
  const directDivisionId = asNonEmptyString(value.directDivisionId);
  if (directDivisionId) config.directDivisionId = directDivisionId;
  const presidentAssignment = normaliseAssignment(value.presidentAssignment);
  if (presidentAssignment) config.presidentAssignment = presidentAssignment;
  if (isRecord(value.workerAssignments)) {
    const workers: Record<string, RoleAssignment> = {};
    for (const [workerId, raw] of Object.entries(value.workerAssignments)) {
      const assignment = normaliseAssignment(raw);
      if (assignment) workers[workerId] = assignment;
    }
    if (Object.keys(workers).length > 0) config.workerAssignments = workers;
  }

  return config;
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Persistent store for per-company `company.json` files. Each method addresses
 * a company by its `companyId`; the store itself is not scoped to one company.
 */
export type ICompanyConfigStore = {
  /** Read `company.json` for a company; returns an empty config if none exists. */
  load(companyId: string): Promise<CompanyConfig>;
  /** Overwrite `company.json` for a company (atomic). */
  save(companyId: string, config: CompanyConfig): Promise<void>;
  /** Set the company rules (criterion 3.10) and persist; returns the saved config. */
  setRules(companyId: string, rules: string[]): Promise<CompanyConfig>;
  /** Read just the company rules (criterion 3.10). */
  getRules(companyId: string): Promise<string[]>;
  /**
   * Permanently remove a company from disk (the entire `<root>/<companyId>/`
   * folder, recursively — config, memory, call templates, soul/memory files).
   * Resolves to `{ deleted }` indicating whether something was actually removed
   * (false means the folder did not exist). Never throws on a missing folder.
   */
  deleteCompany(companyId: string): Promise<{ deleted: boolean }>;
};

/**
 * Create a {@link ICompanyConfigStore}.
 *
 * Resolution of the on-disk root is lazy: the Electron `userData` directory is
 * only read when no `localRootDir` override is supplied, so callers (and tests)
 * that inject a directory never depend on a live Electron `app`.
 *
 * @param options Store configuration. All fields are optional.
 * @returns A store that reads/writes `company.json` for any company id.
 */
export const createCompanyConfigStore = (options: CompanyConfigStoreOptions = {}): ICompanyConfigStore => {
  const fsImpl = options.fs ?? defaultCompanyConfigFs;

  /** Resolve the directory that contains the per-company folders. */
  const resolveCompaniesRoot = (): string => options.localRootDir ?? path.join(app.getPath('userData'), COMPANIES_DIR);

  /** Resolve the absolute path to a company's `company.json`. */
  const resolveConfigPath = (companyId: string): string => {
    assertSafeCompanyId(companyId);
    return path.join(resolveCompaniesRoot(), companyId, COMPANY_CONFIG_FILE);
  };

  /**
   * Atomically write `content` to `filePath`: write a sibling `.tmp` file then
   * rename it into place so a process kill mid-write cannot leave a corrupt
   * file (mirrors `resourceState.ts` / `memoryStore.ts`).
   */
  const writeFileAtomic = async (filePath: string, content: string): Promise<void> => {
    const dir = path.dirname(filePath);
    const tmpPath = `${filePath}.tmp`;
    await fsImpl.mkdir(dir, { recursive: true });
    await fsImpl.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, filePath);
  };

  const load: ICompanyConfigStore['load'] = async (companyId) => {
    const filePath = resolveConfigPath(companyId);
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      // Stamp the requested companyId so the returned config is authoritative
      // even if the on-disk file carries a stale/foreign id.
      return coerceConfig(companyId, parsed);
    } catch (error) {
      if (!isFileNotFound(error)) {
        console.warn(`[Company] Failed to read company.json for "${companyId}"; using empty config:`, error);
      }
      return emptyCompanyConfig(companyId);
    }
  };

  const save: ICompanyConfigStore['save'] = async (companyId, config) => {
    const filePath = resolveConfigPath(companyId);
    // Persist a normalised view stamped with the canonical companyId.
    const normalised = coerceConfig(companyId, { ...config, companyId });
    const payload = JSON.stringify(normalised, null, 2) + '\n';
    await writeFileAtomic(filePath, payload);
  };

  const setRules: ICompanyConfigStore['setRules'] = async (companyId, rules) => {
    const current = await load(companyId);
    const next: CompanyConfig = { ...current, rules: sanitiseRules(rules) };
    await save(companyId, next);
    return next;
  };

  const getRules: ICompanyConfigStore['getRules'] = async (companyId) => {
    const config = await load(companyId);
    return config.rules;
  };

  const deleteCompany: ICompanyConfigStore['deleteCompany'] = async (companyId) => {
    assertSafeCompanyId(companyId);
    const dir = path.join(resolveCompaniesRoot(), companyId);
    // Probe before delete so callers can distinguish "not found" from "removed"
    // and surface a useful message. ENOENT on the probe means nothing to delete.
    let existed = false;
    try {
      await fsImpl.readFile(path.join(dir, COMPANY_CONFIG_FILE), 'utf-8');
      existed = true;
    } catch (error) {
      if (!isFileNotFound(error)) existed = true; // some other read error: try delete anyway
    }
    try {
      await fsImpl.rm(dir, { recursive: true, force: true });
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    return { deleted: existed };
  };

  return { load, save, setRules, getRules, deleteCompany };
};

// ---------------------------------------------------------------------------
// Company rules → delegation context (criterion 3.10)
// ---------------------------------------------------------------------------

/**
 * Inject company rules into the shared context layer so they ride along with
 * every downward delegation (criterion 3.10).
 *
 * The orchestrator's `buildDelegationContext` renders `CompanyContext.rules`
 * into every worker's briefing; setting them here is therefore enough to make
 * the rules appear in all delegations. Existing shared items on the company
 * layer are preserved — only the `rules` field is replaced.
 *
 * This is a standalone helper that *consumes* a {@link ContextLayering} instance
 * (it calls the instance's getter/setter); it holds no state of its own.
 *
 * @param rules           The company rules to apply (sanitised: trimmed, no empties).
 * @param contextLayering The context-layering instance to update in place.
 */
export const applyRulesToContext = (rules: string[], contextLayering: ContextLayering): void => {
  const current: CompanyContext = contextLayering.getCompanyContext();
  contextLayering.setCompanyContext({ ...current, rules: sanitiseRules(rules) });
};

// ---------------------------------------------------------------------------
// Create a company from a free-text description (criterion 3.11)
// ---------------------------------------------------------------------------

/**
 * Injected agent/LLM call that turns a prompt into raw text. Kept abstract so no
 * concrete model is hardcoded; production wiring supplies a real CLI/agent call.
 *
 * @param prompt The fully-composed instruction (see {@link buildRoleChartPrompt}).
 * @returns The model's raw textual response (expected to contain a JSON object).
 */
export type GenerateFn = (prompt: string) => Promise<string>;

/** Compact view of the executors available when designing a company. */
export type AvailableAgents = {
  /** Installed CLI engines (id + display name). */
  clis: Array<{ id: string; name: string }>;
  /** Existing AionUi assistants (id + name + optional model). */
  assistants: Array<{ id: string; name: string; model?: string }>;
  /** Valid base-engine ids a draft assistant may run on (`preset_agent_type`). */
  engineIds: string[];
  /** Provider model ids actually configured in the app (the ONLY ids a role may use). */
  models?: string[];
  /** MCP servers (id + name) a role may be granted as a capability. */
  mcpServers?: Array<{ id: string; name: string }>;
  /** Skill names a role may have enabled as a capability. */
  skills?: string[];
  /** Permission/super session mode ids a role may run in. */
  modes?: string[];
};

/** Options for {@link createFromDescription}. */
export type CreateFromDescriptionOptions = {
  /** The injected role-chart generator (agent/LLM). Required. */
  generate: GenerateFn;
  /** Company id for the produced spec. Defaults to {@link DEFAULT_COMPANY_ID}. */
  companyId?: string;
  /** Fallback President name if the model omits one. */
  presidentName?: string;
  /** Override the per-division worker cap used while normalising. */
  maxWorkersPerDivision?: number;
  /** Executors the model may assign (CLIs + assistants). Defaults to empty. */
  availableAgents?: AvailableAgents;
  /**
   * Free-text guidance, authored by the user, on which executor is strong at
   * what (e.g. "Claude excels at refactoring; the local shell CLI is best for
   * file ops"). Injected verbatim into the designer prompt so the AI honours the
   * user's own capability assessment when assigning executors to roles. Empty /
   * omitted = no guidance added.
   */
  strengthsGuidance?: string;
};

/**
 * Compose the instruction handed to {@link GenerateFn}. Asks the agent to design
 * a company role chart for the user's description and to reply with a single
 * JSON object in a fixed schema, so the response can be parsed deterministically.
 *
 * When `availableAgents` is provided, the model is told which CLIs/assistants
 * exist so it can REUSE them (by exact id) for each role, or PROPOSE a draft
 * assistant when nothing fits.
 *
 * When `strengthsGuidance` is provided, the user's own assessment of which
 * executor is strong at what is injected verbatim and the model is told to
 * weigh it heavily when matching executors to roles.
 */
export const buildRoleChartPrompt = (
  description: string,
  availableAgents?: AvailableAgents,
  strengthsGuidance?: string
): string => {
  const pool = availableAgents ?? { clis: [], assistants: [], engineIds: [] };
  const cliList = pool.clis.length > 0 ? pool.clis.map((c) => `${c.id} (${c.name})`).join(', ') : '(none)';
  const assistantList =
    pool.assistants.length > 0
      ? pool.assistants.map((a) => `${a.id} (${a.name}${a.model ? `, model ${a.model}` : ''})`).join(', ')
      : '(none)';
  const engineList = pool.engineIds.length > 0 ? pool.engineIds.join(', ') : 'claude';
  const modelList = pool.models && pool.models.length > 0 ? pool.models.join(', ') : '(none configured)';
  const mcpList =
    pool.mcpServers && pool.mcpServers.length > 0
      ? pool.mcpServers.map((m) => `${m.id} (${m.name})`).join(', ')
      : '(none)';
  const skillList = pool.skills && pool.skills.length > 0 ? pool.skills.join(', ') : '(none)';
  const modeList = pool.modes && pool.modes.length > 0 ? pool.modes.join(', ') : '(none)';

  const guidance = strengthsGuidance?.trim();
  const guidanceBlock = guidance
    ? [
        '',
        "USER'S EXECUTOR-STRENGTH GUIDANCE (authored by the user — treat as authoritative and weigh it heavily when matching executors to roles):",
        guidance,
      ]
    : [];

  return [
    'You are an organisation designer for an AI agent company.',
    'Given a free-text description of a project or goal, design a fitting company role chart.',
    'Split the work into divisions ("mảng", e.g. Frontend, Backend, QA) and choose how many worker agents each division needs.',
    ...guidanceBlock,
    '',
    'AVAILABLE EXECUTORS you may assign to each role:',
    `- CLI agents (use one of these ids for a "cli" assignment): ${cliList}`,
    `- Existing assistants (use one of these ids for an "assistant" assignment): ${assistantList}`,
    `- Base engine ids for a NEW draft assistant (preset_agent_type): ${engineList}`,
    '',
    `CONFIGURED MODELS (the ONLY model ids you may use — never invent a model id; for a "cli" assignment, OMIT "model" entirely so the CLI uses its own configured model): ${modelList}`,
    '',
    'AVAILABLE CAPABILITIES you may grant to each role (so its agent can actually do the job):',
    `- MCP tool servers (ids): ${mcpList}`,
    `- Skills (names): ${skillList}`,
    `- Permission/super session modes (values): ${modeList}`,
    '',
    'For the president and each division head, add an "assignment" describing which executor runs that role:',
    '- Reuse an existing assistant when one fits: { "kind": "assistant", "refId": "<assistant id>", "label": "<assistant name>", "model": "<optional model>" }',
    '- Or reuse a CLI engine: { "kind": "cli", "refId": "<cli id>", "label": "<cli name>", "model": "<optional model>" }',
    '- Or, if nothing fits, propose a NEW draft assistant: { "kind": "draft", "refId": "<short slug>", "label": "<assistant name>", "model": "<model>", "draft": { "name": "<assistant name>", "presetAgentType": "<one base engine id>", "model": "<model>", "rules": "<short markdown instructions/persona>", "skills": ["<skill>", ...] } }',
    'Pick the model based on the task difficulty, not seniority. For a "cli" assignment do NOT set "model" (the CLI manages its own model). Only set "model" to one of the CONFIGURED MODELS ids above, never a made-up one.',
    'When a role needs special abilities to do its job, add a "capabilities" object to its assignment, granting ONLY what that role needs:',
    '  "capabilities": { "mcpServerIds": ["<mcp id>", ...], "skills": ["<skill name>", ...], "sessionMode": "<one mode value>" }',
    '- Example: a role that must browse the web should get the browser MCP server; a role that edits Office files should get the relevant office skill; a role doing sensitive automation may need a higher session mode (e.g. YOLO/full-access). Grant high session modes sparingly.',
    'Only use ids/names/values from the AVAILABLE CAPABILITIES lists above. Omit "capabilities" entirely for roles that need nothing special.',
    '',
    'Reply with ONLY a single JSON object, no prose and no markdown fences, matching exactly this shape:',
    '{',
    '  "name": string,                // short company name',
    '  "presidentName": string,       // optional, name of the president role',
    '  "presidentAssignment": object, // optional, an assignment object as described above',
    '  "rules": string[],             // company-wide rules every agent must follow (criterion 3.10); derive these from any rules/policies stated in the description (approvals, testing gates, sensitive-action permissions, coding standards). Empty array if none.',
    '  "divisions": [                 // one entry per division/mảng',
    '    { "divisionId": string,      // short slug, e.g. "frontend"',
    '      "name": string,            // human-readable division name',
    '      "headName": string,        // optional, division head title',
    '      "responsibilities": string,// one sentence: what this division is responsible for',
    '      "assignment": object,      // optional, an assignment object as described above',
    '      "workerCount": number }    // how many worker agents (>= 0)',
    '  ],',
    '  "directWorkerCount": number,   // optional, workers if there are no divisions',
    '  "directDivisionId": string     // optional, division id for those direct workers',
    '}',
    '',
    'Description:',
    description,
  ].join('\n');
};

/**
 * Extract the first balanced top-level JSON object substring from `raw`.
 *
 * Models often wrap JSON in prose or ```json fences; this scans for the first
 * `{` and returns through its matching `}` (respecting strings/escapes), so the
 * surrounding noise is ignored. Returns `undefined` if no object is found.
 */
const extractJsonObject = (raw: string): string | undefined => {
  const start = raw.indexOf('{');
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return undefined;
};

/**
 * Create a {@link CompanyStructureSpec} from a free-text description by asking an
 * injected agent to design a role chart (criterion 3.11).
 *
 * The agent's raw output is scanned for a JSON object, parsed, and defensively
 * normalised: unusable divisions are dropped, ids are slugified and de-duped,
 * and worker counts are clamped. If the model returns no valid divisions the
 * result is a small-company spec (President + direct workers), which
 * `createStructure` handles natively. The returned spec feeds straight into
 * `companyOrchestrator.createStructure`.
 *
 * @param description Free-text idea typed by the user.
 * @param options     Injected {@link GenerateFn} plus optional id/name/cap overrides.
 * @returns A normalised {@link CompanyStructureSpec}.
 * @throws If the agent's response contains no parseable JSON object.
 */
export const createFromDescription = async (
  description: string,
  options: CreateFromDescriptionOptions
): Promise<CompanyStructureSpec> => {
  const companyId = options.companyId ?? DEFAULT_COMPANY_ID;
  const maxWorkers = options.maxWorkersPerDivision ?? MAX_WORKERS_PER_DIVISION;

  const prompt = buildRoleChartPrompt(description, options.availableAgents, options.strengthsGuidance);
  const response = await options.generate(prompt);

  const jsonText = extractJsonObject(response);
  if (!jsonText) {
    throw new Error('[Company] createFromDescription: agent response contained no JSON object to parse.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `[Company] createFromDescription: failed to parse agent JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  const record = isRecord(parsed) ? parsed : {};
  const spec: CompanyStructureSpec = {
    companyId,
    divisions: normaliseDivisions(record.divisions, maxWorkers),
  };

  const presidentName = asNonEmptyString(record.presidentName) ?? options.presidentName;
  if (presidentName) spec.presidentName = presidentName;
  const presidentAssignment = normaliseAssignment(record.presidentAssignment);
  if (presidentAssignment) spec.presidentAssignment = presidentAssignment;

  const directWorkerCount = asFiniteNumber(record.directWorkerCount);
  if (directWorkerCount !== undefined) spec.directWorkerCount = Math.max(0, Math.floor(directWorkerCount));
  const directDivisionId = asNonEmptyString(record.directDivisionId);
  if (directDivisionId) spec.directDivisionId = slugify(directDivisionId) || directDivisionId;

  // Company-wide rules the designer derived from the description (criterion 3.10).
  const rules = sanitiseRules(record.rules);
  if (rules.length > 0) spec.rules = rules;

  return spec;
};
