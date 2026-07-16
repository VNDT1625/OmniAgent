/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wiring for the Personal Manager feature — builds the single set of services
 * both planes share: the renderer UI (via `managerBridge`) and the global
 * bootstrap.
 *
 * {@link getManagerServices} lazily constructs (and then caches) the store, the
 * AI helper, and the reminder scheduler. The store/scheduler resolve their
 * on-disk root from the Electron `userData` dir lazily, so no `app` access
 * happens at import time.
 *
 * ## Live model selection
 *
 * The Manager AI calls the user's configured model. Rather than binding a fixed
 * model id at construction, the AI helper here resolves the current model on
 * each call from `GET /api/providers` (mirrors `company/companyGenerator.ts`):
 * the underlying `createProviderChat` then issues the request and falls back to
 * the first usable provider/model when the resolved id is gone. When nothing is
 * configured the helper throws the "no usable model" sentinel, which the bridge
 * turns into a `code: 'no-model'` result so the UI shows the right hint.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import { showNotification } from '@process/bridge/notificationBridge';
import { createProviderChat } from '@process/browser/providerChat';
import { createManagerAi, type IManagerAi } from './managerAi';
import { createManagerStore, type IManagerStore } from './managerStore';
import { createReminderScheduler, type IReminderScheduler } from './reminderScheduler';

/** The shared Manager services for the whole Main process. */
export type ManagerServices = {
  store: IManagerStore;
  ai: IManagerAi;
  scheduler: IReminderScheduler;
};

/** Whether a provider is configured enough to issue a chat call. */
const isUsable = (p: IProvider): boolean =>
  p.enabled !== false && Boolean(p.api_key) && Boolean(p.base_url) && Array.isArray(p.models) && p.models.length > 0;

/** Resolve the user's current default model id (first enabled model of a usable provider). */
const resolveModelId = async (): Promise<string> => {
  const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];
  for (const provider of providers.filter(isUsable)) {
    const model = provider.models.find((m) => provider.model_enabled?.[m] !== false) ?? provider.models[0];
    if (model) return model;
  }
  throw new Error('No usable model is configured. Open Settings → Model and add a provider/model.');
};

/**
 * An {@link IManagerAi} that resolves the user's current model on each call, so
 * changing the model in Settings takes effect without a restart. Delegates to a
 * freshly-bound {@link createManagerAi} per call.
 */
const createLiveManagerAi = (): IManagerAi => {
  const chat = createProviderChat();
  const build = async (): Promise<IManagerAi> => createManagerAi({ chat, model: await resolveModelId() });
  return {
    parseTasks: async (description) => (await build()).parseTasks(description),
    reviewTasks: async (tasks) => (await build()).reviewTasks(tasks),
    parseSchedule: async (text) => (await build()).parseSchedule(text),
    parseScheduleImage: async (imageDataUrl) => (await build()).parseScheduleImage(imageDataUrl),
    parseScheduleMulti: async (input) => (await build()).parseScheduleMulti(input),
    optimizeSchedule: async (input) => (await build()).optimizeSchedule(input),
    researchTopic: async (topic) => (await build()).researchTopic(topic),
    summarizeDocument: async (input) => (await build()).summarizeDocument(input),
  };
};

let shared: ManagerServices | undefined;

/**
 * Resolve the shared {@link ManagerServices}, constructing the defaults on first
 * use. The reminder scheduler delivers through {@link showNotification} (which
 * already honours the `system.notificationEnabled` setting).
 */
export const getManagerServices = (): ManagerServices => {
  if (shared) return shared;
  const store = createManagerStore();
  const ai = createLiveManagerAi();
  const scheduler = createReminderScheduler({
    store,
    notify: ({ title, body }) => {
      void showNotification({ title, body });
    },
  });
  shared = { store, ai, scheduler };
  return shared;
};

/** Reset the cached services (deterministic teardown for tests/hot-reload). */
export const disposeManagerServices = (): void => {
  shared?.scheduler.stop();
  shared = undefined;
};
