/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AI helpers for the Personal Manager feature (Requirements 2, 3, 8).
 *
 * Every function calls the **user's configured provider/model** through an
 * injected {@link AgentChat} (built by `browser/providerChat.ts`, reused here so
 * no model is hardcoded and multimodal pass-through works for timetable
 * images). They return **proposals only** — none of them touch the store
 * (Property 4). The renderer shows a preview and the user explicitly applies
 * them via the store mutators.
 *
 * Heavy calls (image parsing, optimisation) take a `ResourceCoordinator` lease
 * so they queue under load instead of piling on (Property 6); the lease is
 * always released in a `finally`.
 *
 * The model is asked to answer with a single fenced JSON block; {@link extractJson}
 * tolerates extra prose around it. A malformed answer throws a clear error which
 * the bridge converts into a friendly `ManagerResult` failure (no hang).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { getResourceCoordinator } from '@process/resource/resourceCoordinator';
import type { IResourceCoordinator } from '@process/resource/resourceCoordinator';
import type { AgentChat, ChatMessageInput } from '@process/browser/webAgentRunner';
import type {
  CalendarEvent,
  OptimizeResult,
  Task,
  TaskKind,
  TaskSuggestion,
  Priority,
  ResearchResult,
  DataInsight,
} from './managerTypes';
import type { WeatherForecast } from './weatherProvider';
import type { TravelLeg } from './managerTypes';
import { searchWeb, type WebSearchResult } from './webSearch';

/** A task proposal (subset of {@link Task} fields the model fills in). */
export type TaskProposal = {
  title: string;
  description?: string;
  kind?: TaskKind;
  priority?: Priority;
  dueAt?: number | null;
  estimateMinutes?: number | null;
  tags?: string[];
  subtasks?: Array<{ title: string }>;
};

/** An event proposal the model fills in (times as ms epoch). */
export type EventProposal = {
  title: string;
  startAt: number;
  endAt: number;
  lockKind?: 'fixed' | 'flexible';
  location?: string | null;
  note?: string | null;
};

/** Injected dependencies for {@link createManagerAi}. */
export type ManagerAiDeps = {
  /** Provider-backed chat (defaults to the browser provider chat at call sites). */
  chat: AgentChat;
  /** Model id to use; resolved lazily by the caller from the user's selection. */
  model: string;
  /** Resource coordinator for leasing heavy calls. Defaults to the shared one. */
  coordinator?: IResourceCoordinator;
  /** Clock for "now" used when interpreting relative dates. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Web search used by {@link IManagerAi.researchTopic}. Defaults to the keyless
   * {@link searchWeb}. Injected so tests need no network and so research can run
   * model-only when search is unavailable.
   */
  search?: (query: string) => Promise<WebSearchResult[]>;
};

/** Estimated memory cost (MB) of an AI call, for the lease accounting. */
const AI_LEASE_COST_MB = 64;

/**
 * Pull the first JSON value out of a model reply.
 *
 * Accepts a bare JSON document or a ```json fenced block, tolerating prose
 * around it. Throws when nothing parseable is found.
 */
