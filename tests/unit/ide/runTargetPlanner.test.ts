/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for {@link planRunTargets} — the pure, model-free run planner that turns
 * the repo's run data (runbook + package.json deps) into independent platform
 * booleans + one run candidate per platform.
 */

import { describe, expect, it } from 'vitest';
import { planRunTargets, tracerPlatformFor } from '@/process/ide/runTarget/runTargetPlanner';

/** Build a files map with a single root package.json from a deps object. */
const pkgFiles = (pkg: Record<string, unknown>, extra: Record<string, string> = {}): Map<string, string> => {
  const map = new Map<string, string>();
  map.set('package.json', JSON.stringify(pkg));
  for (const [k, v] of Object.entries(extra)) map.set(k, v);
  return map;
};

describe('planRunTargets', () => {
  it('classifies a Vite web app: web=true, url+port from framework default', () => {
    const files = pkgFiles({
      dependencies: { react: '18' },
      devDependencies: { vite: '5' },
      scripts: { dev: 'vite' },
    });
    const plan = planRunTargets({ files });
    expect(plan.support).toEqual({ web: true, android: false, desktop: false });
    const web = plan.candidates.find((c) => c.platform === 'web');
    expect(web?.command).toBe('npm run dev');
    expect(web?.port).toBe(5173);
    expect(web?.url).toBe('http://localhost:5173');
    expect(web?.framework).toBe('Vite');
  });

  it('uses an explicit runbook port over the framework default', () => {
    const files = pkgFiles({ dependencies: { next: '14' }, scripts: { dev: 'next dev' } });
    const plan = planRunTargets({
      files,
      runbook: {
        packageManager: 'pnpm',
        commands: [{ name: 'dev', command: 'pnpm run dev', cwd: '(root)', kind: 'dev' }],
        env: [],
        ports: [4000],
      },
    });
    const web = plan.candidates.find((c) => c.platform === 'web');
    expect(web?.port).toBe(4000);
    expect(web?.command).toBe('pnpm run dev');
    expect(plan.packageManager).toBe('pnpm');
  });

  it('treats an Electron app as desktop-only (web=false)', () => {
    const files = pkgFiles({
      dependencies: { react: '18' },
      devDependencies: { electron: '30', vite: '5' },
      scripts: { dev: 'electron .' },
    });
    const plan = planRunTargets({ files });
    expect(plan.support.desktop).toBe(true);
    expect(plan.support.web).toBe(false);
    expect(plan.candidates.find((c) => c.platform === 'desktop')?.framework).toBe('Electron');
  });

  it('keeps web selectable when an Electron desktop shell is added after a standalone web app', () => {
    const files = pkgFiles({
      dependencies: { react: '18' },
      devDependencies: { electron: '30', vite: '5' },
      scripts: { dev: 'vite', desktop: 'electron .' },
    });
    const plan = planRunTargets({ files });

    expect(plan.support).toEqual({ web: true, android: false, desktop: true });
    expect(plan.candidates.find((c) => c.platform === 'web')?.command).toBe('npm run dev');
  });

  it('treats a Capacitor app as BOTH web and android (multi-platform booleans)', () => {
    const files = pkgFiles({
      dependencies: { react: '18', '@capacitor/core': '6', '@capacitor/android': '6' },
      devDependencies: { vite: '5' },
      scripts: { dev: 'vite' },
    });
    const plan = planRunTargets({ files });
    expect(plan.support.web).toBe(true);
    expect(plan.support.android).toBe(true);
    expect(plan.support.desktop).toBe(false);
  });

  it('treats a React Native app as android-only', () => {
    const files = pkgFiles({
      dependencies: { 'react-native': '0.74' },
      scripts: { start: 'react-native start' },
    });
    const plan = planRunTargets({ files });
    expect(plan.support).toEqual({ web: false, android: true, desktop: false });
  });

  it('detects Tauri via src-tauri/ directory even without the dep', () => {
    const files = pkgFiles({ dependencies: { vite: '5' }, scripts: { dev: 'vite' } });
    const plan = planRunTargets({ files, existing: new Set(['src-tauri/tauri.conf.json']) });
    expect(plan.support.desktop).toBe(true);
    expect(plan.support.web).toBe(true);
  });

  it('reports hasRunData=false for a project with no scripts or ports', () => {
    const files = pkgFiles({ dependencies: { lodash: '4' } });
    const plan = planRunTargets({ files });
    expect(plan.hasRunData).toBe(false);
    expect(plan.candidates).toEqual([]);
    expect(plan.support).toEqual({ web: false, android: false, desktop: false });
  });

  it('ignores db/backend ports when inferring the web URL', () => {
    const files = pkgFiles({ dependencies: { vite: '5' }, scripts: { dev: 'vite' } });
    const plan = planRunTargets({
      files,
      runbook: {
        commands: [{ name: 'dev', command: 'npm run dev', cwd: '(root)', kind: 'dev' }],
        env: [],
        ports: [5432, 5173],
      },
    });
    expect(plan.candidates.find((c) => c.platform === 'web')?.port).toBe(5173);
  });

  it('recovers run data from package.json when the persisted runbook is stale/empty', () => {
    // Reproduces the "wiki was built before, not rebuilt since" bug: an older
    // graph carries an EMPTY runbook, but the current package.json has scripts.
    // The planner must merge in the fresh runbook instead of trusting the empty
    // persisted one, so Run keeps working with no wiki rebuild.
    const files = pkgFiles({ devDependencies: { vite: '5' }, scripts: { dev: 'vite' } });
    const plan = planRunTargets({
      files,
      runbook: { commands: [], env: [], ports: [] },
    });
    expect(plan.hasRunData).toBe(true);
    expect(plan.support.web).toBe(true);
    expect(plan.candidates.find((c) => c.platform === 'web')?.command).toBe('npm run dev');
  });

  it('keeps the duplicate inner repo folder as cwd when manifests are read from an outer shell', () => {
    const files = pkgFiles(
      { devDependencies: { vite: '5' }, scripts: { dev: 'vite' } },
      {
        'AI_Education-main/package.json': JSON.stringify({
          packageManager: 'bun@1.2.0',
          devDependencies: { vite: '5' },
          scripts: { dev: 'vite' },
        }),
      }
    );
    files.delete('package.json');

    const plan = planRunTargets({ files });
    const web = plan.candidates.find((c) => c.platform === 'web');
    expect(plan.hasRunData).toBe(true);
    expect(web?.command).toBe('bun run dev');
    expect(web?.cwd).toBe('AI_Education-main');
  });

  it('discovers independently selectable frontend, backend, and AI services', () => {
    const files = pkgFiles(
      {},
      {
        'apps/web/package.json': JSON.stringify({ devDependencies: { vite: '5' }, scripts: { dev: 'vite' } }),
        'apps/api/package.json': JSON.stringify({
          dependencies: { express: '5' },
          scripts: { dev: 'tsx watch src.ts' },
        }),
        'services/ai/package.json': JSON.stringify({ scripts: { start: 'python model_server.py' } }),
      }
    );

    const plan = planRunTargets({ files });
    expect(plan.services.map((service) => service.kind)).toEqual(['frontend', 'backend', 'ai']);
    expect(plan.services.map((service) => service.cwd)).toEqual(['apps/web', 'apps/api', 'services/ai']);
  });

  it('prefers a browser-facing script in a mixed frontend and backend package', () => {
    const files = pkgFiles({
      dependencies: { express: '5' },
      devDependencies: { vite: '5' },
      scripts: { dev: 'vite', 'dev:api': 'tsx server.ts' },
    });

    const plan = planRunTargets({ files });
    expect(plan.services.map((service) => service.kind)).toEqual(['frontend', 'backend']);
  });

  it('keeps standalone web and Electron package commands on their matching targets', () => {
    const files = pkgFiles(
      {},
      {
        'frontend/web/package.json': JSON.stringify({
          dependencies: { next: '15' },
          scripts: { dev: 'next dev' },
        }),
        'frontend/desktop/package.json': JSON.stringify({
          dependencies: { electron: '30', vite: '5' },
          scripts: { dev: 'concurrently "vite" "electron ."' },
        }),
      }
    );

    const plan = planRunTargets({ files });
    expect(plan.candidates.find((candidate) => candidate.platform === 'web')?.cwd).toBe('frontend/web');
    expect(plan.candidates.find((candidate) => candidate.platform === 'desktop')?.cwd).toBe('frontend/desktop');
  });

  it('discovers Docker Compose services for full and custom stack runs', () => {
    const files = pkgFiles(
      { dependencies: { next: '15' }, scripts: { dev: 'next dev' } },
      {
        'docker-compose.yml': [
          'services:',
          '  backend:',
          '    build: .',
          '    ports:',
          '      - "8000:8000"',
          '  web:',
          '    build: .',
          '    ports:',
          '      - "3000:3000"',
          '  ollama:',
          '    image: ollama/ollama:latest',
          '    ports:',
          '      - "11434:11434"',
        ].join('\n'),
      }
    );

    const plan = planRunTargets({ files });
    expect(plan.services.map((service) => service.kind)).toEqual(['frontend', 'frontend', 'backend', 'ai', 'other']);
    expect(plan.services.find((service) => service.id.includes(':web'))?.url).toBe('http://localhost:3000');
    expect(plan.services.find((service) => service.orchestrator)?.command).toBe('docker compose up');
  });

  it('discovers local Python backend and MCP services beside Docker infrastructure', () => {
    const files = pkgFiles(
      {},
      {
        'frontend/web/package.json': JSON.stringify({
          dependencies: { next: '15' },
          scripts: { dev: 'next dev' },
        }),
        'pyproject.toml': '[project]\ndependencies = [fastapi, uvicorn[standard]]',
        'docker-compose.yml': [
          'services:',
          '  backend:',
          '    build: .',
          '    ports:',
          '      - 8000:8000',
          '  web:',
          '    build: .',
          '    ports:',
          '      - 3000:3000',
          '  mcp:',
          '    build: .',
          '  ollama:',
          '    image: ollama/ollama:latest',
          '    ports:',
          '      - 11434:11434',
        ].join('\n'),
      }
    );

    const plan = planRunTargets({
      files,
      existing: new Set(['backend/main.py', 'mcp_server/server.py']),
    });

    expect(plan.services.find((service) => service.id === 'python:.:backend')).toMatchObject({
      name: 'backend · local',
      kind: 'backend',
      command: 'python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000',
    });
    expect(plan.services.find((service) => service.id === 'python:.:mcp')).toMatchObject({
      name: 'mcp · local',
      command: 'python -m mcp_server.server --transport streamable-http --host 127.0.0.1 --port 3001',
    });
    expect(plan.services.find((service) => service.id.endsWith(':ollama'))?.command).toBe(
      'docker compose up --no-deps ollama'
    );
  });

  it('maps run platforms to tracer platforms', () => {
    expect(tracerPlatformFor('web')).toBe('web');
    expect(tracerPlatformFor('android')).toBe('android');
    expect(tracerPlatformFor('desktop')).toBe('windows');
  });
});
