/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

export type PooledSession = {
  isBusy: () => boolean;
  dispose: () => void;
};

type SessionEntry<T extends PooledSession> = {
  token: symbol;
  promise: Promise<T>;
  resource?: T;
  lastUsedAt: number;
};

export type BoundedSessionPoolOptions = {
  maxSessions?: number;
  idleTimeoutMs?: number;
  now?: () => number;
};

/**
 * Bounded, idle-aware process pool. Startup promises are deduplicated and an
 * invalidated late process cannot delete or replace a newer generation.
 */
export class BoundedSessionPool<T extends PooledSession> {
  private readonly entries = new Map<string, SessionEntry<T>>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  public constructor(options: BoundedSessionPoolOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? 8);
    this.idleTimeoutMs = Math.max(1_000, options.idleTimeoutMs ?? 5 * 60_000);
    this.now = options.now ?? Date.now;
  }

  public get size(): number {
    return this.entries.size;
  }

  public async getOrCreate(key: string, factory: () => Promise<T>): Promise<T> {
    this.sweepIdle();
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsedAt = this.now();
      return existing.promise;
    }

    this.evictForCapacity();
    const token = Symbol(key);
    const entry: SessionEntry<T> = {
      token,
      promise: Promise.resolve().then(factory),
      lastUsedAt: this.now(),
    };
    this.entries.set(key, entry);
    entry.promise = entry.promise.then(
      (resource) => {
        const current = this.entries.get(key);
        if (current?.token !== token) {
          resource.dispose();
          return resource;
        }
        entry.resource = resource;
        entry.lastUsedAt = this.now();
        return resource;
      },
      (error: unknown) => {
        if (this.entries.get(key)?.token === token) this.entries.delete(key);
        throw error;
      }
    );
    return entry.promise;
  }

  public invalidate(key: string, expected?: T): boolean {
    const entry = this.entries.get(key);
    if (!entry || (expected && entry.resource && entry.resource !== expected)) return false;
    this.entries.delete(key);
    if (entry.resource) entry.resource.dispose();
    else void entry.promise.then((resource) => resource.dispose()).catch((): undefined => undefined);
    return true;
  }

  public touch(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.lastUsedAt = this.now();
  }

  public async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    const settled = await Promise.allSettled(entries.map((entry) => entry.promise));
    for (const result of settled) {
      if (result.status === 'fulfilled') result.value.dispose();
    }
  }

  private sweepIdle(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [key, entry] of this.entries) {
      if (!entry.resource || entry.resource.isBusy() || entry.lastUsedAt > cutoff) continue;
      this.invalidate(key, entry.resource);
    }
  }

  private evictForCapacity(): void {
    if (this.entries.size < this.maxSessions) return;
    const candidate = [...this.entries.entries()]
      .filter(([, entry]) => entry.resource && !entry.resource.isBusy())
      .toSorted((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0];
    if (!candidate?.[1].resource) {
      throw new Error(`Tomny session limit reached (${this.maxSessions}); wait for an active agent to finish.`);
    }
    this.invalidate(candidate[0], candidate[1].resource);
  }
}
