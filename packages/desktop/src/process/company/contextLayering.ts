/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Layered context for the agent-company model (Requirement 3 — "Mô hình công ty
 * tác nhân", criteria 3.8 and 3.9).
 *
 * Context is split into two composable layers:
 *
 * 1. **Company-wide shared layer** ({@link CompanyContext}) — common rules and a
 *    handful of shared items that every agent in the company can see
 *    (criterion 3.8, first half).
 * 2. **Per-division layer** ({@link DivisionContext}) — context owned/held by the
 *    head of a division ("mảng", e.g. Frontend, Backend). Only the division and
 *    its head carry this context (criterion 3.8, second half).
 *
 * When a superior delegates work *down* to a worker ("tay chân") agent, the
 * division's context is composed together with the company layer and the task
 * prompt, then handed to the worker as a single payload (criterion 3.9). The
 * payload is modelled on the existing Team-Mode **`mailbox`** message (see the
 * `mailbox` table in `docs/CODEBASE_GUIDE.md` §19) so it can be passed through
 * the same async messaging channel used by Team Mode.
 *
 * Invariant — workers hold no private memory: {@link ContextLayering} stores
 * **no per-worker / per-agent state whatsoever**. Worker context exists only at
 * delegation time, inside the value returned by {@link ContextLayering.buildDelegationContext}.
 * That method is a pure function of the company layer, the addressed division
 * layer, and the request; it performs no writes and keeps nothing keyed by the
 * receiving agent. This is what Property 7 (task 4.5) validates.
 *
 * Process boundary: this is a Main-process (Node.js) module. It uses no DOM APIs
 * and intentionally has **no imports** from sibling company services
 * (`memoryStore.ts`, `callTemplate.ts`) so it stays independent while those are
 * built in parallel — any memory type it needs is defined locally below.
 */

/**
 * A single key/value piece of shared knowledge. Used both for company-wide
 * shared items and for division-private items. Plain data only (strings) so the
 * whole layering structure can be cloned and serialised trivially.
 */
export type SharedItem = {
  /** Stable, human-meaningful key (e.g. `coding-style`, `repo-url`). */
  key: string;
  /** The value associated with the key. */
  value: string;
};

/**
 * The company-wide shared layer, visible to **every** agent (criterion 3.8).
 *
 * Holds the company rules (criterion 3.10 — e.g. "every plan must be reviewed by
 * the System Architect division") and a small set of shared knowledge items.
 */
export type CompanyContext = {
  /** Company-wide rules every agent must follow. */
  rules: string[];
  /** Shared knowledge items visible to every agent. */
  sharedItems: SharedItem[];
};

/**
 * Per-division ("mảng") context held by the division head (criterion 3.8).
 *
 * Only the division and its head carry this; it is attached to a worker solely
 * at delegation time via {@link ContextLayering.buildDelegationContext}.
 */
export type DivisionContext = {
  /** Stable identifier of the division (mảng). */
  divisionId: string;
  /** Human-readable division name (e.g. `Frontend`, `Backend`). */
  name: string;
  /** ID of the division-head agent that owns/holds this context. */
  headAgentId: string;
  /** Division-private context items held by the division head. */
  items: SharedItem[];
};

/**
 * Shape accepted by {@link ContextLayering.setDivisionContext}. The
 * `divisionId` is supplied separately as the first argument, so it is omitted
 * here to keep the call site unambiguous and avoid a mismatch between the two.
 */
export type DivisionContextInput = Omit<DivisionContext, 'divisionId'>;

/**
 * A Team-Mode mailbox message (mirrors the `mailbox` table — see
 * `docs/CODEBASE_GUIDE.md` §19). Reused here as the transport for delegating
 * context + task to a worker agent (criterion 3.9). Defined locally rather than
 * imported so this module stays independent of the backend layer.
 */
export type MailboxMessage = {
  /** Recipient agent ID (the worker). May be empty until the orchestrator assigns one. */
  toAgentId: string;
  /** Sender agent ID — defaults to the division head. */
  fromAgentId: string;
  /** Message type. Reuses the existing `'message'` mailbox type. */
  type: 'message';
  /** Full composed payload (company layer + division layer + task) handed to the worker. */
  content: string;
  /** Short summary for the mailbox listing. */
  summary: string;
};

/**
 * Request describing a single downward delegation (superior → worker).
 */
export type DelegationRequest = {
  /** The division whose context should be attached to the worker. */
  divisionId: string;
  /** The task description / prompt for the worker to execute. */
  taskPrompt: string;
  /**
   * Receiving worker agent ID. Optional: a context-composition utility does not
   * need to know the concrete worker; the orchestrator may fill this in later.
   */
  toAgentId?: string;
  /** Sender agent ID. Defaults to the addressed division's `headAgentId`. */
  fromAgentId?: string;
};

/**
 * The composed delegation payload returned by
 * {@link ContextLayering.buildDelegationContext}.
 *
 * It exposes both the structured layers (snapshots, for inspection/testing) and
 * the ready-to-send {@link MailboxMessage}. Everything here is a fresh value;
 * mutating it never affects the {@link ContextLayering} instance it came from.
 */
export type DelegationContext = {
  /** Snapshot of the company-wide shared layer at build time. */
  company: CompanyContext;
  /** Snapshot of the addressed division's layer at build time. */
  division: DivisionContext;
  /** The task prompt, unchanged from the request. */
  taskPrompt: string;
  /** Human-readable rendering of all layers + task (the worker's full briefing). */
  renderedPrompt: string;
  /** Mailbox message carrying {@link DelegationContext.renderedPrompt} to the worker. */
  mailbox: MailboxMessage;
};

/** Optional seed state for constructing a {@link ContextLayering} instance. */
export type ContextLayeringInit = {
  /** Initial company-wide shared layer. Defaults to empty rules + items. */
  company?: CompanyContext;
  /** Initial set of division contexts. */
  divisions?: DivisionContext[];
};

/** Returns an empty company context (no rules, no shared items). */
const emptyCompanyContext = (): CompanyContext => ({ rules: [], sharedItems: [] });

/**
 * Deep-clones plain data (strings / arrays / objects only). Used to defensively
 * copy context in and out so that callers can never mutate the instance's
 * internal state, and so the {@link DelegationContext} payload is fully detached
 * from the layers it was composed from. Safe here because every context type is
 * plain serialisable data with no functions, dates, or cycles.
 */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Renders a list of {@link SharedItem}s as `- key: value` lines. */
const renderItems = (items: readonly SharedItem[]): string =>
  items.map((item) => `- ${item.key}: ${item.value}`).join('\n');

/** Renders a list of rules as `- rule` lines. */
const renderRules = (rules: readonly string[]): string => rules.map((rule) => `- ${rule}`).join('\n');

/**
 * Composes the company layer, division layer, and task prompt into a single
 * human-readable briefing. Deterministic: the same inputs always produce the
 * same text (no timestamps, no ordering surprises).
 */
const renderDelegationPrompt = (company: CompanyContext, division: DivisionContext, taskPrompt: string): string => {
  const sections: string[] = [];

  sections.push('# Company Rules', company.rules.length > 0 ? renderRules(company.rules) : '(none)');
  sections.push(
    '# Company Shared Knowledge',
    company.sharedItems.length > 0 ? renderItems(company.sharedItems) : '(none)'
  );
  sections.push(
    `# Division Context: ${division.name} (${division.divisionId})`,
    division.items.length > 0 ? renderItems(division.items) : '(none)'
  );
  sections.push('# Task', taskPrompt);

  return sections.join('\n\n');
};

/** Builds a short, single-line mailbox summary for a delegation. */
const buildSummary = (division: DivisionContext): string =>
  `Task delegated to ${division.name} (${division.divisionId})`;

/**
 * Service that holds the company-wide shared layer and the per-division layers,
 * and composes them into delegation payloads for worker agents.
 *
 * State held: exactly one {@link CompanyContext} plus a map of
 * {@link DivisionContext} keyed by `divisionId`. **No per-worker state** is ever
 * stored — see the module-level invariant.
 */
export class ContextLayering {
  /** Company-wide shared layer, visible to every agent. */
  private company: CompanyContext;
  /** Per-division layers, keyed by `divisionId`. Held on behalf of division heads. */
  private readonly divisions: Map<string, DivisionContext>;

  /**
   * @param init Optional seed company context and divisions. Both are cloned on
   * the way in so the caller's objects cannot mutate internal state.
   */
  constructor(init: ContextLayeringInit = {}) {
    this.company = init.company ? clone(init.company) : emptyCompanyContext();
    this.divisions = new Map();
    for (const division of init.divisions ?? []) {
      this.divisions.set(division.divisionId, clone(division));
    }
  }

  /**
   * Replaces the company-wide shared layer (criterion 3.8). The input is cloned
   * so later mutations by the caller do not leak into the instance.
   */
  setCompanyContext(context: CompanyContext): void {
    this.company = clone(context);
  }

  /**
   * Returns a defensive copy of the company-wide shared layer. Mutating the
   * result never affects the instance.
   */
  getCompanyContext(): CompanyContext {
    return clone(this.company);
  }

  /**
   * Sets (or replaces) the context for a division, held on behalf of its head
   * (criterion 3.8). The `divisionId` argument is authoritative and is stamped
   * onto the stored context.
   *
   * @param divisionId Stable identifier of the division (mảng).
   * @param context    The division's name, head agent, and private items.
   */
  setDivisionContext(divisionId: string, context: DivisionContextInput): void {
    this.divisions.set(divisionId, clone({ divisionId, ...context }));
  }

  /**
   * Returns a defensive copy of a division's context, or `undefined` if the
   * division is unknown. Mutating the result never affects the instance.
   */
  getDivisionContext(divisionId: string): DivisionContext | undefined {
    const found = this.divisions.get(divisionId);
    return found ? clone(found) : undefined;
  }

  /** Returns the ids of all registered divisions. */
  listDivisions(): string[] {
    return [...this.divisions.keys()];
  }

  /**
   * Removes a division's context.
   *
   * @returns `true` if a division was removed, `false` if it did not exist.
   */
  removeDivisionContext(divisionId: string): boolean {
    return this.divisions.delete(divisionId);
  }

  /**
   * Composes the company layer + the addressed division layer + the task into a
   * single payload for a worker agent (criterion 3.9), wrapped in a
   * {@link MailboxMessage} for transport.
   *
   * This method is **pure with respect to workers**: it only *reads* the
   * company and division layers, writes nothing, and stores no state keyed by
   * the receiving agent. Worker context therefore exists only in the returned
   * value and is never persisted on the instance — the worker keeps no private
   * memory (Property 7 / criteria 3.3, 3.4, 3.9). The returned value is fully
   * detached (deep-cloned snapshots) from the instance's internal state.
   *
   * @throws If `divisionId` does not match any registered division — work cannot
   * be delegated down a division without that division's context.
   */
  buildDelegationContext(req: DelegationRequest): DelegationContext {
    const division = this.divisions.get(req.divisionId);
    if (!division) {
      throw new Error(`Cannot build delegation context: unknown division '${req.divisionId}'`);
    }

    const companySnapshot = clone(this.company);
    const divisionSnapshot = clone(division);
    const renderedPrompt = renderDelegationPrompt(companySnapshot, divisionSnapshot, req.taskPrompt);

    const mailbox: MailboxMessage = {
      toAgentId: req.toAgentId ?? '',
      fromAgentId: req.fromAgentId ?? divisionSnapshot.headAgentId,
      type: 'message',
      content: renderedPrompt,
      summary: buildSummary(divisionSnapshot),
    };

    return {
      company: companySnapshot,
      division: divisionSnapshot,
      taskPrompt: req.taskPrompt,
      renderedPrompt,
      mailbox,
    };
  }
}
