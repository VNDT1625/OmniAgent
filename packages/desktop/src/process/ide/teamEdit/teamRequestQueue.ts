/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `teamRequestQueue` serialises remote IDE host work per shared workspace.
 *
 * LAN peers can arrive as B/C/D/... and all point at the same host repo. Without
 * a queue, a burst of remote reads, writes, graph loads, and DB queries all run
 * immediately on the host machine. This queue gives the host a small, explicit
 * back-pressure point: tasks are accepted in FIFO order per `rootPath` and only
 * `maxConcurrent` tasks are active at once.
 *
 * Process boundary: Main-process pure utility. No filesystem, network, or DOM.
 */

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_PENDING = 128;

export type TeamRequestQueueOptions = {
  /** Number of active remote tasks allowed per workspace. Defaults to 1. */
  maxConcurrent?: number;
  /** Number of waiting tasks allowed per workspace before rejecting new work. */
  maxPending?: number;
};

export type TeamRequestQueueStatus = {
  rootPath: string;
  running: number;
  pending: number;
  maxConcurrent: number;
  maxPending: number;
};

export type TeamRequestQueue = {
  enqueue: <T>(rootPath: string, label: string, task: () => Promise<T>) => Promise<T>;
  status: (rootPath: string) => TeamRequestQueueStatus;
  clear: (rootPath: string) => void;
};

type QueuedTask = {
  label: string;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type QueueLane = {
  rootPath: string;
  running: number;
  pending: QueuedTask[];
};

const positiveIntegerOrDefault = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
};

export const createTeamRequestQueue = (options: TeamRequestQueueOptions = {}): TeamRequestQueue => {
  const maxConcurrent = positiveIntegerOrDefault(options.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const maxPending = positiveIntegerOrDefault(options.maxPending, DEFAULT_MAX_PENDING);
  const lanes = new Map<string, QueueLane>();

  const laneFor = (rootPath: string): QueueLane => {
    const key = rootPath || '<unknown-root>';
    let lane = lanes.get(key);
    if (!lane) {
      lane = { rootPath: key, running: 0, pending: [] };
      lanes.set(key, lane);
    }
    return lane;
  };

  const maybeDisposeLane = (lane: QueueLane): void => {
    if (lane.running === 0 && lane.pending.length === 0) {
      lanes.delete(lane.rootPath);
    }
  };

  const drain = (lane: QueueLane): void => {
    while (lane.running < maxConcurrent && lane.pending.length > 0) {
      const job = lane.pending.shift();
      if (!job) return;
      lane.running += 1;
      void Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          lane.running -= 1;
          drain(lane);
          maybeDisposeLane(lane);
        });
    }
  };

  const enqueue = <T>(rootPath: string, label: string, task: () => Promise<T>): Promise<T> => {
    const lane = laneFor(rootPath);
    if (lane.pending.length >= maxPending) {
      return Promise.reject(
        new Error(
          `Remote IDE queue is full for ${lane.rootPath}; rejected ${label}. Ask a teammate to retry after current tasks finish.`
        )
      );
    }

    return new Promise<T>((resolve, reject) => {
      lane.pending.push({
        label,
        run: task,
        resolve: (value) => resolve(value as T),
        reject,
      });
      drain(lane);
    });
  };

  const status = (rootPath: string): TeamRequestQueueStatus => {
    const key = rootPath || '<unknown-root>';
    const lane = lanes.get(key);
    return {
      rootPath: key,
      running: lane?.running ?? 0,
      pending: lane?.pending.length ?? 0,
      maxConcurrent,
      maxPending,
    };
  };

  const clear = (rootPath: string): void => {
    const key = rootPath || '<unknown-root>';
    const lane = lanes.get(key);
    if (!lane) return;
    const pending = lane.pending.splice(0);
    lanes.delete(key);
    for (const job of pending) {
      job.reject(new Error(`Remote IDE queue was cleared for ${key}; cancelled ${job.label}.`));
    }
  };

  return { enqueue, status, clear };
};
