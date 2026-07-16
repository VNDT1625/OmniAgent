/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Property 1 ("Cách ly người dùng" / user isolation) for the testing layer
 * (Yêu cầu 2b, criteria 2.2 / 2.8): Windows (and every) test session runs in an
 * isolated virtual display; if none can be created the system ERRORS — it NEVER
 * falls back to the user's real desktop. Also: all driver input is confined to
 * the isolated display target, never OS-global.
 *
 * Validates: Requirements 2.2, 2.8
 */

import { describe, expect, it, vi } from 'vitest';
import { createVirtualDisplayManager, type DisplayBackend } from '@/process/testing/virtualDisplayManager';
import { createComputerUseDriver, type DisplayInputSink, type VisionAction } from '@/process/testing/computerUseDriver';

/** A backend that always reports unsupported (cannot create an isolated display). */
const unsupportedBackend = (name: string): DisplayBackend => ({
  name,
  isSupported: async () => false,
  create: async () => {
    throw new Error('should not be called');
  },
  destroy: async () => undefined,
});

/** A backend that creates an isolated display with a tagged target. */
const workingBackend = (name: string): DisplayBackend => ({
  name,
  isSupported: async () => true,
  create: async () => ({ target: { display: name, isolated: 'yes' } }),
  destroy: async () => undefined,
});

describe('virtualDisplayManager — Property 1: never falls back to the real desktop', () => {
  it('throws (does NOT use the real desktop) when no backend can create an isolated display', async () => {
    const manager = createVirtualDisplayManager({ backends: [unsupportedBackend('a'), unsupportedBackend('b')] });
    await expect(manager.acquire()).rejects.toThrow(/refusing to use the real desktop/i);
    expect(manager.list()).toEqual([]);
  });

  it('acquires an isolated display from the first supported backend', async () => {
    const manager = createVirtualDisplayManager({ backends: [unsupportedBackend('a'), workingBackend('xvfb')] });
    const display = await manager.acquire();
    expect(display.isolated).toBe(true);
    expect(display.backend).toBe('xvfb');
    expect(display.target.isolated).toBe('yes');
    expect(manager.list()).toHaveLength(1);
  });

  it('releases displays through the backend that created them', async () => {
    const backend = workingBackend('win-desktop');
    const destroy = vi.spyOn(backend, 'destroy');
    const manager = createVirtualDisplayManager({ backends: [backend] });

    const display = await manager.acquire();
    await manager.release(display.id);

    expect(destroy).toHaveBeenCalledWith(display.id, display.target);
    expect(manager.list()).toEqual([]);
  });
});

describe('computerUseDriver — Property 1: input confined to the isolated display target', () => {
  it('sends every click/type to the isolated display target, never OS-global', async () => {
    const sentTargets: Record<string, string>[] = [];
    const input: DisplayInputSink = {
      click: async (target) => {
        sentTargets.push(target);
      },
      type: async (target) => {
        sentTargets.push(target);
      },
    };
    // Vision says: click, type, then done.
    const actions: VisionAction[] = [
      { type: 'click', x: 10, y: 20 },
      { type: 'type', text: 'hello' },
      { type: 'done', passed: true },
    ];
    let i = 0;
    const driver = createComputerUseDriver({
      vision: { decide: async () => actions[i++] },
      capture: { capture: async () => 'data:image/png;base64,AAAA' },
      input,
    });

    const isolatedTarget = { display: 'virtual-1', isolated: 'yes' };
    const result = await driver.runStep(
      { id: 's1', description: 'do a thing' },
      { platform: 'windows', target: isolatedTarget }
    );

    expect(result.passed).toBe(true);
    // Every input action went to the isolated target — nothing else.
    expect(sentTargets.length).toBe(2);
    expect(sentTargets.every((t) => t === isolatedTarget)).toBe(true);
  });

  it('gives up after the action budget without succeeding (no runaway global input)', async () => {
    const input: DisplayInputSink = { click: async () => undefined, type: async () => undefined };
    const driver = createComputerUseDriver({
      vision: { decide: async () => ({ type: 'click', x: 1, y: 1 }) }, // never returns done
      capture: { capture: async () => 'shot' },
      input,
      maxActionsPerStep: 3,
    });

    const result = await driver.runStep(
      { id: 's1', description: 'loop' },
      { platform: 'web', target: { display: 'v' } }
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/within 3 vision actions/);
  });
});
