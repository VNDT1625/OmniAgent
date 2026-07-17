/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `appDetector` — answers "just tell it where the source is, and it figures out
 * how to run it" (Yêu cầu 2b — UX). Given a project folder, it reads the usual
 * declarative files (`package.json` scripts, `docker-compose.yml`, `Procfile`,
 * `.env*`, README) and asks the user's configured model to propose an
 * {@link AppUnderTest}: which services to start first (backend, db, workers),
 * the main app start command, and the dev URL to wait for + open.
 *
 * The model only ever sees these declarative files (capped in size), never the
 * whole source tree, and returns STRICT JSON which is parsed defensively. The
 * proposal is shown in the form for the user to review/edit before anything is
 * spawned — so a wrong guess is harmless.
 *
 * Reads files directly (Main-process Node.js); the model call mirrors
 * `scenarioGenerator.ts` / `companyGenerator.ts` (provider list from
 * `GET /api/providers`, direct `POST /chat/completions`). Nothing is hardcoded;
 * a clear error is thrown when no model is configured.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { httpRequest } from '@/common/adapter/httpBridge';
import type { IProvider } from '@/common/config/storage';
import { runAgentChatMessages } from '@process/services/agentChat';
import type { AppUnderTest, DetectProgressFn, ServiceSpec } from './testingTypes';

/** Timeout for the detection call (ms). Kept short so a stuck model fails fast. */
const DETECT_TIMEOUT_MS = 45_000;

/** Directory where per-project detection results are cached. */
const cacheDir = (): string => path.join(app.getPath('userData'), 'testing');

/** Derive a filesystem-safe project name from its folder path. */
const projectName = (projectDir: string): string => {
  const base = path.basename(projectDir.replace(/[/\\]+$/, '')) || 'project';
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
};

/** Path of the cache file for a project: `<name>-data.json` in the testing dir. */
const cacheFile = (projectDir: string): string => path.join(cacheDir(), `${projectName(projectDir)}-data.json`);

/** Shape persisted to `<name>-data.json` (the detected setup + provenance). */
type CachedDetection = {
  /** Schema marker for forward-compat. */
  version: 1;
  /** The project folder this was detected for (sanity check on reuse). */
  projectDir: string;
  /** Unix-ms when detected. */
  detectedAt: number;
  /** The detected app-under-test setup to reuse. */
  app: AppUnderTest;
};

/** Read a cached detection for `projectDir`, or `null` when absent/unreadable. */
const readCache = async (projectDir: string): Promise<AppUnderTest | null> => {
  try {
    const raw = await fs.readFile(cacheFile(projectDir), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<CachedDetection>;
    if (parsed && parsed.version === 1 && parsed.app && typeof parsed.app.url === 'string') {
      return parsed.app;
    }
    return null;
  } catch {
    return null;
  }
};

/** Persist a detection result to `<name>-data.json` (best-effort; never throws). */
const writeCache = async (projectDir: string, detected: AppUnderTest): Promise<void> => {
  try {
    await fs.mkdir(cacheDir(), { recursive: true });
    const payload: CachedDetection = { version: 1, projectDir, detectedAt: Date.now(), app: detected };
    await fs.writeFile(cacheFile(projectDir), JSON.stringify(payload, null, 2), 'utf-8');
  } catch {
    // Caching is an optimization; a write failure must not fail detection.
  }
};

/**
 * Phrases a routed/proxy model returns instead of doing the work (e.g. one that
 * only allows calls via a specific CLI). Treated as "this model can't be used
 * for detection" so the user gets a clear message instead of a JSON-parse error.
 */
const ROUTER_BLOCK_HINTS = ['use claude code', 'claude code cli', 'please use claude'];

/** Whether a model reply is a router/proxy refusal rather than a real answer. */
const isRouterBlock = (text: string): boolean => {
  const low = text.toLowerCase();
  return ROUTER_BLOCK_HINTS.some((h) => low.includes(h));
};

/** Max chars read from any single declarative file (keeps the prompt bounded). */
const MAX_FILE_CHARS = 6_000;

/** Declarative files worth reading to understand how a project starts. */
const CANDIDATE_FILES = [
  'package.json',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'Procfile',
  'Makefile',
  '.env',
  '.env.example',
  '.env.local',
  'README.md',
  'README',
  'turbo.json',
  'pnpm-workspace.yaml',
  'requirements.txt',
  'pyproject.toml',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'vite.config.ts',
  'vite.config.js',
] as const;

/** Subfolders that commonly hold the real app(s) in a monorepo. */
const WORKSPACE_DIRS = [
  'apps',
  'packages',
  'services',
  'frontend',
  'backend',
  'web',
  'client',
  'server',
  'src',
] as const;

/** package.json fields the model needs (scripts tell it how to run). */
const KEY_PKG_FIELDS = ['name', 'scripts', 'workspaces', 'private'] as const;

/** Folders never worth scanning. */
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  'coverage',
  'venv',
  '.venv',
  '__pycache__',
]);

