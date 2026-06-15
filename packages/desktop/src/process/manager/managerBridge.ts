/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manager IPC bridge — exposes the Main-process Personal Manager service to the
 * renderer Manager UI (Requirements 1–8, integration 9.4).
 *
 * This is an Electron-native bridge (not an aioncore HTTP route), built with the
 * same `@office-ai/platform` `bridge` helper that backs `ipcBridge.ts`. Because
 * `ipcBridge.ts` does not carry a `manager` namespace and this feature must not
 * modify it, the typed channels are declared **here** and exported so the
 * renderer (via `managerBridgeClient.ts`) and the global bootstrap can reach
 * them. The channel-name constants ({@link MANAGER_CHANNELS}) are the
 * renderer-safe contract — the renderer rebuilds matching invokers from those
 * names without importing this Node-only module.
 *
 * ## Same service as the Agent plane
 *
 * The UI plane (this bridge) and the Agent plane (`builtinMcp/managerServer.ts`)
 * see the **same state**: the on-disk `manager-data.json`. Both go through a
 * {@link IManagerStore} rooted at the userData dir.
 *
 * ## Always-resolve envelope
 *
 * The platform bridge only forwards a provider's **resolved** value — a thrown
 * error is swallowed and the renderer's `invoke()` never settles (infinite
 * spinner). So every handler is wrapped to ALWAYS resolve a
 * {@link ManagerResult}: `{ ok: true, data }` on success, `{ ok: false, error,
 * code }` on failure. `code: 'no-model'` flags "no usable model"; `code:
 * 'no-vision'` flags "model can't read images".
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  CalendarEvent,
  DataInsight,
  ManagerData,
  ManagerSettings,
  Note,
  OptimizeResult,
  Reminder,
  ResearchResult,
  Task,
  TaskStatus,
  TaskSuggestion,
} from './managerTypes';
import type { EventProposal, IManagerAi, TaskProposal } from './managerAi';
import type { IManagerStore, NewEventInput, NewNoteInput, NewTaskInput } from './managerStore';
import type { IReminderScheduler } from './reminderScheduler';
import { getForecast } from './weatherProvider';
import type { WeatherForecast } from './weatherProvider';
import { createTravelProvider } from './travelProvider';
import { extractDocs } from './docExtractor';
import type { TravelLeg, TravelMode } from './managerTypes';

// ---------------------------------------------------------------------------
// Channel names (renderer-safe contract)
// ---------------------------------------------------------------------------

/** IPC channel names for the manager surface. Safe to mirror in the renderer. */
export const MANAGER_CHANNELS = {
  getData: 'manager.get-data',
  addTask: 'manager.add-task',
  updateTask: 'manager.update-task',
  removeTask: 'manager.remove-task',
  toggleSubtask: 'manager.toggle-subtask',
  setTaskStatus: 'manager.set-task-status',
  addNote: 'manager.add-note',
  updateNote: 'manager.update-note',
  removeNote: 'manager.remove-note',
  addEvent: 'manager.add-event',
  updateEvent: 'manager.update-event',
  removeEvent: 'manager.remove-event',
  setEvents: 'manager.set-events',
  updateSettings: 'manager.update-settings',
  snoozeReminder: 'manager.snooze-reminder',
  dismissReminder: 'manager.dismiss-reminder',
  aiParseTasks: 'manager.ai-parse-tasks',
  aiReviewTasks: 'manager.ai-review-tasks',
  aiParseSchedule: 'manager.ai-parse-schedule',
  aiParseImage: 'manager.ai-parse-image',
  aiParseMulti: 'manager.ai-parse-multi',
  extractFiles: 'manager.extract-files',
  aiOptimize: 'manager.ai-optimize',
  aiResearch: 'manager.ai-research',
  aiSummarizeDoc: 'manager.ai-summarize-doc',
  dataChanged: 'manager.data-changed',
} as const;

// ---------------------------------------------------------------------------
// Request payloads
// ---------------------------------------------------------------------------

