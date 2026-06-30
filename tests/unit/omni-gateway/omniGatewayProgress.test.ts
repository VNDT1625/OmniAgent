/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Omni External MCP Gateway "Web Access" progress layer.
 *
 * Two concerns are covered:
 *  1. `omniGatewayProgress` pure helpers — `makeProgressEmitter` stamping /
 *     no-op behaviour and the `OMNI_GATEWAY_INFLIGHT_PHASES` membership set.
 *  2. `startOmniTunnel` integration — the Cloudflare tunnel helper is fully
 *     mocked so we can assert the per-phase `onProgress` events fire in the
 *     correct ORDER for the happy paths and every failure path, without ever
 *     touching `electron`, the filesystem, or a real `cloudflared` process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tunnel adapter imports `@process/studio/cloudflareTunnel`, which itself
// imports `electron` at module load. Mock the whole module so neither electron
// nor a real binary is ever required, and so each test can script the outcome.
vi.mock('@process/studio/cloudflareTunnel', () => ({
  isCloudflaredAvailable: vi.fn(),
  ensureCloudflared: vi.fn(),
  startTunnel: vi.fn(),
  stopTunnel: vi.fn(),
}));

import {
  makeProgressEmitter,
  OMNI_GATEWAY_INFLIGHT_PHASES,
  type OmniGatewayProgressEvent,
  type OmniGatewayProgressPhase,
} from '@/process/omni-gateway/omniGatewayProgress';
import { OMNI_GATEWAY_TUNNEL_KEY, startOmniTunnel, stopOmniTunnel } from '@/process/omni-gateway/omniGatewayTunnel';
import {
  ensureCloudflared,
  isCloudflaredAvailable,
  startTunnel,
  stopTunnel,
  type TunnelResult,
} from '@process/studio/cloudflareTunnel';

const mockIsAvailable = vi.mocked(isCloudflaredAvailable);
const mockEnsure = vi.mocked(ensureCloudflared);
const mockStartTunnel = vi.mocked(startTunnel);
const mockStopTunnel = vi.mocked(stopTunnel);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1) Pure helpers
// ---------------------------------------------------------------------------

describe('omniGatewayProgress — makeProgressEmitter', () => {
  it('is a no-op when no sink is provided (never throws)', () => {
    const emit = makeProgressEmitter(undefined);
    expect(() => emit('checking-cloudflared')).not.toThrow();
    expect(() => emit('ready', { tunnelUrl: 'https://x.trycloudflare.com' })).not.toThrow();
  });

  it('stamps `at` from the injected clock and forwards the phase', () => {
    const events: OmniGatewayProgressEvent[] = [];
    let t = 1000;
    const emit = makeProgressEmitter(
      (e) => events.push(e),
      () => t
    );

    emit('checking-cloudflared');
    t = 2500;
    emit('spawning-tunnel');

    expect(events).toEqual([
      { phase: 'checking-cloudflared', at: 1000, message: undefined, tunnelUrl: undefined, error: undefined },
      { phase: 'spawning-tunnel', at: 2500, message: undefined, tunnelUrl: undefined, error: undefined },
    ]);
  });

  it('copies optional message / tunnelUrl / error from extra', () => {
    const events: OmniGatewayProgressEvent[] = [];
    const emit = makeProgressEmitter(
      (e) => events.push(e),
      () => 42
    );

    emit('installing-cloudflared', { message: 'Downloading…' });
    emit('ready', { tunnelUrl: 'https://abc.trycloudflare.com' });
    emit('failed', { error: 'boom' });

    expect(events[0]).toMatchObject({ phase: 'installing-cloudflared', message: 'Downloading…', at: 42 });
    expect(events[1]).toMatchObject({ phase: 'ready', tunnelUrl: 'https://abc.trycloudflare.com' });
    expect(events[2]).toMatchObject({ phase: 'failed', error: 'boom' });
  });

  it('defaults the clock to Date.now when none is injected', () => {
    const events: OmniGatewayProgressEvent[] = [];
    const before = Date.now();
    makeProgressEmitter((e) => events.push(e))('minting-token');
    const after = Date.now();

    expect(events).toHaveLength(1);
    expect(events[0].at).toBeGreaterThanOrEqual(before);
    expect(events[0].at).toBeLessThanOrEqual(after);
  });
});