/** Max nested package.json files to include (keeps the prompt bounded). */
const MAX_NESTED_PKGS = 12;

/** Whether a model id is enabled for a provider (defaults to enabled). */
const isModelEnabled = (provider: IProvider, model: string): boolean => provider.model_enabled?.[model] !== false;

/** A provider that is configured enough to issue a chat call. */
const isUsable = (p: IProvider): boolean =>
  p.enabled !== false && Boolean(p.api_key) && Boolean(p.base_url) && Array.isArray(p.models) && p.models.length > 0;

/** Pick a usable provider+model, preferring a health-checked one. */
const pickProviderModel = (
  providers: IProvider[],
  preferred?: string
): { provider: IProvider; model: string } | null => {
  const usable = providers.filter(isUsable);
  if (preferred) {
    const owner = usable.find((p) => p.models.includes(preferred) && isModelEnabled(p, preferred));
    if (owner) return { provider: owner, model: preferred };
  }
  for (const provider of usable) {
    const healthy = provider.models.find(
      (m) => isModelEnabled(provider, m) && provider.model_health?.[m]?.status === 'healthy'
    );
    if (healthy) return { provider, model: healthy };
  }
  for (const provider of usable) {
    const model = provider.models.find((m) => isModelEnabled(provider, m)) ?? provider.models[0];
    if (model) return { provider, model };
  }
  return null;
};

/** Resolve the OpenAI-compatible chat endpoint for a provider. */
const resolveChatUrl = (provider: IProvider): string => {
  const base = provider.base_url.replace(/\/+$/, '');
  return provider.is_full_url ? base : `${base}/chat/completions`;
};

/** First non-empty API key (the field may hold several, comma/newline-separated). */
const firstApiKey = (apiKeys: string): string =>
  apiKeys
    .split(/[,\n]/)
    .map((k) => k.trim())
    .find((k) => k.length > 0) ?? '';

/** A declarative file found in the project (with its path relative to the root). */
type ProjectFile = { name: string; content: string };

/** Read the candidate declarative files in one directory (relative-labelled). */
const readDirFiles = async (root: string, relDir: string, onProgress?: DetectProgressFn): Promise<ProjectFile[]> => {
  const found: ProjectFile[] = [];
  const absDir = relDir ? path.join(root, relDir) : root;
  for (const name of CANDIDATE_FILES) {
    try {
      const raw = await fs.readFile(path.join(absDir, name), 'utf-8');
      const label = relDir ? `${relDir.replace(/\\/g, '/')}/${name}` : name;
      onProgress?.({ projectDir: root, phase: 'reading', message: label });
      // package.json is huge with deps — keep only the fields that matter.
      if (name === 'package.json') {
        try {
          const pkg = JSON.parse(raw) as Record<string, unknown>;
          const slim: Record<string, unknown> = {};
          for (const f of KEY_PKG_FIELDS) if (pkg[f] !== undefined) slim[f] = pkg[f];
          found.push({ name: label, content: JSON.stringify(slim, null, 2).slice(0, MAX_FILE_CHARS) });
          continue;
        } catch {
          // fall through to raw slice on parse error
        }
      }
      found.push({ name: label, content: raw.slice(0, MAX_FILE_CHARS) });
    } catch {
      // Missing file — skip silently.
    }
  }
  return found;
};

