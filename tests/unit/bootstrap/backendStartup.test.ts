/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { startBackendOrExit } from '@/process/startup/backendStartup';
import { resolveCoreBootPolicy } from '@/process/startup/coreBootPolicy';

describe('resolveCoreBootPolicy', () => {
  it('boots the TypeScript Tomny core without starting the legacy backend by default', () => {
    expect(resolveCoreBootPolicy()).toEqual({
      mode: 'tomny',
      startLegacyBackend: false,
      requireLegacyBackend: false,
    });
  });

  it('keeps the legacy backend optional in compatibility mode', () => {
    expect(resolveCoreBootPolicy({ requestedMode: 'compat' })).toEqual({
      mode: 'compat',
      startLegacyBackend: true,
      requireLegacyBackend: false,
    });
  });

  it('makes the legacy backend fail-fast only when explicitly required', () => {
    expect(resolveCoreBootPolicy({ requestedMode: 'legacy' })).toEqual({
      mode: 'legacy',
      startLegacyBackend: true,
      requireLegacyBackend: true,
    });
  });

  it('rejects invalid modes instead of silently selecting a backend', () => {
    expect(() => resolveCoreBootPolicy({ requestedMode: 'future' })).toThrow('Invalid Tomny core boot mode');
  });

  it('preserves the legacy WebUI default until its HTTP routes are migrated', () => {
    expect(resolveCoreBootPolicy({ isWebUIMode: true })).toEqual({
      mode: 'legacy',
      startLegacyBackend: true,
      requireLegacyBackend: true,
    });
  });

  it('rejects backend-free mode for WebUI features that still require HTTP', () => {
    expect(() => resolveCoreBootPolicy({ requestedMode: 'tomny', isWebUIMode: true })).toThrow(
      'WebUI and password reset require'
    );
  });

  it('forces legacy startup for WebUI when compatibility was explicitly requested', () => {
    expect(resolveCoreBootPolicy({ requestedMode: 'compat', isWebUIMode: true })).toEqual({
      mode: 'legacy',
      startLegacyBackend: true,
      requireLegacyBackend: true,
    });
  });
});

describe('startBackendOrExit', () => {
  it('does not touch the legacy backend when Tomny-native startup disables it', async () => {
    const startBackend = vi.fn(async () => 42123);
    const onStarted = vi.fn();
    const captureFailure = vi.fn();
    const exitApp = vi.fn();

    const result = await startBackendOrExit({
      enabled: false,
      startBackend,
      onStarted,
      captureFailure,
      exitApp,
    });

    expect(result).toEqual({ ok: true, skipped: true });
    expect(startBackend).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
    expect(captureFailure).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });
  it('registers the backend port when startup succeeds', async () => {
    const onStarted = vi.fn();
    const captureFailure = vi.fn();
    const exitApp = vi.fn();

    const result = await startBackendOrExit({
      startBackend: async () => 42123,
      onStarted,
      captureFailure,
      exitApp,
      logError: vi.fn(),
    });

    expect(result).toEqual({ ok: true, port: 42123 });
    expect(onStarted).toHaveBeenCalledWith(42123);
    expect(captureFailure).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
  });

  it('captures startup failure and exits without registering a backend port by default', async () => {
    const error = new Error('aioncore failed to start within timeout');
    const calls: string[] = [];
    const onStarted = vi.fn();
    const captureFailure = vi.fn(async () => {
      calls.push('capture-start');
      await Promise.resolve();
      calls.push('capture-end');
    });
    const exitApp = vi.fn(() => {
      calls.push('exit');
    });
    const logError = vi.fn();

    const result = await startBackendOrExit({
      startBackend: async () => {
        throw error;
      },
      onStarted,
      captureFailure,
      exitApp,
      logError,
    });

    expect(result).toEqual({ ok: false });
    expect(logError).toHaveBeenCalledWith('[AionUi] Failed to start aioncore:', error);
    expect(captureFailure).toHaveBeenCalledWith(error);
    expect(exitApp).toHaveBeenCalledWith(1);
    expect(calls).toEqual(['capture-start', 'capture-end', 'exit']);
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('captures startup failure without dialog or exit when exitOnFailure is disabled', async () => {
    const error = new Error('aioncore exited before health check passed');
    const onStarted = vi.fn();
    const captureFailure = vi.fn();
    const exitApp = vi.fn();
    const logError = vi.fn();

    const result = await startBackendOrExit({
      startBackend: async () => {
        throw error;
      },
      onStarted,
      captureFailure,
      exitApp,
      exitOnFailure: false,
      logError,
    });

    expect(result).toEqual({ ok: false });
    expect(logError).toHaveBeenCalledWith('[AionUi] Failed to start aioncore:', error);
    expect(captureFailure).toHaveBeenCalledWith(error);
    expect(exitApp).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });

  it('does not capture or exit when backend startup is cancelled by shutdown', async () => {
    const error = new Error('aioncore startup cancelled');
    error.name = 'BackendStartupCancelledError';
    const onStarted = vi.fn();
    const captureFailure = vi.fn();
    const exitApp = vi.fn();
    const logError = vi.fn();

    const result = await startBackendOrExit({
      startBackend: async () => {
        throw error;
      },
      onStarted,
      captureFailure,
      exitApp,
      logError,
    });

    expect(result).toEqual({ ok: false });
    expect(logError).not.toHaveBeenCalled();
    expect(captureFailure).not.toHaveBeenCalled();
    expect(exitApp).not.toHaveBeenCalled();
    expect(onStarted).not.toHaveBeenCalled();
  });
});
