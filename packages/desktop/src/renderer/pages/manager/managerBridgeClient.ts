/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the Manager IPC surface (Personal Manager feature).
 *
 * The Main-process bridge module (`process/manager/managerBridge.ts`) pulls in
 * Electron + Node `fs` (via `managerStore.ts`), so it must NOT be imported into
 * the renderer at runtime. Mirroring `companyBridgeClient.ts`/`browserBridgeClient.ts`,
 * this module:
 *
 * - re-declares the channel-name strings (kept in sync with `MANAGER_CHANNELS`),
 * - rebuilds matching `bridge.buildProvider(...)` invokers from those names,
 * - wraps each call with a short timeout so an unregistered channel rejects
 *   instead of hanging (the page then shows a friendly "not ready" notice).
 *
 * Only **types** are borrowed from Main-process modules via `import type`
 * (erased at compile time, safe across the process boundary).
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  AddEventRequest,
  AddNoteRequest,
  AddTaskRequest,
  AiOptimizeRequest,
  AiParseImageRequest,
  AiParseMultiRequest,
  AiParseScheduleRequest,
  AiParseTasksRequest,
  AiResearchRequest,
  AiSummarizeDocRequest,
  ExtractFilesRequest,
  ExtractedFile,
  IdRequest,
  ManagerResult,
  ReminderRefRequest,
  SetEventsRequest,
  SetTaskStatusRequest,
  ToggleSubtaskRequest,
  UpdateEventRequest,
  UpdateNoteRequest,
  UpdateSettingsRequest,
  UpdateTaskRequest,
} from '@process/manager/managerBridge';
import type { EventProposal, TaskProposal } from '@process/manager/managerAi';
import type {
  DataInsight,
  ManagerData,
  OptimizeResult,
  ResearchResult,
  TaskSuggestion,
} from '@process/manager/managerTypes';

