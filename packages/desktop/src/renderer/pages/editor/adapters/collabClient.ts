/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the real-time collaboration bridge (publish / join /
 * presence). The host publishes the open document; peers on the LAN join with a
 * code + password. The heavy lifting (HTTP control surface, password check) is
 * in the Main process; this is a thin typed wrapper.
 *
 * Renderer-only. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  CollabDiscoverResult,
  CollabJoinData,
  CollabJoinResult,
  CollabParticipantsResult,
  CollabPublishResult,
} from '@process/studio/onlyOfficeBridge';
import type { CollabParticipant, PublishInfo } from '@process/studio/collabServer';
import type { DiscoveredSession } from '@process/studio/collabDiscovery';

const COLLAB_CHANNELS = {
  publish: 'studio.collab-publish',
  unpublish: 'studio.collab-unpublish',
  join: 'studio.collab-join',
  participants: 'studio.collab-participants',
  discoverStart: 'studio.collab-discover-start',
  discoverStop: 'studio.collab-discover-stop',
  discoverList: 'studio.collab-discover-list',
} as const;

/** localStorage keys for the host's chosen password + display name. */
export const COLLAB_PASSWORD_KEY = 'studio.collab.password';
export const COLLAB_NAME_KEY = 'studio.collab.name';

const publishProvider = bridge.buildProvider<
  CollabPublishResult,
  {
    path: string;
    documentServerUrl: string;
    password?: string;
    hostName?: string;
    advertisedHost?: string;
    online?: boolean;
  }
>(COLLAB_CHANNELS.publish);
const unpublishProvider = bridge.buildProvider<{ ok: true }, { shareId: string }>(COLLAB_CHANNELS.unpublish);
const joinProvider = bridge.buildProvider<CollabJoinResult, { joinCode: string; password: string; name?: string }>(
  COLLAB_CHANNELS.join
);
const participantsProvider = bridge.buildProvider<CollabParticipantsResult, { shareId: string; baseUrl?: string }>(
  COLLAB_CHANNELS.participants
);
const discoverStartProvider = bridge.buildProvider<{ ok: true }, void>(COLLAB_CHANNELS.discoverStart);
const discoverStopProvider = bridge.buildProvider<{ ok: true }, void>(COLLAB_CHANNELS.discoverStop);
const discoverListProvider = bridge.buildProvider<CollabDiscoverResult, void>(COLLAB_CHANNELS.discoverList);

export type { CollabJoinData, CollabParticipant, PublishInfo, DiscoveredSession };

/** Read/persist the host's join password (default 123456). */
export const getCollabPassword = (): string => {
  try {
    return localStorage.getItem(COLLAB_PASSWORD_KEY) || '123456';
  } catch {
    return '123456';
  }
};
export const setCollabPassword = (pw: string): void => {
  try {
    localStorage.setItem(COLLAB_PASSWORD_KEY, pw);
  } catch {
    /* non-fatal */
  }
};

/** Read/persist the user's display name for collaboration. */
export const getCollabName = (): string => {
  try {
    return localStorage.getItem(COLLAB_NAME_KEY) || '';
  } catch {
    return '';
  }
};
export const setCollabName = (name: string): void => {
  try {
    localStorage.setItem(COLLAB_NAME_KEY, name);
  } catch {
    /* non-fatal */
  }
};

const withTimeout = <T>(call: () => Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Collaboration bridge timed out — restart the app so the bridge is wired.'));
    }, ms);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Publish the open file for LAN co-editing; returns the join code + URLs. */
export const publishCollab = (params: {
  path: string;
  documentServerUrl: string;
  password?: string;
  hostName?: string;
  advertisedHost?: string;
  online?: boolean;
}): Promise<CollabPublishResult> => withTimeout(() => publishProvider.invoke(params), 240000);

/** Stop sharing a session. */
export const unpublishCollab = async (shareId: string): Promise<void> => {
  try {
    await withTimeout(() => unpublishProvider.invoke({ shareId }), 8000);
  } catch {
    /* best-effort */
  }
};

/** Join a host's published doc with code + password. */
export const joinCollab = (params: { joinCode: string; password: string; name?: string }): Promise<CollabJoinResult> =>
  withTimeout(() => joinProvider.invoke(params), 15000);

/** Poll the participant/presence list (host reads local; peer polls the host). */
export const fetchParticipants = async (shareId: string, baseUrl?: string): Promise<CollabParticipant[]> => {
  try {
    const res = await withTimeout(() => participantsProvider.invoke({ shareId, baseUrl }), 8000);
    return res.ok ? res.participants : [];
  } catch {
    return [];
  }
};

/** Begin/stop LAN auto-discovery of published sessions (offline, UDP broadcast). */
export const startDiscovery = async (): Promise<void> => {
  try {
    await withTimeout(() => discoverStartProvider.invoke(), 6000);
  } catch {
    /* best-effort */
  }
};
export const stopDiscovery = async (): Promise<void> => {
  try {
    await withTimeout(() => discoverStopProvider.invoke(), 6000);
  } catch {
    /* best-effort */
  }
};

/** List sessions discovered on the LAN. */
export const listDiscovered = async (): Promise<DiscoveredSession[]> => {
  try {
    const res = await withTimeout(() => discoverListProvider.invoke(), 6000);
    return res.ok ? res.sessions : [];
  } catch {
    return [];
  }
};