describe('omniGatewayProgress — OMNI_GATEWAY_INFLIGHT_PHASES', () => {
  it('contains exactly the in-flight phases', () => {
    expect([...OMNI_GATEWAY_INFLIGHT_PHASES].toSorted()).toEqual(
      [
        'checking-cloudflared',
        'installing-cloudflared',
        'minting-token',
        'spawning-tunnel',
        'stopping',
        'waiting-tunnel-url',
      ].toSorted()
    );
  });

  it('excludes terminal / idle phases', () => {
    const terminal: OmniGatewayProgressPhase[] = ['idle', 'ready', 'failed', 'stopped'];
    for (const phase of terminal) {
      expect(OMNI_GATEWAY_INFLIGHT_PHASES.has(phase)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2) startOmniTunnel integration (mocked cloudflareTunnel)
// ---------------------------------------------------------------------------

/** Capture the ordered phases emitted to `onProgress`. */
const recordPhases = () => {
  const phases: OmniGatewayProgressPhase[] = [];
  return { phases, onProgress: (phase: OmniGatewayProgressPhase) => phases.push(phase) };
};

describe('startOmniTunnel — happy paths', () => {
  it('emits checking → spawning → waiting when cloudflared is already present', async () => {
    mockIsAvailable.mockResolvedValue(true);
    // startTunnel fires onSpawn (→ waiting-tunnel-url) then resolves with a URL.
    mockStartTunnel.mockImplementation(async (_key, _url, opts) => {
      if (opts && typeof opts !== 'number') opts.onSpawn?.();
      return { ok: true, url: 'https://happy.trycloudflare.com' } satisfies TunnelResult;
    });

    const { phases, onProgress } = recordPhases();
    const result = await startOmniTunnel(47821, { onProgress });

    expect(result).toEqual({ ok: true, url: 'https://happy.trycloudflare.com' });
    expect(phases).toEqual(['checking-cloudflared', 'spawning-tunnel', 'waiting-tunnel-url']);
    // Already available → must NOT attempt an install.
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(mockStartTunnel).toHaveBeenCalledWith(
      OMNI_GATEWAY_TUNNEL_KEY,
      'http://127.0.0.1:47821',
      expect.objectContaining({ onSpawn: expect.any(Function) })
    );
  });

  it('emits checking → installing → spawning → waiting when cloudflared must be installed', async () => {
    mockIsAvailable.mockResolvedValue(false);
    mockEnsure.mockResolvedValue({ ok: true, installed: true });
    mockStartTunnel.mockImplementation(async (_key, _url, opts) => {
      if (opts && typeof opts !== 'number') opts.onSpawn?.();
      return { ok: true, url: 'https://installed.trycloudflare.com' } satisfies TunnelResult;
    });

    const { phases, onProgress } = recordPhases();
    const result = await startOmniTunnel(50000, { onProgress });

    expect(result).toEqual({ ok: true, url: 'https://installed.trycloudflare.com' });
    expect(phases).toEqual(['checking-cloudflared', 'installing-cloudflared', 'spawning-tunnel', 'waiting-tunnel-url']);
    expect(mockEnsure).toHaveBeenCalledOnce();
  });
});

describe('startOmniTunnel — failure paths', () => {
  it('stops after install when ensureCloudflared fails (install-failed)', async () => {
    mockIsAvailable.mockResolvedValue(false);
    mockEnsure.mockResolvedValue({ ok: false, detail: 'no network' });

    const { phases, onProgress } = recordPhases();
    const result = await startOmniTunnel(47821, { onProgress });

    expect(result).toEqual({ ok: false, reason: 'install-failed', detail: 'no network' });
    // Phase sequence halts before spawning; startTunnel never runs.
    expect(phases).toEqual(['checking-cloudflared', 'installing-cloudflared']);
    expect(mockStartTunnel).not.toHaveBeenCalled();
  });

  it('maps a not-installed tunnel result to cloudflared-missing', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockStartTunnel.mockResolvedValue({ ok: false, reason: 'not-installed', detail: 'gone' });

    const { phases, onProgress } = recordPhases();
    const result = await startOmniTunnel(47821, { onProgress });

    expect(result).toEqual({ ok: false, reason: 'cloudflared-missing', detail: 'gone' });
    // onSpawn never fired → no waiting-tunnel-url phase.
    expect(phases).toEqual(['checking-cloudflared', 'spawning-tunnel']);
  });

  it('passes through a start-failed tunnel result', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockStartTunnel.mockResolvedValue({ ok: false, reason: 'start-failed', detail: 'spawn EACCES' });

    const result = await startOmniTunnel(47821);

    expect(result).toEqual({ ok: false, reason: 'start-failed', detail: 'spawn EACCES' });
  });

  it('passes through a timeout tunnel result', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockStartTunnel.mockResolvedValue({ ok: false, reason: 'timeout' });

    const result = await startOmniTunnel(47821);

    expect(result).toEqual({ ok: false, reason: 'timeout', detail: undefined });
  });
});

describe('startOmniTunnel — robustness', () => {
  it('never lets a throwing onProgress sink break the lifecycle', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockStartTunnel.mockImplementation(async (_key, _url, opts) => {
      if (opts && typeof opts !== 'number') opts.onSpawn?.();
      return { ok: true, url: 'https://safe.trycloudflare.com' } satisfies TunnelResult;
    });

    const onProgress = vi.fn(() => {
      throw new Error('sink exploded');
    });

    await expect(startOmniTunnel(47821, { onProgress })).resolves.toEqual({
      ok: true,
      url: 'https://safe.trycloudflare.com',
    });
    expect(onProgress).toHaveBeenCalled();
  });

  it('works with no options object (onProgress optional)', async () => {
    mockIsAvailable.mockResolvedValue(true);
    mockStartTunnel.mockResolvedValue({ ok: true, url: 'https://noopts.trycloudflare.com' });

    await expect(startOmniTunnel(47821)).resolves.toEqual({
      ok: true,
      url: 'https://noopts.trycloudflare.com',
    });
  });
});

describe('stopOmniTunnel', () => {
  it('delegates to stopTunnel with the gateway key', () => {
    stopOmniTunnel();
    expect(mockStopTunnel).toHaveBeenCalledWith(OMNI_GATEWAY_TUNNEL_KEY);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