/** List immediate child directories of `dir` (excluding ignored ones). */
const listSubdirs = async (dir: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
};

/**
 * Read declarative files from the root AND from common monorepo subfolders
 * (apps/*, packages/*, services/*, frontend, backend, …) so the model can see
 * that the real app lives in, e.g., `apps/web_next` and set `cwd` accordingly.
 */
const readProjectFiles = async (projectDir: string, onProgress?: DetectProgressFn): Promise<ProjectFile[]> => {
  onProgress?.({ projectDir, phase: 'scanning', message: '' });
  const files: ProjectFile[] = [...(await readDirFiles(projectDir, '', onProgress))];
  let nestedPkgs = 0;

  for (const ws of WORKSPACE_DIRS) {
    const wsAbs = path.join(projectDir, ws);
    const children = await listSubdirs(wsAbs);
    // `apps`, `packages`, `services` are containers → scan their children.
    // `frontend`, `backend`, `web`, … are usually the app dir itself.
    const targets = children.length > 0 ? children.map((c) => `${ws}/${c}`) : [ws];
    for (const rel of targets) {
      if (nestedPkgs >= MAX_NESTED_PKGS) break;
      const dirFiles = await readDirFiles(projectDir, rel, onProgress);
      if (dirFiles.length > 0) {
        files.push(...dirFiles);
        nestedPkgs += 1;
      }
    }
  }
  return files;
};

/** Build a compact 2-level directory tree so the model sees the layout. */
const buildTree = async (projectDir: string): Promise<string> => {
  const lines: string[] = [];
  const top = await listSubdirs(projectDir);
  for (const d of top.slice(0, 20)) {
    lines.push(d + '/');
    const sub = await listSubdirs(path.join(projectDir, d));
    for (const s of sub.slice(0, 12)) lines.push(`  ${d}/${s}/`);
  }
  return lines.join('\n');
};

