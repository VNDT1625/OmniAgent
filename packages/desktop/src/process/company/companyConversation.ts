/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Company conversation engine (Requirement 3 — "Phần 2": boss ↔ employee chat).
 *
 * This is the missing piece that makes a company's agents actually *talk to each
 * other*. The earlier company work built the elastic role tree, executor
 * assignments, rules and memory, but the live dialogue between the President and
 * the division heads / workers was never wired (the only `TeamGateway` was a
 * stub that rejects, and the UI "Start" button merely opened a solo 1-1 chat).
 *
 * ## Why in-process (not Team Mode RPC)
 *
 * Team Mode (`/api/teams/*`) can spawn agents but exposes **no REST route** for
 * "deliver a briefing to a teammate" or "await a teammate's result" — those
 * would need new Rust routes in aioncore, which is out of scope (we must not
 * modify the backend). So, exactly like the Browser web-agent
 * (`webAgentRunner` + `providerChat`), this engine drives the dialogue
 * **in-process** by calling the user's configured model directly through an
 * injected {@link CompanyChat}. Every turn is streamed out as a
 * {@link ConversationEvent} so the renderer can render a live transcript and a
 * status board (who is talking to whom, who is doing what).
 *
 * ## Permission gate (boss authority)
 *
 * A worker/division-head may need to do something sensitive (run a command,
 * spend budget, touch production…). When the model emits a `request_permission`
 * action the engine **pauses that branch** and emits a `permission` event; the
 * President — or the human acting as the President — answers via
 * {@link ICompanyConversation.resolvePermission}. Nothing past the gate runs
 * until it is approved (criterion: "sếp có quyền đồng ý / cấp quyền").
 *
 * ## Process boundary
 *
 * Main-process (Node.js / Electron) module. No DOM APIs. Every collaborator is
 * injected so the loop is unit-testable without a live model or coordinator.
 */

import type { CompanyStructure, RoleNode } from './companyOrchestrator';

// ---------------------------------------------------------------------------
// Public model
// ---------------------------------------------------------------------------

/** A participant in a company conversation (one role/agent). */
export type Participant = {
  /** Role node id (stable within the company). */
  id: string;
  /** Display name. */
  name: string;
  /** Role in the hierarchy. */
  role: RoleNode['role'];
  /** Division id (for heads/workers). */
  divisionId?: string;
  /** Short responsibilities blurb, surfaced in the status board. */
  responsibilities?: string;
  /** Executor label (CLI/assistant) for display, e.g. "Claude Code". */
  executor?: string;
};

/** What a participant is currently doing — drives the status board. */
export type ParticipantActivity =
  /** Not engaged in the current run. */
  | 'idle'
  /** Composing/awaiting a model reply (thinking). */
  | 'thinking'
  /** Speaking to another participant this step. */
  | 'speaking'
  /** Blocked waiting for the boss to approve a permission request. */
  | 'awaiting-approval'
  /** Finished its part of the run. */
  | 'done'
  /** Failed (model/parse/error). */
  | 'failed';

/** Live status of one participant (status-board row). */
export type ParticipantStatus = {
  /** Role node id. */
  id: string;
  /** Current activity. */
  activity: ParticipantActivity;
  /** Id of the participant this one is talking to right now (if any). */
  talkingToId?: string;
  /** Short label of the current task/topic (what they are doing). */
  task?: string;
  /** Last update time (Unix ms). */
  updatedAt: number;
};

/** One chat line in the transcript (who said what to whom). */
export type ConversationMessage = {
  /** Stable message id. */
  id: string;
  /** Speaker role node id. */
  fromId: string;
  /** Addressee role node id (the President's id for "report up"). */
  toId: string;
  /** Message body. */
  content: string;
  /** Time the line was produced (Unix ms). */
  at: number;
  /** `directive` = boss → employee task; `report` = employee → boss result; `note` = system. */
  kind: 'directive' | 'report' | 'note';
};

/** A pending permission request the boss must answer. */
export type PermissionRequest = {
  /** Stable request id (used to resolve it). */
  id: string;
  /** Role node id of the requester. */
  fromId: string;
  /** What the requester wants to do. */
  action: string;
  /** Why they need it (model-provided justification). */
  reason?: string;
  /** Time requested (Unix ms). */
  at: number;
};

/** The boss's answer to a {@link PermissionRequest}. */
export type PermissionDecision = {
  /** The request being answered. */
  requestId: string;
  /** Whether the boss granted it. */
  approved: boolean;
  /** Optional note from the boss (shown to the requester). */
  note?: string;
};

