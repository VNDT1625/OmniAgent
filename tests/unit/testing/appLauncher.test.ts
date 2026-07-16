/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests the app launcher's multi-service orchestration (Yêu cầu 2b — UX): extra
 * services (backend, db, workers) start in order BEFORE the web app, each waited
 * on per its readiness, and everything is torn down in reverse order after the
 * run. A failure to become ready stops everything started so far.
 *
 * All side effects (spawn / URL probe / port probe / kill / sleep / clock) are
 * injected, so nothing is actually spawned or networked.
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createAppLauncher } from '@/process/testing/appLauncher';
import type { AppUnderTest } from '@/process/testing/testingTypes';

/** A minimal fake ChildProcess (EventEmitter + pid + stdio streams). */
const fakeChild = (): ChildProcess => {
  const emitter = new EventEmitter() as ChildProcess & EventEmitter;
  (emitter as { pid?: number }).pid = Math.floor(Math.random() * 100000) + 1;
  (emitter as { stdout?: EventEmitter }).stdout = new EventEmitter();
  (emitter as { stderr?: EventEmitter }).stderr = new EventEmitter();
  return emitter;
};

/**
 * Build a launcher whose probes succeed for a known set of urls/ports.
 *
 * `sleep` uses `setImmediate` to yield to the macrotask queue so async probes
 * can run between loop iterations without real wall-clock delay.
 * `now` advances by 1 second per call so timeout checks work without real time.
 */
const buildLauncher = (opts: { readyUrls?: Set<string>; readyPorts?: Set<number> }) => {
  const spawned: string[] = [];
  const killed: ChildProcess[] = [];
  const children: ChildProcess[] = [];
  let t = 0;

  const launcher = createAppLauncher({
    spawnProcess: (command: string) => {
      spawned.push(command);
      const child = fakeChild();
      children.push(child);
      return child;
    },
    probe: async (url: string) => opts.readyUrls?.has(url) ?? false,
    probePort: async (port: number) => opts.readyPorts?.has(port) ?? false,
    killTree: (child: ChildProcess) => {
      killed.push(child);
    },
    // Yield to the macrotask queue so async probes can interleave with the loop.
    sleep: () => new Promise<void>((resolve) => setImmediate(resolve)),
    // Advance time by 1 s per call so deadline checks work without real time.
    now: () => (t += 1000),
  });

  return { launcher, spawned, killed, children };
};

describe('appLauncher — multi-service orchestration', () => {
  it('starts services in order before the app, then stops all in reverse', { timeout: 5000 }, async () => {
    const app: AppUnderTest = {
      url: 'http://localhost:5173',
      command: 'npm run dev',
      services: [
        { name: 'DB', command: 'docker compose up db', ready: { type: 'port', port: 5432 } },
        { name: 'API', command: 'npm run api', ready: { type: 'url', url: 'http://localhost:3000/health' } },
      ],
    };

    const { launcher, spawned, killed, children } = buildLauncher({
      readyUrls: new Set(['http://localhost:5173', 'http://localhost:3000/health']),
      readyPorts: new Set([5432]),
    });

    const running = await launcher.start(app);

    // Started DB → API → app, in that order.
    expect(spawned).toEqual(['docker compose up db', 'npm run api', 'npm run dev']);

    await running.stop();
    // Stopped in reverse order: app → API → DB.
    expect(killed).toEqual([children[2], children[1], children[0]]);
  });

  it('waits for a port-based service before starting the next', { timeout: 5000 }, async () => {
    const app: AppUnderTest = {
      url: 'http://localhost:5173',
      command: 'npm run dev',
      services: [{ name: 'API', command: 'npm run api', ready: { type: 'port', port: 4000 } }],
    };
    const { launcher, spawned } = buildLauncher({
      readyUrls: new Set(['http://localhost:5173']),
      readyPorts: new Set([4000]),
    });
    const running = await launcher.start(app);
    expect(spawned).toContain('npm run api');
    await running.stop();
  });

  it('fails (and tears down) when a service never becomes ready', { timeout: 5000 }, async () => {
    const app: AppUnderTest = {
      url: 'http://localhost:5173',
      command: 'npm run dev',
      services: [{ name: 'API', command: 'npm run api', ready: { type: 'port', port: 9999 }, readyTimeoutMs: 1 }],
    };
    // Port 9999 is never ready → the API service times out.
    const { launcher, spawned, killed } = buildLauncher({ readyUrls: new Set(['http://localhost:5173']) });

    await expect(launcher.start(app)).rejects.toThrow(/Port 9999 did not open/i);
    // The API was spawned then killed; the app was never started.
    expect(spawned).toEqual(['npm run api']);
    expect(killed).toHaveLength(1);
  });

  it('reuses an already-running app (no command) and starts its services', { timeout: 5000 }, async () => {
    const app: AppUnderTest = {
      url: 'http://localhost:8080',
      services: [{ name: 'API', command: 'npm run api', ready: { type: 'port', port: 3001 } }],
    };
    const { launcher, spawned, killed, children } = buildLauncher({
      readyUrls: new Set(['http://localhost:8080']),
      readyPorts: new Set([3001]),
    });
    const running = await launcher.start(app);
    // Only the service is spawned; the app itself is assumed already running.
    expect(spawned).toEqual(['npm run api']);
    await running.stop();
    expect(killed).toEqual([children[0]]);
  });
});