export const extractJson = <T>(reply: string): T => {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : reply).trim();
  // Fall back to the first {...} or [...] span when the model added prose.
  const start = candidate.search(/[[{]/);
  const slice = start >= 0 ? candidate.slice(start) : candidate;
  try {
    return JSON.parse(slice) as T;
  } catch {
    // Try trimming trailing prose after the matching bracket.
    const lastCurly = slice.lastIndexOf('}');
    const lastSquare = slice.lastIndexOf(']');
    const end = Math.max(lastCurly, lastSquare);
    if (end > 0) {
      try {
        return JSON.parse(slice.slice(0, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new Error('The model did not return valid JSON. Please try again.');
  }
};

/** Public contract of the Manager AI helper. */
export type IManagerAi = {
  parseTasks(description: string): Promise<TaskProposal[]>;
  reviewTasks(tasks: Task[]): Promise<TaskSuggestion[]>;
  parseSchedule(text: string): Promise<EventProposal[]>;
  parseScheduleImage(imageDataUrl: string): Promise<EventProposal[]>;
  /**
   * Parse calendar events from a mix of inputs (criterion 6.4–6.6, extended):
   * an optional free-text prompt, extracted document texts (PDF/DOCX/MD/JSON/…),
   * and downscaled images. Multimodal: images ride along as `image_url` parts.
   */
  parseScheduleMulti(input: {
    prompt?: string;
    docs?: Array<{ name: string; text: string }>;
    images?: string[];
  }): Promise<EventProposal[]>;
  optimizeSchedule(input: {
    events: CalendarEvent[];
    tasks: Task[];
    weather?: WeatherForecast | null;
    travelLegs?: TravelLeg[];
  }): Promise<OptimizeResult>;
  /** Research a topic on the web + synthesize a study note (Learn, criterion 5.9). */
  researchTopic(topic: string): Promise<ResearchResult>;
  /** Summarize + suggest tags for a Data library entry (criterion 5.13). */
  summarizeDocument(input: {
    title: string;
    url?: string | null;
    filePath?: string | null;
    description?: string;
  }): Promise<DataInsight>;
};

/**
 * Create the Manager AI helper bound to a provider-backed {@link AgentChat} and
 * a specific model id.
 */
export const createManagerAi = (deps: ManagerAiDeps): IManagerAi => {
  const coordinator = deps.coordinator ?? getResourceCoordinator();
  const now = deps.now ?? Date.now;
  const search = deps.search ?? ((query: string) => searchWeb(query));

  /** Run a chat call under a coordinator lease (Property 6). */
  const leased = async (messages: ChatMessageInput[]): Promise<string> => {
    const lease = await coordinator.requestLease({ kind: 'agent', estCostMB: AI_LEASE_COST_MB });
    try {
      return await deps.chat({ model: deps.model, messages });
    } finally {
      coordinator.releaseLease(lease.id);
    }
  };

  const nowIso = () => new Date(now()).toISOString();

  return {
    async parseTasks(description) {
      const system =
        'You turn a free-text description into a structured todo list. ' +
        'Reply with ONLY a JSON array of tasks. Each task: ' +
        '{ "title": string, "description"?: string, "kind"?: "oneoff"|"recurring"|"habit"|"milestone", ' +
        '"priority"?: "low"|"medium"|"high"|"urgent", "dueAt"?: number (ms epoch) | null, ' +
        '"estimateMinutes"?: number | null, "tags"?: string[], "subtasks"?: [{"title": string}] }. ' +
        `Current time is ${nowIso()}; resolve relative dates against it. Keep titles short and actionable.`;
      const reply = await leased([
        { role: 'system', content: system },
        { role: 'user', content: description },
      ]);
      const parsed = extractJson<TaskProposal[]>(reply);
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of tasks.');
      return parsed.filter((t) => t && typeof t.title === 'string' && t.title.trim().length > 0);
    },

    async reviewTasks(tasks) {
      const system =
        'You are a productivity coach. Given the current task list, suggest improvements: ' +
        'overdue items, priority changes, merges/splits, and a sensible order for today. ' +
        'Reply with ONLY a JSON array: ' +
        '[{ "message": string, "taskId"?: string, "kind": "priority"|"order"|"merge"|"split"|"overdue"|"other" }]. ' +
        'Do not invent tasks; reference existing ids only.';
      const compact = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        status: t.status,
        dueAt: t.dueAt,
        kind: t.kind,
      }));
      const reply = await leased([
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(compact) },
      ]);
      const parsed = extractJson<TaskSuggestion[]>(reply);
      if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of suggestions.');
      return parsed.filter((s) => s && typeof s.message === 'string');
    },

    async parseSchedule(text) {
      const system =
        'You turn a free-text scheduling request into calendar events. ' +
        'Reply with ONLY a JSON array of events. Each event: ' +
        '{ "title": string, "startAt": number (ms epoch), "endAt": number (ms epoch), ' +
        '"lockKind"?: "fixed"|"flexible", "location"?: string, "note"?: string }. ' +
        `Current time is ${nowIso()}; resolve relative dates against it. Default lockKind is "flexible".`;
      const reply = await leased([
        { role: 'system', content: system },
        { role: 'user', content: text },
      ]);
      return normaliseEventProposals(reply, 'flexible');
    },

    async parseScheduleImage(imageDataUrl) {
      const system =
        'You read a photo of a schedule or class timetable and extract its events. ' +
        'Reply with ONLY a JSON array of events. Each event: ' +
        '{ "title": string, "startAt": number (ms epoch), "endAt": number (ms epoch), ' +
        '"lockKind"?: "fixed"|"flexible", "location"?: string, "note"?: string }. ' +
        `Current time is ${nowIso()}. A class timetable repeats weekly; map each class to the next ` +
        'upcoming occurrence of its weekday. These are fixed commitments, so set lockKind to "fixed".';
      // Multimodal user turn: a text instruction + the image. Providers without
      // vision simply receive the text part (degraded), which the bridge flags.
      const reply = await leased([
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract every event from this schedule image as JSON.' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ]);
      return normaliseEventProposals(reply, 'fixed');
    },

    async parseScheduleMulti({ prompt, docs, images }) {
      const docList = (docs ?? []).filter((d) => d.text.trim().length > 0);
      const imageList = (images ?? []).filter((u) => typeof u === 'string' && u.length > 0);
      const hasImages = imageList.length > 0;

      const system =
        'You build calendar events from mixed user input: an optional instruction, one or more attached ' +
        'documents (timetables, agendas, syllabi, meeting notes), and/or images of schedules. Combine ALL ' +
        'inputs into a single coherent set of events. Reply with ONLY a JSON array of events. Each event: ' +
        '{ "title": string, "startAt": number (ms epoch), "endAt": number (ms epoch), ' +
        '"lockKind"?: "fixed"|"flexible", "location"?: string, "note"?: string }. ' +
        `Current time is ${nowIso()}; resolve relative dates against it. Recurring class/work timetables map ` +
        'to the next upcoming occurrence of each weekday and are "fixed"; one-off or loosely-timed items are ' +
        '"flexible". Follow the user instruction when it conflicts with a document default.';

      // Build the user turn: instruction + each doc's text + any images.
      const textParts: string[] = [];
      if (prompt && prompt.trim().length > 0) textParts.push(`Instruction:\n${prompt.trim()}`);
      for (const doc of docList) {
        textParts.push(`--- Document: ${doc.name} ---\n${doc.text}`);
      }
      if (textParts.length === 0 && !hasImages) {
        throw new Error('No input provided. Add a prompt, a document, or an image.');
      }
      const userText = textParts.join('\n\n') || 'Extract every event from the attached image(s) as JSON.';

      const content = hasImages
        ? [
            { type: 'text' as const, text: userText },
            ...imageList.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
          ]
        : userText;

      const reply = await leased([
        { role: 'system', content: system },
        { role: 'user', content },
      ]);
      // Mixed input: default ambiguous items to flexible unless the model marked fixed.
      return normaliseEventProposals(reply, 'flexible');
    },

    async optimizeSchedule({ events, tasks, weather, travelLegs }) {
      const fixed = events.filter((e) => e.lockKind === 'fixed');
      const flexible = events.filter((e) => e.lockKind !== 'fixed');
      const weatherUsed = Boolean(weather && weather.days.length > 0);
      const legs = travelLegs ?? [];
      const travelUsed = legs.length > 0;

      const system =
        'You optimise a personal daily/weekly schedule. You MUST NOT move, shorten, or delete any ' +
        'FIXED event — only rearrange FLEXIBLE events into the gaps around them. Consider: ' +
        '(a) work science (hard tasks when alert, sensible breaks, avoid stacking heavy work); ' +
        '(b) time (deadlines, durations, free slots); ' +
        `(c) location & travel (${travelUsed ? 'use the provided travelLegs — leave enough buffer between located events so the user can physically get there; never schedule a flexible event so it overlaps the travel time before a fixed event' : 'no travel estimates available — group nearby items and leave a sensible buffer'}); ` +
        `(d) weather (${weatherUsed ? 'use the provided forecast for outdoor items' : 'NO forecast available — ignore weather and say so'}); ` +
        '(e) necessity (priority/urgency). ' +
        'Reply with ONLY a JSON object: { "proposed": Event[], "rationale": string[] } where Event keeps ' +
        'the same "id" for every event and uses ms-epoch "startAt"/"endAt". Keep all fixed events identical.';

      const payload = {
        now: now(),
        fixedEvents: fixed,
        flexibleEvents: flexible,
        tasks: tasks.map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          dueAt: t.dueAt,
          estimateMinutes: t.estimateMinutes,
        })),
        weather: weatherUsed ? weather : null,
        // Compact travel legs so the model can reason about commute buffers.
        travelLegs: travelUsed
          ? legs.map((l) => ({
              fromId: l.fromId,
              toId: l.toId,
              from: l.fromLocation,
              to: l.toLocation,
              minutes: Math.round(l.durationSeconds / 60),
              km: Math.round((l.distanceMeters / 1000) * 10) / 10,
              mode: l.mode,
            }))
          : null,
      };

      const reply = await leased([
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
      ]);

      const parsed = extractJson<{ proposed?: unknown; rationale?: unknown }>(reply);
      const rationale = Array.isArray(parsed.rationale)
        ? parsed.rationale.filter((r): r is string => typeof r === 'string')
        : [];
      if (!weatherUsed) rationale.push('Weather was not factored in (no forecast available).');
      if (!travelUsed) rationale.push('Travel time was not factored in (no located events or estimates unavailable).');

      // Enforce Property 1 defensively: rebuild the result so every FIXED event
      // is preserved byte-for-byte and only flexible events can change.
      const proposedById = new Map<string, CalendarEvent>();
      if (Array.isArray(parsed.proposed)) {
        for (const raw of parsed.proposed as CalendarEvent[]) {
          if (raw && typeof raw.id === 'string') proposedById.set(raw.id, raw);
        }
      }
      const proposed: CalendarEvent[] = [
        // Fixed events: always the originals, untouched.
        ...fixed,
        // Flexible events: take the model's version when valid, else keep original.
        ...flexible.map((original) => {
          const candidate = proposedById.get(original.id);
          if (
            candidate &&
            typeof candidate.startAt === 'number' &&
            typeof candidate.endAt === 'number' &&
            candidate.endAt > candidate.startAt
          ) {
            return {
              ...original,
              startAt: candidate.startAt,
              endAt: candidate.endAt,
              source: 'optimizer' as const,
              updatedAt: now(),
            };
          }
          return original;
        }),
      ];

      return { proposed, rationale, weatherUsed, travelUsed, travelLegs: legs };
    },

    async researchTopic(topic) {
      // 1) Gather web context (keyless; degrades to empty on any failure).
      const results = await search(topic).catch((): WebSearchResult[] => []);
      const webUsed = results.length > 0;
      const sources = results.map((r) => ({ title: r.title, url: r.url }));
      const context =
        results.length > 0
          ? results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\n${r.url}`).join('\n\n')
          : '(no web results available — answer from your own knowledge and say so)';

      const system =
        'You are a study assistant. Using the provided web context (when available) and your own knowledge, ' +
        'write a concise study note on the topic. Reply with ONLY a JSON object: ' +
        '{ "title": string, "body": string (Markdown: a short summary then key points as bullets), ' +
        '"tags": string[], "sources": [{ "title": string, "url": string }] }. ' +
        'Cite only URLs that appear in the provided context; do not invent sources.';

      const reply = await leased([
        { role: 'system', content: system },
        { role: 'user', content: `Topic: ${topic}\n\nWeb context:\n${context}` },
      ]);

      const parsed = extractJson<Partial<ResearchResult>>(reply);
      const parsedSources = Array.isArray(parsed.sources)
        ? parsed.sources.filter((s): s is { title: string; url: string } => Boolean(s) && typeof s.url === 'string')
        : [];
      return {
        title: typeof parsed.title === 'string' && parsed.title.trim().length > 0 ? parsed.title : topic,
        body: typeof parsed.body === 'string' ? parsed.body : '',
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
        // Prefer the model's citations but fall back to the raw search sources.
        sources: parsedSources.length > 0 ? parsedSources : sources,
        webUsed,
      };
    },

    async summarizeDocument({ title, url, filePath, description }) {
      const system =
        'You help organise a study library. Given a document reference, propose a short summary and useful ' +
        'tags/classification. Reply with ONLY a JSON object: { "summary": string (Markdown), "tags": string[] }.';
      const ref = [
        `Title: ${title}`,
        url ? `URL: ${url}` : '',
        filePath ? `File: ${filePath}` : '',
        description ? `Notes: ${description}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const reply = await leased([
        { role: 'system', content: system },
        { role: 'user', content: ref },
      ]);
      const parsed = extractJson<Partial<DataInsight>>(reply);
      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
      };
    },
  };
};

/** Parse + sanitise an event-proposal reply, applying a default lock kind. */
const normaliseEventProposals = (reply: string, defaultLock: 'fixed' | 'flexible'): EventProposal[] => {
  const parsed = extractJson<EventProposal[]>(reply);
  if (!Array.isArray(parsed)) throw new Error('Expected a JSON array of events.');
  return parsed
    .filter((e) => e && typeof e.title === 'string' && typeof e.startAt === 'number' && typeof e.endAt === 'number')
    .map((e) => ({ ...e, lockKind: e.lockKind === 'fixed' || e.lockKind === 'flexible' ? e.lockKind : defaultLock }));
};