/** A streamed conversation event (Main → renderer). */
export type ConversationEvent =
  /** A run started; carries the initial participant roster. */
  | { type: 'run-started'; runId: string; goal: string; participants: Participant[] }
  /** A participant's status changed (status-board update). */
  | { type: 'status'; runId: string; status: ParticipantStatus }
  /** A new chat line was produced. */
  | { type: 'message'; runId: string; message: ConversationMessage }
  /** A participant is asking the boss for permission (branch paused). */
  | { type: 'permission'; runId: string; request: PermissionRequest }
  /** A pending permission was resolved by the boss. */
  | { type: 'permission-resolved'; runId: string; decision: PermissionDecision }
  /** The run finished; carries the President's final summary. */
  | { type: 'run-finished'; runId: string; summary: string; status: 'done' | 'stopped' | 'error' }
  /** The run failed before finishing. */
  | { type: 'run-error'; runId: string; message: string };

/** Sink the engine pushes {@link ConversationEvent}s through. */
export type ConversationEventSink = (event: ConversationEvent) => void;

/**
 * The chat-completion call the engine uses to make a role "think/speak". Returns
 * the raw assistant message text. Production wiring supplies a provider-backed
 * implementation (reads the user's configured model); tests inject a stub.
 */
export type CompanyChat = (params: {
  /** Model id to run this role with (optional — provider picks a default). */
  model?: string;
  /** The OpenAI-style message list. */
  messages: Array<{ role: string; content: string }>;
  /** Cancellation signal. */
  signal?: AbortSignal;
}) => Promise<string>;

/** A minimal lease coordinator (structural subset of the ResourceCoordinator). */
export type ConversationLease = {
  requestLease: (req: { kind: 'agent'; estCostMB: number }) => Promise<{ id: string }>;
  releaseLease: (id: string) => void;
};

/** Input to {@link ICompanyConversation.run}. */
export type RunConversationRequest = {
  /** The company structure whose roles converse. */
  structure: CompanyStructure;
  /** Company display name (for prompts/labels). */
  companyName: string;
  /** Company rules folded into every briefing. */
  rules: string[];
  /** The goal the President should drive the company toward. */
  goal: string;
  /** Model id to run the agents with (optional). */
  model?: string;
  /**
   * How many division heads / workers the President delegates to this run.
   * Bounded so a huge company does not fan out unbounded. Default 4.
   */
  maxDelegations?: number;
};

/** Public contract of the conversation engine. */
export type ICompanyConversation = {
  /**
   * Run one company conversation: the President briefs the company on `goal`,
   * delegates to its direct reports, they reply (asking permission when needed),
   * and the President produces a final summary. Streams progress through
   * `onEvent`; resolves with the run id when finished. Never rejects on a
   * model/permission failure — those surface as `run-error`/`run-finished`
   * events so the UI stays responsive.
   */
  run: (request: RunConversationRequest, onEvent: ConversationEventSink) => Promise<string>;
  /** Answer a pending permission request (boss authority). Returns `false` if unknown/stale. */
  resolvePermission: (decision: PermissionDecision) => boolean;
  /** Request cancellation of the in-flight run (best-effort, cooperative). */
  cancel: (runId: string) => void;
  /** Snapshot the latest status board for a run (empty when unknown). */
  getStatus: (runId: string) => ParticipantStatus[];
};