/** Build the detection prompt from the project's declarative files + tree. */
const buildPrompt = (files: Array<{ name: string; content: string }>, tree: string): string => {
  const blocks = files.map((f) => `### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
  return `You are a build/run expert. From a web project's layout + declarative files, work out EVERY
process needed to run the FULL application end-to-end for testing — database(s), backend API(s),
queue/workers, AND the frontend web app — plus the dev URL the test should open.

Reply with STRICT JSON only (no prose, no code fences):
{
  "url": "<dev URL of the FRONTEND web app to open, e.g. http://localhost:3000>",
  "command": "<command that starts the FRONTEND, e.g. npm run dev>",
  "cwd": "<relative subfolder the frontend runs in, or empty for root>",
  "services": [
    {
      "name": "<short label: Postgres | API | Worker | ...>",
      "command": "<command to start this service>",
      "cwd": "<relative subfolder or empty>",
      "ready": { "type": "url|port|log|delay", "url": "...", "port": 0, "match": "...", "ms": 0 }
    }
  ]
}

Discover ALL flows (do NOT collapse them into one):
- DATABASE: docker-compose datastore services (postgres/mysql/mongo/redis) + their ports, or .env
  DATABASE_URL/DB_PORT. One service entry per datastore.
- BACKEND/API: a subfolder (apps/backend*, apps/api, server/, services/*) with its own scripts, or a
  Python app (requirements.txt/pyproject.toml → e.g. "uvicorn app.main:app --port 8000"), or a
  docker-compose "backend" service. Use its real port.
- WORKERS/QUEUES: celery/bull/sidekiq commands if present.
- FRONTEND: the subfolder whose package.json scripts run a web dev server (next/vite/react). This is
  the top-level command/cwd/url — NOT a service.

Ordering & correctness:
- "services" run BEFORE the frontend, in dependency order: database -> backend/workers.
- Each "command" runs IN its own "cwd" (no "cd ..."). "cwd" is RELATIVE to the project root.
- Readiness: database -> {"type":"log","match":"ready to accept connections"} or {"type":"port","port":<n>};
  backend -> {"type":"url","url":"http://localhost:<n>/health"} or {"type":"port","port":<n>}. Exactly ONE.
- If docker-compose starts backend+db together, you may use ONE service
  {"name":"stack","command":"docker compose up --build","ready":{"type":"port","port":<backend port>}}
  and still set the frontend command/cwd/url separately (frontend is usually NOT in compose).
- Only use commands/ports/urls justified by the files. Unclear frontend URL -> framework default
  (Next 3000, Vite 5173, CRA 3000). Frontend-only project -> "services": [].

Directory layout (2 levels):
${tree || '(flat project)'}

Declarative files (root + workspace subfolders):
${blocks}`;
};

/** Strip ```json fences / surrounding prose, returning the inner JSON text. */
const extractJson = (raw: string): string => {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim();
};

/** Coerce a parsed readiness object into a valid {@link ServiceSpec.ready}, or undefined. */
const normaliseReady = (value: unknown): ServiceSpec['ready'] => {
  if (value === null || typeof value !== 'object') return undefined;
  const r = value as { type?: unknown; url?: unknown; port?: unknown; match?: unknown; ms?: unknown };
  if (r.type === 'url' && typeof r.url === 'string' && r.url.trim()) return { type: 'url', url: r.url.trim() };
  if (r.type === 'port' && typeof r.port === 'number' && r.port > 0) return { type: 'port', port: r.port };
  if (r.type === 'log' && typeof r.match === 'string' && r.match.trim()) return { type: 'log', match: r.match.trim() };
  if (r.type === 'delay' && typeof r.ms === 'number' && r.ms > 0) return { type: 'delay', ms: r.ms };
  return undefined;
};

/** Resolve a model-provided relative cwd against the project root (empty → root). */
const resolveCwd = (projectDir: string, rel: unknown): string => {
  if (typeof rel !== 'string' || rel.trim().length === 0) return projectDir;
  // Reject absolute paths / traversal; keep it within the project.
  const cleaned = rel.trim().replace(/^[/\\]+/, '');
  if (cleaned.includes('..')) return projectDir;
  return path.join(projectDir, cleaned);
};

/** Parse the model reply into a defensive {@link AppUnderTest}. */
const parseAppSetup = (raw: string, projectDir: string): AppUnderTest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    throw new Error('Could not read the project setup (the model returned invalid JSON). Fill it in manually.');
  }
  const obj = parsed as { url?: unknown; command?: unknown; cwd?: unknown; services?: unknown };
  if (typeof obj.url !== 'string' || obj.url.trim().length === 0) {
    throw new Error('Could not determine the app URL from the project. Please enter it manually.');
  }

  const services: ServiceSpec[] = Array.isArray(obj.services)
    ? obj.services
        .map((s): ServiceSpec | null => {
          const svc = s as { name?: unknown; command?: unknown; cwd?: unknown; ready?: unknown };
          if (typeof svc.command !== 'string' || svc.command.trim().length === 0) return null;
          return {
            name: typeof svc.name === 'string' && svc.name.trim() ? svc.name.trim() : undefined,
            command: svc.command.trim(),
            cwd: resolveCwd(projectDir, svc.cwd),
            ready: normaliseReady(svc.ready),
          };
        })
        .filter((s): s is ServiceSpec => s !== null)
    : [];

  return {
    url: obj.url.trim(),
    command: typeof obj.command === 'string' && obj.command.trim() ? obj.command.trim() : undefined,
    cwd: resolveCwd(projectDir, obj.cwd),
    services,
  };
};

/** Request to detect how to run a project. */
export type DetectAppRequest = {
  /** Absolute path of the project folder (source root) to inspect. */
  projectDir: string;
  /** Optional preferred model id. */
  model?: string;
  /** Force a fresh model detection, ignoring (and overwriting) any cached result. */
  refresh?: boolean;
  /**
   * Optional progress sink. Called with each phase update (scanning → reading →
   * analyzing → parsing → done) so the caller can surface a live status bar.
   */
  onProgress?: DetectProgressFn;
};

/** Detects how to start a project from its source. */
export type IAppDetector = {
  detect: (request: DetectAppRequest) => Promise<AppUnderTest>;
};

/**
 * Create an app detector backed by the user's configured provider/model.
 *
 * @returns A detector that reads a project folder and proposes an AppUnderTest.
 */
export const createAppDetector = (): IAppDetector => {
  const detect = async ({ projectDir, model, refresh, onProgress }: DetectAppRequest): Promise<AppUnderTest> => {
    const dir = projectDir.trim();
    if (dir.length === 0) throw new Error('Choose the project folder first.');

    // Fast path: reuse a previous detection for this project (saves a model
    // call), unless the caller explicitly asked to refresh.
    if (!refresh) {
      const cached = await readCache(dir);
      if (cached) {
        onProgress?.({ projectDir: dir, phase: 'cache', message: '', percent: 100 });
        onProgress?.({ projectDir: dir, phase: 'done', message: '', percent: 100 });
        return cached;
      }
    }

    const files = await readProjectFiles(dir, onProgress);
    if (files.length === 0) {
      const message = 'No recognizable project files (package.json, docker-compose, Procfile, README) were found.';
      onProgress?.({ projectDir: dir, phase: 'error', message });
      throw new Error(message);
    }
    const tree = await buildTree(dir);
    const prompt = buildPrompt(files, tree);
    onProgress?.({ projectDir: dir, phase: 'analyzing', message: '', percent: 60 });

    // Provider-backed completion (used unless the user picked a CLI agent).
    const providerRun = async (): Promise<string> => {
      const providers = (await httpRequest<IProvider[]>('GET', '/api/providers').catch(() => [] as IProvider[])) || [];
      const selected = pickProviderModel(providers, model);
      if (!selected) {
        throw new Error(
          'No usable model is configured. Open Settings → Model and add a provider/model, then try again.'
        );
      }

      const url = resolveChatUrl(selected.provider);
      const apiKey = firstApiKey(selected.provider.api_key);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: selected.model,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const detail = await response.text().catch(() => '');
          throw new Error(`Model request failed (HTTP ${response.status}). ${detail.slice(0, 300)}`);
        }
        const json = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          throw new Error('The model returned an empty response while reading the project.');
        }
        if (isRouterBlock(content)) {
          throw new Error(
            `The selected model ("${selected.model}") can't be called directly (it routed you to a CLI). Pick a CLI agent or a different model in the box above the AI button, then try again.`
          );
        }
        return content;
      } finally {
        clearTimeout(timer);
      }
    };

    // `cli:<agentId>` → CLI agent; any other model id → provider path above.
    const content = await runAgentChatMessages(
      () => providerRun(),
      model ?? '',
      [{ role: 'user', content: prompt }],
      undefined,
      { workspace: dir, surface: 'ide', permissionMode: 'read-only' }
    );
    onProgress?.({ projectDir: dir, phase: 'parsing', message: '', percent: 90 });
    const detected = parseAppSetup(content, dir);
    // Cache for next time: `<name>-data.json` in the testing dir.
    await writeCache(dir, detected);
    onProgress?.({ projectDir: dir, phase: 'done', message: '', percent: 100 });
    return detected;
  };

  return { detect };
};
