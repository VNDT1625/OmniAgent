/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared constants + a one-shot cross-page hand-off for the Testing page.
 *
 * The Quick Active sidebar section lists active test sessions and, when one is
 * clicked, navigates to `/settings/testing` and asks the page to select that
 * session. Sessions are Main-process state addressed by id, so this is a plain
 * in-memory hand-off (not persisted) consumed once by {@link useTestingState} on
 * mount. Renderer-only module: no Node.js APIs.
 */

let requestedSessionId: string | null = null;

/** Ask the Testing page to select `sessionId` the next time it mounts. */
export const requestActiveSession = (sessionId: string): void => {
  requestedSessionId = sessionId;
};

/** Read and clear the pending session request (returns `null` when none). */
export const consumeRequestedSession = (): string | null => {
  const id = requestedSessionId;
  requestedSessionId = null;
  return id;
};