/** Injected dependencies for {@link createCompanyConversation}. */
export type CompanyConversationDeps = {
  /** The model call used for reasoning. */
  chat: CompanyChat;
  /** Resource coordinator for leasing agent turns (optional; no lease when absent). */
  coordinator?: ConversationLease;
  /** Clock (Unix ms). Defaults to `Date.now`. Injected for tests. */
  now?: () => number;
  /** Id generator. Defaults to a counter-based unique id. Injected for tests. */
  newId?: (prefix: string) => string;
  /** Estimated RAM per agent turn (MB). Default 384. */
  estCostMB?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cap on how many direct reports the President delegates to per run. */
const DEFAULT_MAX_DELEGATIONS = 4;

/** Default estimated RAM (MB) for one agent turn. */
const DEFAULT_EST_COST_MB = 384;

/** Max characters of a reply echoed into a downstream prompt. */
const MAX_REPLY_CHARS = 4000;

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

/** System prompt for the President: delegate, then summarise. */
const presidentSystemPrompt = (companyName: string, rules: string[]): string => {
  const ruleBlock =
    rules.length > 0 ? `\n\nCompany rules (every agent MUST follow):\n${rules.map((r) => `- ${r}`).join('\n')}` : '';
  return `You are the President of "${companyName}", an AI company. You lead the team and talk ONLY to your direct reports.
Your job, which is MANDATORY: turn the user's goal into clear, specific directives — ONE per direct report — matched to each report's responsibilities. EVERY direct report must receive a directive. You lead and delegate; you do not do the hands-on work yourself.
Speak naturally, as a leader briefing their team. Keep each directive to 1-3 sentences. This is a binding company process — follow it 100% of the time and stay strictly within your role.${ruleBlock}`;
};

/** System prompt for an employee (division head / worker). */
const employeeSystemPrompt = (companyName: string, participant: Participant, rules: string[]): string => {
  const ruleBlock =
    rules.length > 0 ? `\n\nCompany rules you MUST follow:\n${rules.map((r) => `- ${r}`).join('\n')}` : '';
  const resp = participant.responsibilities ? `\nYour responsibilities: ${participant.responsibilities}` : '';
  return `You are "${participant.name}", a ${participant.role === 'division-head' ? 'division head' : 'worker'} at the AI company "${companyName}".${resp}
You report ONLY to the President and report your result ONLY back to them. This is a binding company process — stay strictly within your role.
When given a directive, you MUST carry it out and respond with how you will carry it out and your result/plan, in 2-5 sentences.

If — and ONLY if — carrying out the directive needs the President's explicit permission (e.g. running a destructive command, spending budget, deploying to production, or accessing something sensitive), you MUST respond with EXACTLY ONE JSON object in a \`\`\`json code fence:
{"action":"request_permission","what":"<short action>","reason":"<why you need it>"}
Otherwise just reply in plain prose. Do NOT ask for permission for ordinary work.${ruleBlock}`;
};

/** Prompt asking the President to produce a final summary from all reports. */
const summaryPrompt = (goal: string, reports: ConversationMessage[]): string => {
  const block = reports.map((r) => `- ${r.fromId}: ${r.content}`).join('\n');
  return `Goal: ${goal}\n\nYour team reported back:\n${block}\n\nWrite a concise summary (3-6 sentences) of what the company will deliver and any open risks. Address the user directly.`;
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A parsed permission ask from an employee reply, or null when it is ordinary prose. */
type PermissionAsk = { what: string; reason?: string };

/** Extract the first JSON object from a model reply (fenced or bare). */
const extractJson = (reply: string): string | null => {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start !== -1 && end > start) return reply.slice(start, end + 1).trim();
  return null;
};

/** Detect a `request_permission` action in an employee reply. */
const parsePermissionAsk = (reply: string): PermissionAsk | null => {
  if (!/request_permission/.test(reply)) return null;
  const json = extractJson(reply);
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (raw && raw.action === 'request_permission' && typeof raw.what === 'string') {
      return { what: raw.what, reason: typeof raw.reason === 'string' ? raw.reason : undefined };
    }
  } catch {
    return null;
  }
  return null;
};

/** Split the President's directive reply into one directive per report (best-effort). */
const splitDirectives = (reply: string, count: number): string[] => {
  // Prefer explicit numbered/bulleted lines; fall back to sentence chunks.
  const lines = reply
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter((l) => l.length > 0);
  const candidates =
    lines.length >= count
      ? lines
      : reply
          .split(/(?<=[.!?])\s+/)
          .map((s) => s.trim())
          .filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(candidates[i] ?? candidates[candidates.length - 1] ?? reply.trim());
  }
  return out;
};

/** Truncate text for prompt use. */
const truncate = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Collect the President's direct reports (heads if any, else direct workers). */
const directReports = (structure: CompanyStructure): RoleNode[] => structure.root.children;

/** Map a role node to a display participant. */
const toParticipant = (node: RoleNode): Participant => ({
  id: node.id,
  name: node.name,
  role: node.role,
  divisionId: node.divisionId,
  responsibilities: node.responsibilities,
  executor: node.assignment?.label,
});

/**
 * Create the in-process company conversation engine.
 *
 * @param deps Injected model call, optional coordinator, clock and id source.
 */
