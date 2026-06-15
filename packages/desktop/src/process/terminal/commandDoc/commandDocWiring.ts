/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main-process wiring for the docTerminal command service singleton.
 *
 * Builds the {@link ICommandDocService} backed by the file store, with a
 * debounced flush scheduler (so a burst of captures coalesces into one disk
 * write ~750ms later). `init()` is awaited on first access; callers await
 * {@link getCommandDocService} which resolves once the persisted records load.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { createCommandDocStore } from './commandDocStore';
import { createCommandDocService, type ICommandDocService } from './commandDocService';

/** Debounce window for coalesced flushes. */
const FLUSH_DEBOUNCE_MS = 750;

let servicePromise: Promise<ICommandDocService> | undefined;

/** Resolve the process-wide docTerminal service (built + loaded once). */
export const getCommandDocService = (): Promise<ICommandDocService> => {
  if (servicePromise) return servicePromise;
  servicePromise = (async (): Promise<ICommandDocService> => {
    const store = createCommandDocStore();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const service = createCommandDocService({
      store,
      schedule: (flush) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          Promise.resolve(flush()).catch((error) => console.error('[CommandDoc] flush failed:', error));
        }, FLUSH_DEBOUNCE_MS);
      },
    });
    await service.init().catch((error) => console.error('[CommandDoc] init failed:', error));
    return service;
  })();
  return servicePromise;
};

/** Reset the cached singleton (tests). */
export const resetCommandDocService = (): void => {
  servicePromise = undefined;
};
