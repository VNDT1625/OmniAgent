/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (request: unknown) => unknown>(),
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: vi.fn((channel: string) => ({
      provider: vi.fn((handler: (request: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    })),
  },
}));

import {
  QT_ASSET_CHANNELS,
  registerQuickTestAssetBridge,
  type QuickTestAssetState,
} from '@/process/ide/quickTestAssetBridge';
import type { ReplayRunResult, ReplayScenario } from '@/process/ide/quickTestReplay';
import type { CdpWebContents, RuntimeTrace } from '@/process/ide/quickTestTracer';
import type { UnderstandResult } from '@/process/ide/understandTypes';

const trace = (rootPath: string): RuntimeTrace => ({
  rootPath,
  platform: 'web',
  startedAt: 100,
  finishedAt: 200,
  events: [
    { kind: 'navigate', at: 110, url: 'http://localhost:3000/' },
    { kind: 'click', at: 120, selector: 'button#save', text: 'Save' },
  ],
  firstError: null,
  relatedFiles: [],
  interactionPath: ['Navigate http://localhost:3000/', 'Click button#save'],
});

const invoke = <T>(channel: string, request: unknown): Promise<UnderstandResult<T>> =>
  handlers.get(channel)?.(request) as Promise<UnderstandResult<T>>;

beforeEach(() => handlers.clear());

describe('Quick Test asset bridge', () => {
  it('persists a replay scenario and returns it from a later list call', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'quick-test-assets-'));
    try {
      registerQuickTestAssetBridge({ getWebContents: () => null });
      const saved = await invoke(QT_ASSET_CHANNELS.saveScenario, {
        rootPath,
        trace: trace(rootPath),
        name: 'Save flow',
      });
      expect(saved.ok).toBe(true);

      const listed = await invoke<QuickTestAssetState>(QT_ASSET_CHANNELS.list, { rootPath });
      expect(listed.ok && listed.data.scenarios[0]?.name).toBe('Save flow');
      expect(listed.ok && listed.data.scenarios[0]?.steps.length).toBe(2);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('attaches page state and a retained screenshot to a failed web replay step', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'quick-test-evidence-'));
    try {
      const executeJavaScript = vi.fn(async (code: string) => {
        if (code.includes('element.scrollIntoView')) throw new Error('Replay element was not found.');
        if (code.includes('pageUrl: location.href')) {
          return {
            pageUrl: 'http://localhost:3000/broken',
            pageTitle: 'Broken page',
            activeElement: 'body',
            target: { selector: 'button#save', exists: false },
          };
        }
        return undefined;
      });
      const webContents = {
        debugger: {
          attach: vi.fn(),
          detach: vi.fn(),
          sendCommand: vi.fn(),
          on: vi.fn(),
          removeAllListeners: vi.fn(),
          isAttached: vi.fn(() => false),
        },
        executeJavaScript,
        loadURL: vi.fn().mockResolvedValue(undefined),
        capturePage: vi.fn(async () => ({
          isEmpty: () => false,
          toPNG: () => Buffer.from('failure-frame'),
        })),
      } as unknown as CdpWebContents;

      registerQuickTestAssetBridge({ getWebContents: () => webContents });
      const saved = await invoke<ReplayScenario>(QT_ASSET_CHANNELS.saveScenario, {
        rootPath,
        trace: trace(rootPath),
        name: 'Failure evidence',
      });
      if (!saved.ok) throw new Error(saved.error);

      const replayed = await invoke<ReplayRunResult>(QT_ASSET_CHANNELS.replay, {
        rootPath,
        scenarioId: saved.data.id,
      });

      expect(replayed.ok && replayed.data.status).toBe('failed');
      const failedStep = replayed.ok ? replayed.data.steps.at(-1) : undefined;
      expect(failedStep?.evidence).toMatchObject({
        pageUrl: 'http://localhost:3000/broken',
        target: { selector: 'button#save', exists: false },
      });
      await expect(access(failedStep?.evidence?.screenshotPath ?? '')).resolves.toBeUndefined();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('rejects requests without a workspace root', async () => {
    registerQuickTestAssetBridge({ getWebContents: () => null });
    const result = await invoke<QuickTestAssetState>(QT_ASSET_CHANNELS.list, { rootPath: '  ' });
    expect(result.ok).toBe(false);
  });
});
