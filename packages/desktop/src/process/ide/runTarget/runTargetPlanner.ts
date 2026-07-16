/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `runTargetPlanner` — turns the repo's already-built "how to run" data into a
 * mechanical run plan for Quick Test, WITHOUT any model call.
 *
 * The Understand/Wiki build already produces a {@link ProjectRunbook}
 * (package-manager, scripts, ports) and persists it in the KnowledgeGraph. This
 * module reads that runbook plus the project's `package.json` dependency lists
 * and derives:
 *   - which platforms the project can run as — `web` / `android` / `desktop`,
 *     each an INDEPENDENT boolean (a Capacitor/Expo app is web AND android), and
 *   - one best-guess {@link RunCandidate} per supported platform: the dev
 *     command, working directory, and (for web) the dev URL + port.
 *
 * It is pure and deterministic (no fs, no network, no model): the bridge reads
 * the files and the persisted runbook, then calls {@link planRunTargets}. AI is
 * only ever used earlier, to BUILD the wiki/runbook — never here.
 *
 * Process boundary: pure TS module (no Node/DOM at module scope). Safe to import
 * from either process; consumed by the Main-process Quick-Run bridge.
 */

import { buildRunbook } from '../knowledgeGraphBuilder';
import type { ProjectRunbook, ProjectRunCommand } from '../understandTypes';

/** A platform Quick Test can drive the app on. */
export type RunPlatform = 'web' | 'android' | 'desktop';

/**
 * Independent support flags. A project can be several at once (e.g. a Capacitor
 * web app is `web` AND `android`), so these are NOT mutually exclusive — exactly
 * the "đa nền tảng, chỉ cần bool t/f" requirement.
 */
export type PlatformSupport = Record<RunPlatform, boolean>;

/** One concrete way to start the app for a given platform. */
export type RunCandidate = {
  /** The platform this candidate runs on. */
  platform: RunPlatform;
  /** Shell command that starts the app (e.g. `npm run dev`), when known. */
  command?: string;
  /** Working directory the command runs in, RELATIVE to the repo root (''=root). */
  cwd: string;
  /** Dev URL to open + attach the tracer to (web only). */
  url?: string;
  /** Dev server port (web only), when inferred. */
  port?: number;
  /** Detected framework label (for the UI), e.g. `Vite`, `Next.js`, `Electron`. */
  framework?: string;
};

/** Functional role of one independently launchable project service. */
export type RunServiceKind = 'frontend' | 'backend' | 'ai' | 'database' | 'worker' | 'other';

/** One service that Quick Test can launch alone or as part of the full stack. */
export type RunService = {
  /** Stable id used by the custom service picker. */
  id: string;
  /** Human-readable package/script label. */
  name: string;
  /** Functional role used for grouping and frontend-only runs. */
  kind: RunServiceKind;
  /** Shell command that starts this service. */
  command: string;
  /** Working directory relative to the repo root. */
  cwd: string;
  /** Web URL when this service is the browser-facing frontend. */
  url?: string;
  /** True when this command already orchestrates the complete stack. */
  orchestrator?: boolean;
};

/** The full mechanical run plan derived from the repo's run data. */
export type RunPlan = {
  /** Which platforms the project can run as (independent booleans). */
  support: PlatformSupport;
  /** One best-guess candidate per supported platform. */
  candidates: RunCandidate[];
  /** Independently launchable web-stack services for Run modes. */
  services: RunService[];
  /** Detected package manager (npm/pnpm/yarn/bun), when known. */
  packageManager?: string;
  /** Whether any structured run data (scripts/runbook) was found at all. */
  hasRunData: boolean;
};

/** Inputs to {@link planRunTargets}. All optional so the planner degrades gracefully. */
export type PlanInput = {
  /**
   * Persisted runbook from the KnowledgeGraph (preferred — already computed
   * during the wiki/Understand build). When absent, the planner falls back to
   * computing one from {@link PlanInput.files}.
   */
  runbook?: ProjectRunbook;
  /**
   * Declarative file contents keyed by repo-relative path (forward-slash). Must
   * include every `package.json` for dependency classification, and is also used
   * to compute a runbook when {@link PlanInput.runbook} is absent.
   */
  files: Map<string, string>;
  /** Set of repo-relative directory/file paths that exist (for `src-tauri/`, `android/`…). */
  existing?: Set<string>;
};

