/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests the no-AI Quick-Run orchestrator hook. `ideClient` (the plan/probe IPC),
 * the renderer `emitter` (dock focus), and `terminalClient` (the session the hook
 * spawns to read the real dev URL) are mocked so the flow runs deterministically
 * without a real Main process or terminal. Timing is injected tiny so the probe
 * loop runs fast under real timers (fake timers deadlock testing-library waitFor).
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ideClientMock, emitterMock, terminalMock } = vi.hoisted(() => ({
  ideClientMock: {
    qrPlan: vi.fn(),
    qrSave: vi.fn(),
    qrClear: vi.fn(),
    qrProbe: vi.fn(),
  },
  emitterMock: { emit: vi.fn() },
  terminalMock: {
    create: vi.fn(),
    write: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@renderer/pages/studio/ide/ideClient', () => ({ ideClient: ideClientMock }));
vi.mock('@renderer/utils/emitter', () => ({ emitter: emitterMock }));
vi.mock('@renderer/pages/terminal/terminalBridgeClient', () => ({ terminalClient: terminalMock }));

import { useQuickRun } from '@/renderer/pages/studio/ide/components/useQuickRun';
import type { RunPlan } from '@/process/ide/runTarget/runTargetPlanner';
import type { SavedRunConfig } from '@/process/ide/runTarget/runConfigStore';

/**
 * Tiny timing so the probe loop resolves quickly under real timers. The grace
 * window (before the guessed fallback port is trusted) is kept small here too,
 * so the fallback path is exercised well within `probeTimeoutMs`.
 */
const FAST = { probeTimeoutMs: 2000, probeIntervalMs: 10, fallbackGraceMs: 50 };

const makePlan = (overrides: Partial<RunPlan> = {}): RunPlan => ({
  support: { web: true, android: false, desktop: false },
  candidates: [{ platform: 'web', command: 'npm run dev', cwd: '', url: 'http://localhost:5173', port: 5173 }],
  services: [
    {
      id: 'frontend:.:dev',
      name: 'dev',
      kind: 'frontend',
      command: 'npm run dev',
      cwd: '',
      url: 'http://localhost:5173',
    },
  ],
  packageManager: 'npm',
  hasRunData: true,
  ...overrides,
});

const planOk = (plan: RunPlan, saved: SavedRunConfig[] = []) =>
  ideClientMock.qrPlan.mockResolvedValue({
    ok: true,
    data: {
      plan,
      saved,
      source: {
        graphLoaded: true,
        graphHasRunbook: true,
        runbookCommandCount: plan.candidates.filter((candidate) => Boolean(candidate.command)).length,
        manifestFileCount: 1,
      },
    },
  });

beforeEach(() => {
  vi.clearAllMocks();
  ideClientMock.qrProbe.mockResolvedValue({ ok: true, data: { reachable: true } });
  ideClientMock.qrSave.mockResolvedValue({ ok: true, data: { version: 1, rootPath: '/repo', configs: [] } });
  // The hook spawns a real terminal session; default it to succeed with no output.
  terminalMock.create.mockResolvedValue({ ok: true, data: { id: 'sess-1' } });
  terminalMock.write.mockResolvedValue({ ok: true, data: undefined });
  terminalMock.onData.mockReturnValue(() => {});
  terminalMock.onExit.mockReturnValue(() => {});
  terminalMock.kill.mockResolvedValue({ ok: true, data: undefined });
  terminalMock.remove.mockResolvedValue({ ok: true, data: undefined });
});

describe('useQuickRun', () => {
  it('loads the plan and resolves the web recipe from the wiki runbook', async () => {
    planOk(makePlan());
    const { result } = renderHook(() => useQuickRun('/repo', FAST));

    await waitFor(() => expect(result.current.phase).toBe('ready'));
    expect(result.current.selected).toBe('web');
    expect(result.current.recipe).toMatchObject({ command: 'npm run dev', url: 'http://localhost:5173' });
    expect(result.current.setupSource).toBe('wiki');
  });

  it('falls back to needs-input when there is no run data and nothing saved', async () => {
    planOk(makePlan({ support: { web: false, android: false, desktop: false }, candidates: [], hasRunData: false }));
    const { result } = renderHook(() => useQuickRun('/repo', FAST));

    await waitFor(() => expect(result.current.phase).toBe('needs-input'));
  });

  it('flags platform options as supported/unsupported (independent booleans)', async () => {
    planOk(
      makePlan({
        support: { web: true, android: true, desktop: false },
        candidates: [
          { platform: 'web', command: 'npm run dev', cwd: '', url: 'http://localhost:5173' },
          { platform: 'android', command: 'npm run android', cwd: '' },
        ],
      })
    );
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    const byPlatform = Object.fromEntries(result.current.options.map((o) => [o.platform, o.supported]));
    expect(byPlatform).toEqual({ web: true, android: true, desktop: false });
  });

  it('keeps a saved web target selectable when later desktop detection marks web unsupported', async () => {
    const saved: SavedRunConfig[] = [
      { platform: 'web', command: 'npm run dev', cwd: '', url: 'http://localhost:5173', manual: false, savedAt: 1 },
      { platform: 'desktop', command: 'npm run desktop', cwd: '', manual: false, savedAt: 2 },
    ];
    planOk(
      makePlan({
        support: { web: false, android: false, desktop: true },
        candidates: [{ platform: 'desktop', command: 'npm run desktop', cwd: '', framework: 'Electron' }],
        services: [],
      }),
      saved
    );
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    expect(result.current.options.find((option) => option.platform === 'web')?.supported).toBe(true);
    act(() => result.current.select('web'));
    expect(result.current.selected).toBe('web');
    expect(result.current.recipe?.command).toBe('npm run dev');
    expect(result.current.services).toEqual([expect.objectContaining({ kind: 'frontend', command: 'npm run dev' })]);
  });

  it('spawns a terminal session, focuses the dock, and goes running once reachable', async () => {
    planOk(makePlan());
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    await act(async () => {
      await result.current.run();
    });
    // The hook spawned a real terminal session at the repo root and wrote the command.
    expect(terminalMock.create).toHaveBeenCalledWith({ options: { cwd: '/repo', title: 'dev' } });
    expect(terminalMock.write).toHaveBeenCalledWith({ id: 'sess-1', data: 'npm run dev\r' });
    // It surfaced that session in the IDE dock (focus), not a blind run emitter.
    expect(emitterMock.emit).toHaveBeenCalledWith('ide.terminal.focus', { id: 'sess-1' });
    expect(result.current.phase).toBe('running');
    expect(result.current.readyUrl).toBe('http://localhost:5173');
  });

  it('prefers the real printed dev URL over the guessed port (avoids opening the wrong app)', async () => {
    planOk(makePlan());
    // The terminal prints a DIFFERENT port (the guessed 5173 was taken, server moved to 5174).
    terminalMock.onData.mockImplementation((listener: (e: { id: string; data: string }) => void) => {
      setTimeout(() => listener({ id: 'sess-1', data: '  ➜  Local:   http://localhost:5174/\r\n' }), 5);
      return () => {};
    });
    // Only the real printed URL is reachable; the guessed one is not.
    ideClientMock.qrProbe.mockImplementation((url: string) =>
      Promise.resolve({ ok: true, data: { reachable: url === 'http://localhost:5174' } })
    );
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.readyUrl).toBe('http://localhost:5174');
    // The recipe saved for no-AI replay carries the URL that actually worked.
    expect(ideClientMock.qrSave).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ url: 'http://localhost:5174' })
    );
  });

  it('fails with a timeout when the dev server never answers', async () => {
    planOk(makePlan());
    ideClientMock.qrProbe.mockResolvedValue({ ok: true, data: { reachable: false } });
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.phase).toBe('error');
    expect(result.current.error).toBe('timeout');
  });

  it('prefers a saved recipe over the plan candidate (no-AI replay)', async () => {
    const saved: SavedRunConfig[] = [
      { platform: 'web', command: 'pnpm dev', cwd: 'app', url: 'http://localhost:3000', manual: true, savedAt: 1 },
    ];
    planOk(makePlan(), saved);
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    expect(result.current.recipe).toMatchObject({ command: 'pnpm dev', cwd: 'app' });
    expect(result.current.fromSaved).toBe(true);
  });

  it('runs a manual recipe and joins the cwd against the repo root', async () => {
    planOk(makePlan({ support: { web: false, android: false, desktop: false }, candidates: [], hasRunData: false }));
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('needs-input'));

    await act(async () => {
      await result.current.runManual({ command: 'vite', cwd: 'frontend', url: 'http://localhost:4321' });
    });
    expect(terminalMock.create).toHaveBeenCalledWith({ options: { cwd: '/repo/frontend' } });
    expect(terminalMock.write).toHaveBeenCalledWith({ id: 'sess-1', data: 'vite\r' });
    expect(result.current.phase).toBe('running');
    expect(result.current.recipe).toMatchObject({ command: 'vite', manual: true });
  });

  it('accepts a manual web URL without requiring a command or port field', async () => {
    planOk(makePlan({ support: { web: true, android: false, desktop: false }, candidates: [], hasRunData: false }));
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('needs-input'));

    await act(async () => {
      await result.current.runManual({ command: '', url: 'http://localhost:5174' });
    });

    expect(terminalMock.create).not.toHaveBeenCalled();
    expect(ideClientMock.qrProbe).toHaveBeenCalledWith('http://localhost:5174');
    expect(result.current.phase).toBe('running');
    expect(result.current.readyUrl).toBe('http://localhost:5174');
  });

  it('falls back to the existing web recipe when no frontend service can be classified', async () => {
    planOk(
      makePlan({
        services: [{ id: 'other', name: 'dev', kind: 'other', command: 'npm run dev', cwd: '' }],
      })
    );
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    await act(async () => result.current.run({ mode: 'interface' }));

    expect(terminalMock.write).toHaveBeenCalledWith({ id: 'sess-1', data: 'npm run dev\r' });
  });

  it('launches the complete detected stack in separate terminal sessions', async () => {
    planOk(
      makePlan({
        services: [
          {
            id: 'frontend',
            name: 'frontend',
            kind: 'frontend',
            command: 'npm run dev',
            cwd: 'web',
            url: 'http://localhost:5173',
          },
          { id: 'backend', name: 'backend', kind: 'backend', command: 'npm run dev', cwd: 'api' },
          { id: 'ai', name: 'ai', kind: 'ai', command: 'python model.py', cwd: 'ai' },
        ],
      })
    );
    let session = 0;
    terminalMock.create.mockImplementation(() => Promise.resolve({ ok: true, data: { id: `sess-${++session}` } }));
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    await act(async () => result.current.run({ mode: 'full' }));

    expect(terminalMock.create).toHaveBeenCalledTimes(3);
    expect(terminalMock.write.mock.calls.map((call) => call[0].data)).toEqual([
      'npm run dev\r',
      'npm run dev\r',
      'python model.py\r',
    ]);
  });

  it('prefers local development services and keeps Docker only as an infrastructure fallback', async () => {
    planOk(
      makePlan({
        services: [
          {
            id: 'frontend:web:dev',
            name: 'web · dev',
            kind: 'frontend',
            command: 'npm run dev',
            cwd: 'frontend/web',
            url: 'http://localhost:3000',
          },
          {
            id: 'python:.:backend',
            name: 'backend · local',
            kind: 'backend',
            command: 'python -m uvicorn backend.main:app --reload --port 8000',
            cwd: '',
          },
          {
            id: 'python:.:mcp',
            name: 'mcp · local',
            kind: 'other',
            command: 'python -m mcp_server.server',
            cwd: '',
          },
          {
            id: 'compose:.:web',
            name: 'compose - web',
            kind: 'frontend',
            command: 'docker compose up --no-deps web',
            cwd: '',
          },
          {
            id: 'compose:.:backend',
            name: 'compose - backend',
            kind: 'backend',
            command: 'docker compose up --no-deps backend',
            cwd: '',
          },
          {
            id: 'compose:.:mcp',
            name: 'compose - mcp',
            kind: 'other',
            command: 'docker compose up --no-deps mcp',
            cwd: '',
          },
          {
            id: 'compose:.:ollama',
            name: 'compose - ollama',
            kind: 'ai',
            command: 'docker compose up --no-deps ollama',
            cwd: '',
          },
          {
            id: 'compose:.:full',
            name: 'Docker Compose',
            kind: 'other',
            command: 'docker compose up',
            cwd: '',
            orchestrator: true,
          },
        ],
      })
    );
    let session = 0;
    terminalMock.create.mockImplementation(() => Promise.resolve({ ok: true, data: { id: `sess-${++session}` } }));
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    await act(async () => result.current.run({ mode: 'full' }));

    expect(terminalMock.create).toHaveBeenCalledTimes(4);
    expect(terminalMock.create.mock.calls.map((call) => call[0].options.title)).toEqual([
      'web · dev',
      'backend · local',
      'mcp · local',
      'compose - ollama',
    ]);
    expect(terminalMock.write.mock.calls.map((call) => call[0].data)).toEqual([
      'npm run dev\r',
      'python -m uvicorn backend.main:app --reload --port 8000\r',
      'python -m mcp_server.server\r',
      'docker compose up --no-deps ollama\r',
    ]);
  });

  it('runs only selected backend services without waiting for a frontend URL', async () => {
    planOk(
      makePlan({
        services: [
          {
            id: 'frontend',
            name: 'frontend',
            kind: 'frontend',
            command: 'npm run dev',
            cwd: 'web',
            url: 'http://localhost:5173',
          },
          { id: 'backend', name: 'backend', kind: 'backend', command: 'npm run api', cwd: 'api' },
        ],
      })
    );
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    ideClientMock.qrProbe.mockClear();

    await act(async () => result.current.run({ mode: 'custom', serviceIds: ['backend'] }));

    expect(terminalMock.write).toHaveBeenCalledWith({ id: 'sess-1', data: 'npm run api\r' });
    expect(ideClientMock.qrProbe).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('running');
  });

  it('returns to Start and tears down sibling services when an owned terminal exits manually', async () => {
    planOk(
      makePlan({
        services: [
          {
            id: 'frontend',
            name: 'frontend',
            kind: 'frontend',
            command: 'npm run dev',
            cwd: 'web',
            url: 'http://localhost:5173',
          },
          { id: 'backend', name: 'backend', kind: 'backend', command: 'npm run api', cwd: 'api' },
        ],
      })
    );
    let session = 0;
    let emitExit: ((event: { id: string; exitCode: number | null; exitedAt: number }) => void) | undefined;
    terminalMock.create.mockImplementation(() => Promise.resolve({ ok: true, data: { id: `sess-${++session}` } }));
    terminalMock.onExit.mockImplementation((listener) => {
      emitExit = listener;
      return () => {};
    });
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    await act(async () => result.current.run({ mode: 'full' }));

    act(() => emitExit?.({ id: 'sess-2', exitCode: 0, exitedAt: Date.now() }));

    expect(result.current.phase).toBe('ready');
    expect(result.current.active).toBe(false);
    expect(result.current.readyUrl).toBeNull();
    expect(terminalMock.kill).toHaveBeenCalledWith({ id: 'sess-1' });
  });

  it('stop() kills the spawned dev server, clears the URL, and returns to ready', async () => {
    planOk(makePlan());
    const { result } = renderHook(() => useQuickRun('/repo', FAST));
    await waitFor(() => expect(result.current.phase).toBe('ready'));

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.active).toBe(true);
    expect(result.current.phase).toBe('running');

    act(() => {
      result.current.stop();
    });
    // The spawned session is killed + removed (no orphan dev server holding the port).
    expect(terminalMock.kill).toHaveBeenCalledWith({ id: 'sess-1' });
    expect(terminalMock.remove).toHaveBeenCalledWith({ id: 'sess-1' });
    // Back to a clean ready state with the embedded browser URL cleared.
    expect(result.current.phase).toBe('ready');
    expect(result.current.active).toBe(false);
    expect(result.current.readyUrl).toBeNull();
  });
});