export type AddTaskRequest = { input: NewTaskInput };
export type UpdateTaskRequest = { id: string; patch: Partial<Omit<Task, 'id' | 'createdAt'>> };
export type IdRequest = { id: string };
export type ToggleSubtaskRequest = { taskId: string; subtaskId: string };
export type SetTaskStatusRequest = { id: string; status: TaskStatus };
export type AddNoteRequest = { input: NewNoteInput };
export type UpdateNoteRequest = { id: string; patch: Partial<Omit<Note, 'id' | 'createdAt'>> };
export type AddEventRequest = { input: NewEventInput };
export type UpdateEventRequest = { id: string; patch: Partial<Omit<CalendarEvent, 'id' | 'createdAt'>> };
export type SetEventsRequest = { events: CalendarEvent[] };
export type UpdateSettingsRequest = { patch: Partial<ManagerSettings> };
export type ReminderRefRequest = { taskId: string; reminderId: string; untilMs?: number };
export type AiParseTasksRequest = { description: string };
export type AiParseScheduleRequest = { text: string };
export type AiParseImageRequest = { imageDataUrl: string };
/** Parse events from a mixed prompt + extracted docs + downscaled images. */
export type AiParseMultiRequest = {
  prompt?: string;
  docs?: Array<{ name: string; text: string }>;
  images?: string[];
};
/** Extract text from a list of absolute file paths (PDF/DOCX/…). */
export type ExtractFilesRequest = { paths: string[] };
/** One extracted document's text (or an error note). */
export type ExtractedFile = { name: string; text: string; error?: string };
/** Optimise a range; `events`/`tasks` default to the whole store when omitted. */
export type AiOptimizeRequest = { from?: number; to?: number };
/** Research a topic on the web + synthesize a Learn note (criterion 5.9). */
export type AiResearchRequest = { topic: string };
/** Summarize + tag a Data library entry (criterion 5.13). */
export type AiSummarizeDocRequest = {
  title: string;
  url?: string | null;
  filePath?: string | null;
  description?: string;
};

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/** Failure category for the UI to render a targeted hint. */
export type ManagerErrorCode = 'no-model' | 'no-vision' | 'error';

/** Every manager channel resolves with this envelope (never rejects on a handled failure). */
export type ManagerResult<T> = { ok: true; data: T } | { ok: false; error: string; code: ManagerErrorCode };