/** Framework default dev-server ports (used when the runbook found no explicit port). */
const FRAMEWORK_PORTS: Record<string, number> = {
  next: 3000,
  'react-scripts': 3000,
  nuxt: 3000,
  vue: 8080,
  '@vue/cli-service': 8080,
  vite: 5173,
  svelte: 5173,
  '@sveltejs/kit': 5173,
  '@angular/core': 4200,
  astro: 4321,
  gatsby: 8000,
};

/** Web frameworks whose presence implies a servable dev URL. */
const WEB_FRAMEWORKS = [
  'next',
  'react-scripts',
  'vite',
  '@angular/core',
  'vue',
  '@vue/cli-service',
  'nuxt',
  'svelte',
  '@sveltejs/kit',
  'astro',
  'gatsby',
  '@remix-run/react',
  '@remix-run/dev',
] as const;

/** Desktop-shell frameworks. */
const DESKTOP_FRAMEWORKS = ['electron', '@tauri-apps/cli', '@tauri-apps/api'] as const;

/** Mobile / Android frameworks. */
const ANDROID_FRAMEWORKS = [
  'react-native',
  'expo',
  '@capacitor/core',
  '@capacitor/android',
  '@capacitor/cli',
  'cordova',
] as const;

/** Normalize a relative path (back-slashes → forward, strip leading `./`). */
const normRel = (rel: string): string => rel.replace(/\\/g, '/').replace(/^\.\//, '');

/** Directory part of a relative manifest path; '' for a root-level file. */
const dirOf = (rel: string): string => {
  const n = normRel(rel);
  const slash = n.lastIndexOf('/');
  return slash > 0 ? n.slice(0, slash) : '';
};

/** Merge dependencies + devDependencies from every package.json in the map. */
const collectDependencies = (files: Map<string, string>): Set<string> => {
  const deps = new Set<string>();
  for (const [rel, content] of files) {
    if (!normRel(rel).endsWith('package.json')) continue;
    try {
      const pkg = JSON.parse(content) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      for (const key of Object.keys(pkg.dependencies ?? {})) deps.add(key);
      for (const key of Object.keys(pkg.devDependencies ?? {})) deps.add(key);
    } catch {
      /* malformed package.json — skip */
    }
  }
  return deps;
};

/** Whether any of `names` is a known dependency. */
const hasAny = (deps: Set<string>, names: readonly string[]): boolean => names.some((n) => deps.has(n));

/** First package directory declaring one of the requested platform dependencies. */
const packageDirWithDependency = (files: Map<string, string>, names: readonly string[]): string | undefined => {
  for (const [rel, content] of files) {
    if (!normRel(rel).endsWith('package.json')) continue;
    try {
      const pkg = JSON.parse(content) as {
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
      if (hasAny(deps, names)) return dirOf(rel);
    } catch {
      /* malformed package.json -- skip */
    }
  }
  return undefined;
};

/**
 * Whether an Electron project still exposes a standalone web launch script.
 * Electron-only projects often bundle Vite for their renderer, so the dependency
 * alone is not enough: the script itself must be runnable without Electron/Tauri.
 */
const hasStandaloneWebScript = (files: Map<string, string>): boolean => {
  for (const [rel, content] of files) {
    if (!normRel(rel).endsWith('package.json')) continue;
    try {
      const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
      for (const [name, value] of Object.entries(parsed.scripts ?? {})) {
        if (typeof value !== 'string' || !/^(?:dev|start|serve|preview|web)(?::|$)/i.test(name)) continue;
        if (!/\b(?:electron|electron-vite|tauri)\b/i.test(value)) return true;
      }
    } catch {
      /* malformed package.json — skip */
    }
  }
  return false;
};

/** The first detected framework id from a list (for a human label), or undefined. */
const firstFramework = (deps: Set<string>, names: readonly string[]): string | undefined =>
  names.find((n) => deps.has(n));

const SERVICE_KIND_ORDER: RunServiceKind[] = ['frontend', 'backend', 'ai', 'database', 'worker', 'other'];
const BACKEND_DEPS = ['express', 'fastify', '@nestjs/core', 'koa', 'hono'] as const;

const serviceKindFor = (name: string, value: string, cwd: string, deps: Set<string>): RunServiceKind => {
  const hint = `${name} ${value} ${cwd}`.toLowerCase();
  if (/\b(?:ai|llm|ml|model|inference|ollama)\b/.test(hint)) return 'ai';
  if (/\b(?:db|database|postgres|mysql|redis|mongo)\b/.test(hint)) return 'database';
  if (/\b(?:worker|queue|consumer|job)\b/.test(hint)) return 'worker';
  if (/\b(?:api|server|backend)\b/.test(hint)) return 'backend';
  if (/\b(?:web|frontend|client|ui|vite|next|nuxt|astro|gatsby)\b/.test(hint)) return 'frontend';
  if (hasAny(deps, WEB_FRAMEWORKS)) return 'frontend';
  if (hasAny(deps, BACKEND_DEPS)) return 'backend';
  return 'other';
};

/** Infer a frontend URL from a package's own command/dependencies, avoiding ports from sibling apps. */
const frontendUrlForPackage = (
  rawCommand: string,
  cwd: string,
  deps: Set<string>,
  fallbackUrl?: string
): string | undefined => {
  const explicit = rawCommand.match(/(?:--port(?:=|\s+)|localhost:|127\.0\.0\.1:)([1-9][0-9]{2,4})/i)?.[1];
  if (explicit) return `http://localhost:${explicit}`;
  if (!cwd && fallbackUrl) return fallbackUrl;
  const framework = WEB_FRAMEWORKS.find((name) => deps.has(name));
  const port = framework ? FRAMEWORK_PORTS[framework] : undefined;
  return port ? `http://localhost:${port}` : fallbackUrl;
};

const isComposeFile = (rel: string): boolean => /(?:^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i.test(normRel(rel));

/** Parse the bounded `services:` section needed by Quick Run without a YAML runtime dependency. */
const composeServiceBlocks = (content: string): Array<{ name: string; body: string }> => {
  const result: Array<{ name: string; body: string }> = [];
  const lines = content.split(/\r?\n/);
  let inServices = false;
  let serviceIndent: number | null = null;
  let current: { name: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (current) result.push({ name: current.name, body: current.lines.join('\n') });
    current = null;
  };
  for (const line of lines) {
    if (!inServices) {
      if (/^\s*services:\s*(?:#.*)?$/.test(line)) inServices = true;
      continue;
    }
    if (!line.trim() || /^\s*#/.test(line)) {
      if (current) current.lines.push(line);
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent === 0) break;
    const key = line.match(/^\s+([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
    if (key && (serviceIndent === null || indent === serviceIndent)) {
      serviceIndent ??= indent;
      flush();
      current = { name: key[1], lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return result;
};

/** Build independently selectable and full-stack Docker Compose launch recipes. */
const discoverComposeRunServices = (files: Map<string, string>, fallbackUrl?: string): RunService[] => {
  const result: RunService[] = [];
  for (const [rel, content] of files) {
    if (!isComposeFile(rel)) continue;
    const cwd = dirOf(rel);
    const basename = normRel(rel).split('/').pop() ?? 'docker-compose.yml';
    const standardName = /^(?:docker-)?compose\.ya?ml$/i.test(basename);
    const prefix = standardName ? 'docker compose' : `docker compose -f ${basename}`;
    const services = composeServiceBlocks(content).map<RunService>(({ name, body }) => {
      const namedKind = serviceKindFor(name, '', cwd, new Set());
      const kind =
        namedKind !== 'other' || /\bmcp\b/i.test(name) ? namedKind : serviceKindFor(name, body, cwd, new Set());
      const hostPort = body.match(/-\s*['"]?(?:127\.0\.0\.1:)?([1-9][0-9]{2,4}):[1-9][0-9]{2,4}/)?.[1];
      const service: RunService = {
        id: `compose:${cwd || '.'}:${name}`,
        name: `compose - ${name}`,
        kind,
        command: `${prefix} up --no-deps ${name}`,
        cwd,
      };
      if (kind === 'frontend' && hostPort) service.url = `http://localhost:${hostPort}`;
      return service;
    });
    result.push(...services, {
      id: `compose:${cwd || '.'}:full`,
      name: 'Docker Compose',
      kind: 'other',
      command: `${prefix} up`,
      cwd,
      url: services.find((service) => service.kind === 'frontend')?.url ?? fallbackUrl,
      orchestrator: true,
    });
  }
  return result;
};

/** Join a repo-relative base and child path without introducing a leading slash. */
const inScope = (base: string, child: string): string => (base ? `${base}/${child}` : child);

/** Discover local Python development services from standard entry points. */
const discoverPythonRunServices = (files: Map<string, string>, existing?: Set<string>): RunService[] => {
  const services: RunService[] = [];
  const seen = new Set<string>();
  for (const [rel, content] of files) {
    if (!normRel(rel).endsWith('pyproject.toml')) continue;
    const cwd = dirOf(rel);
    const scoped = (child: string): string => inScope(cwd, child);
    const windowsPython = scoped('.venv/Scripts/python.exe');
    const posixPython = scoped('.venv/bin/python');
    const python = exists(existing, windowsPython)
      ? '.venv\\Scripts\\python.exe'
      : exists(existing, posixPython)
        ? '.venv/bin/python'
        : 'python';

    if (/\bfastapi\b/i.test(content) && /\buvicorn\b/i.test(content) && exists(existing, scoped('backend/main.py'))) {
      const id = `python:${cwd || '.'}:backend`;
      if (!seen.has(id)) {
        seen.add(id);
        services.push({
          id,
          name: 'backend · local',
          kind: 'backend',
          command: `${python} -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000`,
          cwd,
        });
      }
    }

    if (exists(existing, scoped('mcp_server/server.py'))) {
      const id = `python:${cwd || '.'}:mcp`;
      if (!seen.has(id)) {
        seen.add(id);
        services.push({
          id,
          name: 'mcp · local',
          kind: 'other',
          command: `${python} -m mcp_server.server --transport streamable-http --host 127.0.0.1 --port 3001`,
          cwd,
        });
      }
    }
  }
  return services;
};

/** Build one selectable service per package/role from runnable package scripts. */
const discoverRunServices = (
  files: Map<string, string>,
  commands: ProjectRunCommand[],
  frontendUrl?: string,
  existing?: Set<string>
): RunService[] => {
  const byScope = new Map<string, RunService>();
  for (const [rel, content] of files) {
    if (!normRel(rel).endsWith('package.json')) continue;
    try {
      const parsed = JSON.parse(content) as {
        scripts?: Record<string, unknown>;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      const cwd = dirOf(rel);
      const deps = new Set([...Object.keys(parsed.dependencies ?? {}), ...Object.keys(parsed.devDependencies ?? {})]);
      for (const [name, rawValue] of Object.entries(parsed.scripts ?? {})) {
        if (typeof rawValue !== 'string') continue;
        const lowerName = name.toLowerCase();
        if (/\b(?:build|test|lint|format|typecheck|check)\b/.test(lowerName)) continue;
        const orchestrator = /\b(?:concurrently|npm-run-all)\b|\bturbo\s+run\b|\bnx\s+run-many\b|\bpnpm\s+-r\b/i.test(
          rawValue
        );
        const runnable = /^(?:dev|start|serve|preview)(?::|$)/i.test(name) || orchestrator;
        if (!runnable || /\b(?:electron|electron-vite|tauri)\b/i.test(rawValue)) continue;
        const kind = orchestrator ? 'other' : serviceKindFor(name, rawValue, cwd, deps);
        const command = commands.find(
          (candidate) => candidate.name === name && (candidate.cwd === '(root)' ? '' : normRel(candidate.cwd)) === cwd
        );
        if (!command?.command) continue;
        const scope = `package:${kind}\u0000${cwd}`;
        if (byScope.has(scope) && !orchestrator) continue;
        const packageName = cwd.split('/').pop() || name;
        byScope.set(scope, {
          id: `${kind}:${cwd || '.'}:${name}`,
          name: packageName === name ? name : `${packageName} · ${name}`,
          kind,
          command: command.command,
          cwd,
          ...((kind === 'frontend' || orchestrator) && frontendUrlForPackage(rawValue, cwd, deps, frontendUrl)
            ? { url: frontendUrlForPackage(rawValue, cwd, deps, frontendUrl) }
            : {}),
          ...(orchestrator ? { orchestrator: true } : {}),
        });
      }
    } catch {
      /* malformed package.json — skip */
    }
  }
  for (const service of discoverPythonRunServices(files, existing)) {
    byScope.set(service.id, service);
  }
  for (const service of discoverComposeRunServices(files, frontendUrl)) {
    byScope.set(service.id, service);
  }

  return Array.from(byScope.values()).toSorted((a, b) => {
    const kindOrder = SERVICE_KIND_ORDER.indexOf(a.kind) - SERVICE_KIND_ORDER.indexOf(b.kind);
    if (kindOrder !== 0) return kindOrder;
    const sourceOrder = Number(a.id.startsWith('compose:')) - Number(b.id.startsWith('compose:'));
    return sourceOrder || a.cwd.localeCompare(b.cwd) || a.name.localeCompare(b.name);
  });
};

/** Human label for a framework dependency id. */
const frameworkLabel = (id: string | undefined): string | undefined => {
  if (!id) return undefined;
  const map: Record<string, string> = {
    next: 'Next.js',
    'react-scripts': 'Create React App',
    vite: 'Vite',
    '@angular/core': 'Angular',
    vue: 'Vue',
    '@vue/cli-service': 'Vue CLI',
    nuxt: 'Nuxt',
    svelte: 'Svelte',
    '@sveltejs/kit': 'SvelteKit',
    astro: 'Astro',
    gatsby: 'Gatsby',
    '@remix-run/react': 'Remix',
    '@remix-run/dev': 'Remix',
    electron: 'Electron',
    '@tauri-apps/cli': 'Tauri',
    '@tauri-apps/api': 'Tauri',
    'react-native': 'React Native',
    expo: 'Expo',
    '@capacitor/core': 'Capacitor',
    '@capacitor/android': 'Capacitor',
    '@capacitor/cli': 'Capacitor',
    cordova: 'Cordova',
  };
  return map[id] ?? id;
};

/** Pick the dev-ish command for a directory, preferring `dev` → `start` → first. */
const pickCommand = (commands: ProjectRunCommand[], cwd: string): ProjectRunCommand | undefined => {
  const inDir = commands.filter((c) => (c.cwd === '(root)' ? '' : normRel(c.cwd)) === cwd);
  const pool = inDir.length > 0 ? inDir : commands;
  return (
    pool.find((c) => c.kind === 'dev') ??
    pool.find((c) => c.kind === 'start') ??
    pool.find((c) => c.kind === 'preview') ??
    pool[0]
  );
};

/** Infer the web dev port: explicit runbook port first, else framework default. */
const inferPort = (runbook: ProjectRunbook, deps: Set<string>): number | undefined => {
  // Prefer a "dev-ish" port from the runbook (3000/5173/4200/8080…), avoiding
  // common db/backend ports so the web URL points at the frontend.
  const devPorts = runbook.ports.filter((p) => p >= 3000 && p !== 5432 && p !== 3306 && p !== 27017 && p !== 6379);
  if (devPorts.length > 0) {
    // Prefer a known framework default if present among them.
    for (const fw of WEB_FRAMEWORKS) {
      const def = FRAMEWORK_PORTS[fw];
      if (def && deps.has(fw) && devPorts.includes(def)) return def;
    }
    return devPorts[0];
  }
  for (const fw of WEB_FRAMEWORKS) {
    if (deps.has(fw) && FRAMEWORK_PORTS[fw]) return FRAMEWORK_PORTS[fw];
  }
  return undefined;
};

/** Whether a relative dir/file path is present in the project. */
const exists = (existing: Set<string> | undefined, rel: string): boolean => {
  if (!existing) return false;
  const target = normRel(rel);
  for (const p of existing) {
    const n = normRel(p);
    if (n === target || n.startsWith(`${target}/`)) return true;
  }
  return false;
};

/**
 * Merge the persisted (graph) runbook with a freshly-computed one. The persisted
 * runbook can be stale or EMPTY (built before the repo had scripts, or by an
 * older KG version that wrote an empty runbook), so we UNION both: every command
 * from either source is kept. On a key collision the persisted command wins —
 * it was authored knowing the project's real package manager, so its prefix
 * (e.g. `pnpm run dev`) is more trustworthy than the fresh default (`npm`). The
 * union is what keeps Run working when the wiki was built earlier and not
 * rebuilt since: a fresh command is added whenever persisted lacks it.
 */
const mergeRunbooks = (persisted: ProjectRunbook | undefined, fresh: ProjectRunbook): ProjectRunbook => {
  if (!persisted || (persisted.commands?.length ?? 0) === 0) {
    // No usable persisted data → fresh alone (the stale/empty-runbook case).
    return persisted ? { ...fresh, packageManager: fresh.packageManager ?? persisted.packageManager } : fresh;
  }
  /** Dedupe run commands by name+cwd; persisted entries win a collision. */
  const byKey = new Map<string, ProjectRunCommand>();
  for (const c of fresh.commands ?? []) byKey.set(`${c.name}\u0000${c.cwd}`, c);
  for (const c of persisted.commands ?? []) byKey.set(`${c.name}\u0000${c.cwd}`, c);
  return {
    packageManager: persisted.packageManager ?? fresh.packageManager,
    commands: Array.from(byKey.values()),
    ports: Array.from(new Set([...(persisted.ports ?? []), ...(fresh.ports ?? [])])),
    env: Array.from(new Set([...(persisted.env ?? []), ...(fresh.env ?? [])])),
  };
};

/**
 * Derive the mechanical {@link RunPlan} from the repo's run data. Pure: no fs,
 * no model. Returns independent platform booleans + one candidate per platform.
 */
export const planRunTargets = (input: PlanInput): RunPlan => {
  // Always derive a FRESH runbook from the current package.json files, then
  // merge with the persisted graph runbook. The graph one can be stale or empty
  // (built before the repo had scripts, or by an older KG version that wrote an
  // empty runbook), so we must never trust it blindly — we prefer whichever
  // source actually has commands. This is why pressing Run keeps working even
  // when the wiki was built earlier and not rebuilt since.
  const runbook = mergeRunbooks(input.runbook, buildRunbook(input.files));
  const deps = collectDependencies(input.files);
  const commands = runbook.commands ?? [];

  const isElectron = deps.has('electron');
  const isTauri = hasAny(deps, ['@tauri-apps/cli', '@tauri-apps/api']) || exists(input.existing, 'src-tauri');
  const isCapacitor = hasAny(deps, ['@capacitor/core', '@capacitor/android', '@capacitor/cli']);
  const hasWebFramework = hasAny(deps, WEB_FRAMEWORKS);

  const support: PlatformSupport = {
    // Web: a web framework that is NOT wrapped purely as an Electron renderer,
    // OR a Capacitor app (which always has a servable web build). Tauri keeps
    // web=true because `tauri dev` runs the framework's web dev server.
    web: (hasWebFramework && (!isElectron || hasStandaloneWebScript(input.files))) || isCapacitor,
    android: hasAny(deps, ANDROID_FRAMEWORKS) || exists(input.existing, 'android'),
    desktop: isElectron || isTauri,
  };

  const fallbackPort = inferPort(runbook, deps);
  const fallbackUrl = fallbackPort ? `http://localhost:${fallbackPort}` : undefined;
  const services = discoverRunServices(input.files, commands, fallbackUrl, input.existing);
  if (!support.web && services.some((service) => service.kind === 'frontend')) support.web = true;
  const candidates: RunCandidate[] = [];

  if (support.web) {
    const webFw = firstFramework(deps, WEB_FRAMEWORKS);
    const webService =
      services.find(
        (service) => service.kind === 'frontend' && !service.orchestrator && !service.id.startsWith('compose:')
      ) ?? services.find((service) => service.kind === 'frontend' && !service.orchestrator);
    const cmd = webService ? undefined : pickCommand(commands, '');
    const url = webService?.url ?? fallbackUrl;
    const urlPort = url?.match(/:(\d{2,5})(?:\/|$)/)?.[1];
    candidates.push({
      platform: 'web',
      command: webService?.command ?? cmd?.command,
      cwd: webService?.cwd ?? (cmd ? (cmd.cwd === '(root)' ? '' : normRel(cmd.cwd)) : ''),
      port: urlPort ? Number(urlPort) : fallbackPort,
      url,
      framework: frameworkLabel(webFw) ?? (isCapacitor ? 'Capacitor' : undefined),
    });
  }

  if (support.desktop) {
    const desktopCwd = packageDirWithDependency(input.files, DESKTOP_FRAMEWORKS) ?? '';
    const cmd = pickCommand(commands, desktopCwd);
    candidates.push({
      platform: 'desktop',
      command: cmd?.command,
      cwd: cmd ? (cmd.cwd === '(root)' ? '' : normRel(cmd.cwd)) : desktopCwd,
      framework: isElectron ? 'Electron' : 'Tauri',
    });
  }

  if (support.android) {
    const cmd = pickCommand(commands, '');
    const androidFw = firstFramework(deps, ANDROID_FRAMEWORKS);
    candidates.push({
      platform: 'android',
      command: cmd?.command,
      cwd: cmd ? (cmd.cwd === '(root)' ? '' : normRel(cmd.cwd)) : '',
      framework: frameworkLabel(androidFw),
    });
  }

  return {
    support,
    candidates,
    services,
    packageManager: runbook.packageManager,
    hasRunData: commands.length > 0 || runbook.ports.length > 0 || services.length > 0,
  };
};

/**
 * Map a Quick Test {@link RunPlatform} to its tracer platform. Web stays web;
 * desktop is observed as a Windows process; android stays android. (Mirrors the
 * tracer's `TracePlatform`.)
 */
export const tracerPlatformFor = (platform: RunPlatform): 'web' | 'android' | 'windows' =>
  platform === 'web' ? 'web' : platform === 'android' ? 'android' : 'windows';
