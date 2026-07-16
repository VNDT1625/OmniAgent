/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `collabDiscovery` — zero-config LAN discovery for collaboration sessions, so
 * peers don't have to type the host's `<ip>:<port>`. Fully offline (no Internet,
 * no central server): the host periodically UDP-broadcasts a small beacon on the
 * local subnet; peers listen and show the discovered sessions to pick from.
 *
 * Security note: the beacon only ADVERTISES a session (title + join code +
 * host name) — it carries NO password and grants NO access. Joining still
 * requires the password (verified by {@link collabServer}). Broadcast stays on
 * the local network; it never leaves the LAN.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs. Everything is
 * best-effort and wrapped so a network that blocks UDP broadcast never throws.
 */

import { createSocket, type Socket } from 'node:dgram';

/** UDP port both the beacon and the listener use (must match across the LAN). */
const DISCOVERY_PORT = 41329;
/** Magic tag so we ignore unrelated datagrams on the port. */
const MAGIC = 'aionui-collab-v1';
/** Subnet broadcast address. */
const BROADCAST_ADDR = '255.255.255.255';
/** How often the host re-broadcasts its beacon. */
const BEACON_INTERVAL_MS = 2000;
/** A discovered session is dropped if not seen within this window. */
const STALE_MS = 8000;

/** What the host advertises about a published session. */
export type BeaconInfo = {
  shareId: string;
  /** `<ip>:<port>` peers use to join. */
  joinCode: string;
  title: string;
  fileType: string;
  hostName: string;
};

/** A session discovered on the LAN (beacon + freshness). */
export type DiscoveredSession = BeaconInfo & { lastSeen: number };

// --- Beacon (host side) ----------------------------------------------------

let beaconSocket: Socket | null = null;
let beaconTimer: NodeJS.Timeout | null = null;
let beaconInfo: BeaconInfo | null = null;

/** Send one beacon datagram (best-effort). */
const sendBeacon = (): void => {
  if (!beaconSocket || !beaconInfo) return;
  try {
    const payload = Buffer.from(JSON.stringify({ magic: MAGIC, ...beaconInfo, at: Date.now() }), 'utf8');
    beaconSocket.send(payload, 0, payload.length, DISCOVERY_PORT, BROADCAST_ADDR);
  } catch {
    /* broadcast unavailable — discovery just won't work, joining by code still does */
  }
};

/** Start broadcasting a beacon for `info` on the LAN. Replaces any prior beacon. */
export const startBeacon = (info: BeaconInfo): void => {
  beaconInfo = info;
  if (beaconSocket) {
    sendBeacon();
    return;
  }
  try {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => stopBeacon());
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* ignore */
      }
      sendBeacon();
    });
    beaconSocket = socket;
    beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS);
  } catch {
    beaconSocket = null;
  }
};

/** Stop broadcasting. */
export const stopBeacon = (): void => {
  if (beaconTimer) {
    clearInterval(beaconTimer);
    beaconTimer = null;
  }
  beaconInfo = null;
  if (beaconSocket) {
    try {
      beaconSocket.close();
    } catch {
      /* ignore */
    }
    beaconSocket = null;
  }
};

// --- Discovery (peer side) -------------------------------------------------

let discoverSocket: Socket | null = null;
const discovered = new Map<string, DiscoveredSession>();

/** Begin listening for beacons. Idempotent. */
export const startDiscovery = (): void => {
  if (discoverSocket) return;
  try {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('error', () => stopDiscovery());
    socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString('utf8')) as Partial<DiscoveredSession> & { magic?: string };
        if (data.magic !== MAGIC || !data.shareId || !data.joinCode) return;
        discovered.set(data.shareId, {
          shareId: data.shareId,
          joinCode: data.joinCode,
          title: data.title ?? '',
          fileType: data.fileType ?? '',
          hostName: data.hostName ?? '',
          lastSeen: Date.now(),
        });
      } catch {
        /* ignore malformed datagram */
      }
    });
    socket.bind(DISCOVERY_PORT);
    discoverSocket = socket;
  } catch {
    discoverSocket = null;
  }
};

/** Stop listening and clear the discovered set. */
export const stopDiscovery = (): void => {
  if (discoverSocket) {
    try {
      discoverSocket.close();
    } catch {
      /* ignore */
    }
    discoverSocket = null;
  }
  discovered.clear();
};

/** The currently-visible discovered sessions (stale entries pruned). */
export const listDiscovered = (): DiscoveredSession[] => {
  const now = Date.now();
  const fresh: DiscoveredSession[] = [];
  for (const [id, session] of discovered) {
    if (now - session.lastSeen > STALE_MS) discovered.delete(id);
    else fresh.push(session);
  }
  return fresh.toSorted((a, b) => b.lastSeen - a.lastSeen);
};