/** Typed manager IPC channels. Exported for the bootstrap registration wiring. */
export const managerChannels = {
  getData: bridge.buildProvider<ManagerResult<ManagerData>, void>(MANAGER_CHANNELS.getData),
  addTask: bridge.buildProvider<ManagerResult<ManagerData>, AddTaskRequest>(MANAGER_CHANNELS.addTask),
  updateTask: bridge.buildProvider<ManagerResult<ManagerData>, UpdateTaskRequest>(MANAGER_CHANNELS.updateTask),
  removeTask: bridge.buildProvider<ManagerResult<ManagerData>, IdRequest>(MANAGER_CHANNELS.removeTask),
  toggleSubtask: bridge.buildProvider<ManagerResult<ManagerData>, ToggleSubtaskRequest>(MANAGER_CHANNELS.toggleSubtask),
  setTaskStatus: bridge.buildProvider<ManagerResult<ManagerData>, SetTaskStatusRequest>(MANAGER_CHANNELS.setTaskStatus),
  addNote: bridge.buildProvider<ManagerResult<ManagerData>, AddNoteRequest>(MANAGER_CHANNELS.addNote),
  updateNote: bridge.buildProvider<ManagerResult<ManagerData>, UpdateNoteRequest>(MANAGER_CHANNELS.updateNote),
  removeNote: bridge.buildProvider<ManagerResult<ManagerData>, IdRequest>(MANAGER_CHANNELS.removeNote),
  addEvent: bridge.buildProvider<ManagerResult<ManagerData>, AddEventRequest>(MANAGER_CHANNELS.addEvent),
  updateEvent: bridge.buildProvider<ManagerResult<ManagerData>, UpdateEventRequest>(MANAGER_CHANNELS.updateEvent),
  removeEvent: bridge.buildProvider<ManagerResult<ManagerData>, IdRequest>(MANAGER_CHANNELS.removeEvent),
  setEvents: bridge.buildProvider<ManagerResult<ManagerData>, SetEventsRequest>(MANAGER_CHANNELS.setEvents),
  updateSettings: bridge.buildProvider<ManagerResult<ManagerData>, UpdateSettingsRequest>(
    MANAGER_CHANNELS.updateSettings
  ),
  snoozeReminder: bridge.buildProvider<ManagerResult<ManagerData>, ReminderRefRequest>(MANAGER_CHANNELS.snoozeReminder),
  dismissReminder: bridge.buildProvider<ManagerResult<ManagerData>, ReminderRefRequest>(
    MANAGER_CHANNELS.dismissReminder
  ),
  aiParseTasks: bridge.buildProvider<ManagerResult<TaskProposal[]>, AiParseTasksRequest>(MANAGER_CHANNELS.aiParseTasks),
  aiReviewTasks: bridge.buildProvider<ManagerResult<TaskSuggestion[]>, void>(MANAGER_CHANNELS.aiReviewTasks),
  aiParseSchedule: bridge.buildProvider<ManagerResult<EventProposal[]>, AiParseScheduleRequest>(
    MANAGER_CHANNELS.aiParseSchedule
  ),
  aiParseImage: bridge.buildProvider<ManagerResult<EventProposal[]>, AiParseImageRequest>(
    MANAGER_CHANNELS.aiParseImage
  ),
  aiParseMulti: bridge.buildProvider<ManagerResult<EventProposal[]>, AiParseMultiRequest>(
    MANAGER_CHANNELS.aiParseMulti
  ),
  extractFiles: bridge.buildProvider<ManagerResult<ExtractedFile[]>, ExtractFilesRequest>(
    MANAGER_CHANNELS.extractFiles
  ),
  aiOptimize: bridge.buildProvider<ManagerResult<OptimizeResult>, AiOptimizeRequest>(MANAGER_CHANNELS.aiOptimize),
  aiResearch: bridge.buildProvider<ManagerResult<ResearchResult>, AiResearchRequest>(MANAGER_CHANNELS.aiResearch),
  aiSummarizeDoc: bridge.buildProvider<ManagerResult<DataInsight>, AiSummarizeDocRequest>(
    MANAGER_CHANNELS.aiSummarizeDoc
  ),
  dataChanged: bridge.buildEmitter<ManagerData>(MANAGER_CHANNELS.dataChanged),
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Services the manager bridge operates on. */
export type ManagerBridgeServices = {
  store: IManagerStore;
  /** AI helper bound to the user's provider/model. May be absent when unconfigured. */
  ai?: IManagerAi;
  scheduler: IReminderScheduler;
};

/** Options for {@link registerManagerBridge}. */
export type RegisterManagerBridgeOptions = { services: ManagerBridgeServices };

/** Detect the "no usable model" vs "no vision" cases for a targeted UI hint. */
const classify = (error: unknown): ManagerErrorCode => {
  const message = error instanceof Error ? error.message : String(error);
  if (/vision|image.*not|cannot.*image|multimodal/i.test(message)) return 'no-vision';
  if (/no usable model|no model|not configured|requires a generator/i.test(message)) return 'no-model';
  return 'error';
};

/**
 * Compute travel legs between consecutive located events within a day, in start
 * order. Used to feed the AI optimiser a realistic commute buffer (criterion
 * 8.3c). Returns `[]` when travel time is disabled, there are fewer than two
 * located events, or every estimate fails (degrade-safe — never throws).
 *
 * The first located event of each day optionally gets a leg from the user's
 * `homeLocation` so "leave home in time for your first commitment" is modelled.
 */
const computeTravelLegs = async (
  events: CalendarEvent[],
  settings: { travelMode: TravelMode; googleMapsApiKey?: string | null; homeLocation?: string | null }
): Promise<TravelLeg[]> => {
  const located = events.filter((e) => (e.location ?? '').trim().length > 0).toSorted((a, b) => a.startAt - b.startAt);
  if (located.length === 0) return [];

  const provider = createTravelProvider({ googleApiKey: settings.googleMapsApiKey });
  const mode = settings.travelMode;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const dayOf = (ts: number) => Math.floor(ts / DAY_MS);

  const legs: TravelLeg[] = [];
  let prev: CalendarEvent | null = null;
  const home = (settings.homeLocation ?? '').trim();

  for (const event of located) {
    const sameDayAsPrev = prev && dayOf(prev.startAt) === dayOf(event.startAt);
    if (prev && sameDayAsPrev) {
      const est = await provider.estimate(prev.location!, event.location!, mode).catch((): null => null);
      if (est) {
        legs.push({
          fromId: prev.id,
          toId: event.id,
          fromLocation: prev.location!,
          toLocation: event.location!,
          distanceMeters: est.distanceMeters,
          durationSeconds: est.durationSeconds,
          mode: est.mode,
          source: est.source,
        });
      }
    } else if (home) {
      // First located event of a (new) day: optional leg from home.
      const est = await provider.estimate(home, event.location!, mode).catch((): null => null);
      if (est) {
        legs.push({
          fromId: 'home',
          toId: event.id,
          fromLocation: home,
          toLocation: event.location!,
          distanceMeters: est.distanceMeters,
          durationSeconds: est.durationSeconds,
          mode: est.mode,
          source: est.source,
        });
      }
    }
    prev = event;
  }
  return legs;
};

let unsubscribeChange: (() => void) | undefined;

/**
 * Register the manager IPC handlers and wire the live `dataChanged` push.
 *
 * Idempotent: a repeated call re-registers the providers and replaces the prior
 * `onChange` subscription. Intended to be invoked once during Main-process
 * bootstrap.
 */
export function registerManagerBridge(options: RegisterManagerBridgeOptions): void {
  const { store, ai, scheduler } = options.services;

  /** Wrap a handler so it ALWAYS resolves a {@link ManagerResult}. */
  const safe =
    <Req, Res>(label: string, handler: (req: Req) => Promise<Res>) =>
    async (req: Req): Promise<ManagerResult<Res>> => {
      try {
        return { ok: true, data: await handler(req) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[ManagerBridge] ${label} failed:`, error);
        return { ok: false, error: message, code: classify(error) };
      }
    };

  /** Require a configured AI helper, else throw the "no-model" sentinel. */
  const requireAi = (): IManagerAi => {
    if (!ai) throw new Error('No usable model is configured. Open Settings → Model and add a provider/model.');
    return ai;
  };

  // --- Reads + mutations (all return the fresh ManagerData) ---------------
  managerChannels.getData.provider(safe('getData', () => store.load()));
  managerChannels.addTask.provider(
    safe('addTask', async ({ input }) => {
      await store.addTask(input);
      return store.getData();
    })
  );
  managerChannels.updateTask.provider(safe('updateTask', ({ id, patch }) => store.updateTask(id, patch)));
  managerChannels.removeTask.provider(safe('removeTask', ({ id }) => store.removeTask(id)));
  managerChannels.toggleSubtask.provider(
    safe('toggleSubtask', ({ taskId, subtaskId }) => store.toggleSubtask(taskId, subtaskId))
  );
  managerChannels.setTaskStatus.provider(safe('setTaskStatus', ({ id, status }) => store.setTaskStatus(id, status)));
  managerChannels.addNote.provider(
    safe('addNote', async ({ input }) => {
      await store.addNote(input);
      return store.getData();
    })
  );
  managerChannels.updateNote.provider(safe('updateNote', ({ id, patch }) => store.updateNote(id, patch)));
  managerChannels.removeNote.provider(safe('removeNote', ({ id }) => store.removeNote(id)));
  managerChannels.addEvent.provider(
    safe('addEvent', async ({ input }) => {
      await store.addEvent(input);
      return store.getData();
    })
  );
  managerChannels.updateEvent.provider(safe('updateEvent', ({ id, patch }) => store.updateEvent(id, patch)));
  managerChannels.removeEvent.provider(safe('removeEvent', ({ id }) => store.removeEvent(id)));
  managerChannels.setEvents.provider(safe('setEvents', ({ events }) => store.setEvents(events)));
  managerChannels.updateSettings.provider(safe('updateSettings', ({ patch }) => store.updateSettings(patch)));

  // --- Reminders ----------------------------------------------------------
  managerChannels.snoozeReminder.provider(
    safe('snoozeReminder', async ({ taskId, reminderId, untilMs }) => {
      await scheduler.snooze(taskId, reminderId, untilMs ?? Date.now() + 10 * 60_000);
      return store.getData();
    })
  );
  managerChannels.dismissReminder.provider(
    safe('dismissReminder', async ({ taskId, reminderId }) => {
      await scheduler.dismiss(taskId, reminderId);
      return store.getData();
    })
  );

  // --- AI (proposals only — never mutate the store) -----------------------
  managerChannels.aiParseTasks.provider(safe('aiParseTasks', ({ description }) => requireAi().parseTasks(description)));
  managerChannels.aiReviewTasks.provider(safe('aiReviewTasks', () => requireAi().reviewTasks(store.getData().tasks)));
  managerChannels.aiParseSchedule.provider(safe('aiParseSchedule', ({ text }) => requireAi().parseSchedule(text)));
  managerChannels.aiParseImage.provider(
    safe('aiParseImage', ({ imageDataUrl }) => requireAi().parseScheduleImage(imageDataUrl))
  );
  managerChannels.aiParseMulti.provider(
    safe('aiParseMulti', ({ prompt, docs, images }) => requireAi().parseScheduleMulti({ prompt, docs, images }))
  );
  // Extract text from PDF/DOCX/… by path (Node-only; never throws per file).
  managerChannels.extractFiles.provider(safe('extractFiles', ({ paths }) => extractDocs(paths)));
  managerChannels.aiOptimize.provider(
    safe('aiOptimize', async ({ from, to }) => {
      const data = store.getData();
      const inRange = (e: CalendarEvent) => (from == null || e.endAt >= from) && (to == null || e.startAt <= to);
      const events = data.events.filter(inRange);
      // Resolve weather for the optimiser when enabled + a location is known.
      let weather: WeatherForecast | null = null;
      if (data.settings.weatherEnabled) {
        const location = data.settings.defaultLocation ?? events.find((e) => e.location)?.location ?? null;
        weather = await getForecast(location, 7).catch((): WeatherForecast | null => null);
      }
      // Resolve travel legs between located events when enabled (Google → OSRM →
      // straight-line estimate). Degrades to [] on any failure.
      let travelLegs: TravelLeg[] = [];
      if (data.settings.travelTimeEnabled) {
        travelLegs = await computeTravelLegs(events, data.settings).catch((): TravelLeg[] => []);
      }
      return requireAi().optimizeSchedule({ events, tasks: data.tasks, weather, travelLegs });
    })
  );

  // Research a topic on the web + synthesize a Learn note (criterion 5.9).
  managerChannels.aiResearch.provider(safe('aiResearch', ({ topic }) => requireAi().researchTopic(topic)));

  // Summarize + suggest tags for a Data library entry (criterion 5.13).
  managerChannels.aiSummarizeDoc.provider(
    safe('aiSummarizeDoc', ({ title, url, filePath, description }) =>
      requireAi().summarizeDocument({ title, url, filePath, description })
    )
  );

  // --- Live push: forward every store change to the renderer --------------
  unsubscribeChange?.();
  unsubscribeChange = store.onChange((data) => {
    managerChannels.dataChanged.emit(data);
  });
}

/** Detach the live push subscription (deterministic teardown for tests/hot-reload). */
export function disposeManagerBridge(): void {
  unsubscribeChange?.();
  unsubscribeChange = undefined;
}

/** Re-export the reminder type for renderer convenience. */
export type { Reminder };