export const createCompanyConversation = (deps: CompanyConversationDeps): ICompanyConversation => {
  const now = deps.now ?? (() => Date.now());
  let seq = 0;
  const newId = deps.newId ?? ((prefix: string) => `${prefix}-${++seq}-${now().toString(36)}`);
  const estCostMB = deps.estCostMB ?? DEFAULT_EST_COST_MB;

  /** Per-run mutable state. */
  type RunState = {
    statuses: Map<string, ParticipantStatus>;
    /** Pending permission resolvers, keyed by request id. */
    pending: Map<string, (decision: PermissionDecision) => void>;
    /** Cancellation controller. */
    abort: AbortController;
    cancelled: boolean;
  };
  const runs = new Map<string, RunState>();

  /** Lease one agent turn (no-op when no coordinator is wired). */
  const withLease = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!deps.coordinator) return fn();
    const lease = await deps.coordinator.requestLease({ kind: 'agent', estCostMB });
    try {
      return await fn();
    } finally {
      deps.coordinator.releaseLease(lease.id);
    }
  };

  /** Push a status update for a participant and stream it. */
  const setStatus = (
    runId: string,
    onEvent: ConversationEventSink,
    id: string,
    activity: ParticipantActivity,
    extra: { talkingToId?: string; task?: string } = {}
  ): void => {
    const state = runs.get(runId);
    if (!state) return;
    const status: ParticipantStatus = { id, activity, updatedAt: now(), ...extra };
    state.statuses.set(id, status);
    onEvent({ type: 'status', runId, status });
  };

  /** Stream a chat message. */
  const emitMessage = (
    runId: string,
    onEvent: ConversationEventSink,
    fromId: string,
    toId: string,
    content: string,
    kind: ConversationMessage['kind']
  ): ConversationMessage => {
    const message: ConversationMessage = { id: newId('msg'), fromId, toId, content, at: now(), kind };
    onEvent({ type: 'message', runId, message });
    return message;
  };

  /** Await the boss's decision on a permission request (or cancellation). */
  const awaitPermission = (
    runId: string,
    onEvent: ConversationEventSink,
    request: PermissionRequest
  ): Promise<PermissionDecision> => {
    const state = runs.get(runId);
    onEvent({ type: 'permission', runId, request });
    return new Promise<PermissionDecision>((resolve) => {
      if (!state) {
        resolve({ requestId: request.id, approved: false, note: 'run gone' });
        return;
      }
      state.pending.set(request.id, (decision) => {
        state.pending.delete(request.id);
        onEvent({ type: 'permission-resolved', runId, decision });
        resolve(decision);
      });
    });
  };

  const run: ICompanyConversation['run'] = async (request, onEvent) => {
    const runId = newId('run');
    const state: RunState = { statuses: new Map(), pending: new Map(), abort: new AbortController(), cancelled: false };
    runs.set(runId, state);

    const { structure, companyName, rules, goal, model } = request;
    const maxDelegations = Math.max(1, request.maxDelegations ?? DEFAULT_MAX_DELEGATIONS);

    const president = structure.root;
    const reports = directReports(structure).slice(0, maxDelegations);
    const participants: Participant[] = [toParticipant(president), ...reports.map(toParticipant)];

    onEvent({ type: 'run-started', runId, goal, participants });
    for (const p of participants) setStatus(runId, onEvent, p.id, 'idle');

    const signal = state.abort.signal;
    const collectedReports: Array<ConversationMessage | undefined> = [];
    collectedReports.length = reports.length;

    try {
      if (reports.length === 0) {
        // Tiny company: the President answers the goal directly.
        setStatus(runId, onEvent, president.id, 'thinking', { task: truncate(goal, 80) });
        const reply = await withLease(() =>
          deps.chat({
            model,
            signal,
            messages: [
              { role: 'system', content: presidentSystemPrompt(companyName, rules) },
              { role: 'user', content: goal },
            ],
          })
        );
        emitMessage(runId, onEvent, president.id, president.id, reply, 'report');
        setStatus(runId, onEvent, president.id, 'done');
        runs.delete(runId);
        onEvent({ type: 'run-finished', runId, summary: reply, status: 'done' });
        return runId;
      }

      // 1) President briefs the team and produces one directive per report.
      setStatus(runId, onEvent, president.id, 'thinking', { task: truncate(goal, 80) });
      const teamList = reports
        .map((r) => `- ${r.name} (${r.role}${r.responsibilities ? `, ${r.responsibilities}` : ''}) [id:${r.id}]`)
        .join('\n');
      const directiveReply = await withLease(() =>
        deps.chat({
          model,
          signal,
          messages: [
            { role: 'system', content: presidentSystemPrompt(companyName, rules) },
            {
              role: 'user',
              content: `Goal: ${goal}\n\nYour direct reports:\n${teamList}\n\nGive ONE directive per report, in order, one per line.`,
            },
          ],
        })
      );
      if (state.cancelled) throw new Error('cancelled');
      const directives = splitDirectives(directiveReply, reports.length);

      // 2) Independent direct reports execute concurrently. Result slots retain
      // role order so the President receives a deterministic summary prompt.
      await Promise.all(
        reports.map(async (report, i) => {
          if (state.cancelled) throw new Error('cancelled');
          const directive = directives[i];

          setStatus(runId, onEvent, president.id, 'speaking', {
            talkingToId: report.id,
            task: truncate(directive, 80),
          });
          emitMessage(runId, onEvent, president.id, report.id, directive, 'directive');

          setStatus(runId, onEvent, report.id, 'thinking', {
            talkingToId: president.id,
            task: truncate(directive, 80),
          });
          const employeeReply = await withLease(() =>
            deps.chat({
              model: report.assignment?.model ?? model,
              signal,
              messages: [
                { role: 'system', content: employeeSystemPrompt(companyName, toParticipant(report), rules) },
                { role: 'user', content: `Directive from the President: ${directive}` },
              ],
            })
          );
          if (state.cancelled) throw new Error('cancelled');

          const ask = parsePermissionAsk(employeeReply);
          if (ask) {
            // Pause this branch until the boss decides.
            setStatus(runId, onEvent, report.id, 'awaiting-approval', {
              talkingToId: president.id,
              task: truncate(ask.what, 80),
            });
            const decision = await awaitPermission(runId, onEvent, {
              id: newId('perm'),
              fromId: report.id,
              action: ask.what,
              reason: ask.reason,
              at: now(),
            });
            if (state.cancelled) throw new Error('cancelled');

            if (decision.approved) {
              const followUp = await withLease(() =>
                deps.chat({
                  model: report.assignment?.model ?? model,
                  signal,
                  messages: [
                    { role: 'system', content: employeeSystemPrompt(companyName, toParticipant(report), rules) },
                    {
                      role: 'user',
                      content: `The President APPROVED "${ask.what}"${decision.note ? ` (note: ${decision.note})` : ''}. Carry it out and report the result in 2-4 sentences.`,
                    },
                  ],
                })
              );
              const report2 = emitMessage(runId, onEvent, report.id, president.id, followUp, 'report');
              collectedReports[i] = report2;
            } else {
              const denied = `Permission for "${ask.what}" was denied${decision.note ? ` (${decision.note})` : ''}. I will proceed without it or escalate.`;
              const report2 = emitMessage(runId, onEvent, report.id, president.id, denied, 'report');
              collectedReports[i] = report2;
            }
            setStatus(runId, onEvent, report.id, 'done');
          } else {
            const msg = emitMessage(
              runId,
              onEvent,
              report.id,
              president.id,
              truncate(employeeReply, MAX_REPLY_CHARS),
              'report'
            );
            collectedReports[i] = msg;
            setStatus(runId, onEvent, report.id, 'done');
          }
        })
      );

      // 3) President summarises the team's reports for the user.
      if (state.cancelled) throw new Error('cancelled');
      setStatus(runId, onEvent, president.id, 'thinking', { task: 'summary' });
      const summary = await withLease(() =>
        deps.chat({
          model,
          signal,
          messages: [
            { role: 'system', content: presidentSystemPrompt(companyName, rules) },
            {
              role: 'user',
              content: summaryPrompt(
                goal,
                collectedReports.filter((report): report is ConversationMessage => Boolean(report))
              ),
            },
          ],
        })
      );
      setStatus(runId, onEvent, president.id, 'done');
      runs.delete(runId);
      onEvent({ type: 'run-finished', runId, summary, status: 'done' });
      return runId;
    } catch (error) {
      const wasCancel = state.cancelled || (error instanceof Error && error.message === 'cancelled');
      runs.delete(runId);
      if (wasCancel) {
        onEvent({ type: 'run-finished', runId, summary: '', status: 'stopped' });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        onEvent({ type: 'run-error', runId, message });
      }
      return runId;
    }
  };

  const resolvePermission: ICompanyConversation['resolvePermission'] = (decision) => {
    for (const state of runs.values()) {
      const resolver = state.pending.get(decision.requestId);
      if (resolver) {
        resolver(decision);
        return true;
      }
    }
    return false;
  };

  const cancel: ICompanyConversation['cancel'] = (runId) => {
    const state = runs.get(runId);
    if (!state) return;
    state.cancelled = true;
    state.abort.abort();
    // Unblock any pending permission so the run can wind down.
    for (const [requestId, resolver] of state.pending.entries()) {
      resolver({ requestId, approved: false, note: 'cancelled' });
    }
  };

  const getStatus: ICompanyConversation['getStatus'] = (runId) => {
    const state = runs.get(runId);
    return state ? Array.from(state.statuses.values()) : [];
  };

  return { run, resolvePermission, cancel, getStatus };
};