/** Manager IPC channel names. Mirrors `MANAGER_CHANNELS` in the bridge. */
const MANAGER_CHANNELS = {
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

/** How long to wait for an IPC reply before treating the bridge as not wired. */
const BRIDGE_TIMEOUT_MS = 4000;
/** AI calls legitimately take longer (model round-trip); give them more room. */
const AI_TIMEOUT_MS = 120_000;

const channels = {
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

/** Error thrown when a manager IPC call does not reply within its budget. */
export class ManagerBridgeTimeoutError extends Error {
  constructor(channel: string) {
    super(`[ManagerBridgeClient] No reply on "${channel}" — the manager bridge may not be wired yet.`);
    this.name = 'ManagerBridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so a missing handler rejects, not hangs. */
const withTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new ManagerBridgeTimeoutError(channel));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/**
 * Timeout-guarded Manager invokers. Each method resolves with the bridge's
 * {@link ManagerResult} envelope, or rejects on timeout so the page can show a
 * friendly "not ready" notice.
 */
export const managerClient = {
  getData: () => withTimeout(MANAGER_CHANNELS.getData, () => channels.getData.invoke(), BRIDGE_TIMEOUT_MS),
  addTask: (req: AddTaskRequest) =>
    withTimeout(MANAGER_CHANNELS.addTask, () => channels.addTask.invoke(req), BRIDGE_TIMEOUT_MS),
  updateTask: (req: UpdateTaskRequest) =>
    withTimeout(MANAGER_CHANNELS.updateTask, () => channels.updateTask.invoke(req), BRIDGE_TIMEOUT_MS),
  removeTask: (req: IdRequest) =>
    withTimeout(MANAGER_CHANNELS.removeTask, () => channels.removeTask.invoke(req), BRIDGE_TIMEOUT_MS),
  toggleSubtask: (req: ToggleSubtaskRequest) =>
    withTimeout(MANAGER_CHANNELS.toggleSubtask, () => channels.toggleSubtask.invoke(req), BRIDGE_TIMEOUT_MS),
  setTaskStatus: (req: SetTaskStatusRequest) =>
    withTimeout(MANAGER_CHANNELS.setTaskStatus, () => channels.setTaskStatus.invoke(req), BRIDGE_TIMEOUT_MS),
  addNote: (req: AddNoteRequest) =>
    withTimeout(MANAGER_CHANNELS.addNote, () => channels.addNote.invoke(req), BRIDGE_TIMEOUT_MS),
  updateNote: (req: UpdateNoteRequest) =>
    withTimeout(MANAGER_CHANNELS.updateNote, () => channels.updateNote.invoke(req), BRIDGE_TIMEOUT_MS),
  removeNote: (req: IdRequest) =>
    withTimeout(MANAGER_CHANNELS.removeNote, () => channels.removeNote.invoke(req), BRIDGE_TIMEOUT_MS),
  addEvent: (req: AddEventRequest) =>
    withTimeout(MANAGER_CHANNELS.addEvent, () => channels.addEvent.invoke(req), BRIDGE_TIMEOUT_MS),
  updateEvent: (req: UpdateEventRequest) =>
    withTimeout(MANAGER_CHANNELS.updateEvent, () => channels.updateEvent.invoke(req), BRIDGE_TIMEOUT_MS),
  removeEvent: (req: IdRequest) =>
    withTimeout(MANAGER_CHANNELS.removeEvent, () => channels.removeEvent.invoke(req), BRIDGE_TIMEOUT_MS),
  setEvents: (req: SetEventsRequest) =>
    withTimeout(MANAGER_CHANNELS.setEvents, () => channels.setEvents.invoke(req), BRIDGE_TIMEOUT_MS),
  updateSettings: (req: UpdateSettingsRequest) =>
    withTimeout(MANAGER_CHANNELS.updateSettings, () => channels.updateSettings.invoke(req), BRIDGE_TIMEOUT_MS),
  snoozeReminder: (req: ReminderRefRequest) =>
    withTimeout(MANAGER_CHANNELS.snoozeReminder, () => channels.snoozeReminder.invoke(req), BRIDGE_TIMEOUT_MS),
  dismissReminder: (req: ReminderRefRequest) =>
    withTimeout(MANAGER_CHANNELS.dismissReminder, () => channels.dismissReminder.invoke(req), BRIDGE_TIMEOUT_MS),
  aiParseTasks: (req: AiParseTasksRequest) =>
    withTimeout(MANAGER_CHANNELS.aiParseTasks, () => channels.aiParseTasks.invoke(req), AI_TIMEOUT_MS),
  aiReviewTasks: () =>
    withTimeout(MANAGER_CHANNELS.aiReviewTasks, () => channels.aiReviewTasks.invoke(), AI_TIMEOUT_MS),
  aiParseSchedule: (req: AiParseScheduleRequest) =>
    withTimeout(MANAGER_CHANNELS.aiParseSchedule, () => channels.aiParseSchedule.invoke(req), AI_TIMEOUT_MS),
  aiParseImage: (req: AiParseImageRequest) =>
    withTimeout(MANAGER_CHANNELS.aiParseImage, () => channels.aiParseImage.invoke(req), AI_TIMEOUT_MS),
  aiParseMulti: (req: AiParseMultiRequest) =>
    withTimeout(MANAGER_CHANNELS.aiParseMulti, () => channels.aiParseMulti.invoke(req), AI_TIMEOUT_MS),
  extractFiles: (req: ExtractFilesRequest) =>
    withTimeout(MANAGER_CHANNELS.extractFiles, () => channels.extractFiles.invoke(req), AI_TIMEOUT_MS),
  aiOptimize: (req: AiOptimizeRequest) =>
    withTimeout(MANAGER_CHANNELS.aiOptimize, () => channels.aiOptimize.invoke(req), AI_TIMEOUT_MS),
  aiResearch: (req: AiResearchRequest) =>
    withTimeout(MANAGER_CHANNELS.aiResearch, () => channels.aiResearch.invoke(req), AI_TIMEOUT_MS),
  aiSummarizeDoc: (req: AiSummarizeDocRequest) =>
    withTimeout(MANAGER_CHANNELS.aiSummarizeDoc, () => channels.aiSummarizeDoc.invoke(req), AI_TIMEOUT_MS),
  /** Subscribe to live document changes (main → renderer). Returns an unsubscribe fn. */
  onDataChanged: (listener: (data: ManagerData) => void): (() => void) => channels.dataChanged.on(listener),
};
