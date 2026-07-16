/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useQuickRun` — the mechanical (no-AI) state machine behind Quick Test's
 * one-press **Run**.
 *
 * The flow the user asked for:
 *   1. On open, {@link ideClient.qrPlan} reads the repo's PERSISTED run data
 *      (the wiki/Understand {@link RunPlan}) + every package.json and returns
 *      which platforms the project supports (web/android/desktop — independent
 *      booleans) plus any previously-saved recipe. NO model call.
 *   2. The user picks a platform (the panel offers every platform but warns +
 *      redirects when they pick an unsupported one — the "chọn web nhưng là
 *      app" guard).
 *   3. Pressing Run executes the recipe MECHANICALLY: it spawns the dev command
 *      in the IDE's existing terminal dock (via the `ide.terminal.run` emitter —
 *      no bespoke launcher), then for web it polls the dev URL
 *      ({@link ideClient.qrProbe}) until the terminal-launched server answers,
 *      and hands that URL to the embedded browser so the tracer attaches to the
 *      real, running app.
 *   4. A run that reaches `running` is SAVED ({@link ideClient.qrSave}) so later
 *      runs replay straight from disk — the AI is never touched again unless the
 *      run breaks or the wiki was never built (then the user types the command).
 *
 * AI is involved ONLY earlier (building the wiki/runbook) or, separately, when a
 * run fails and the user asks the agent to fix it. This hook never calls a model.
 *
 * Process boundary: Renderer hook. No Node.js APIs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { emitter } from '@renderer/utils/emitter';
import { terminalClient } from '@renderer/pages/terminal/terminalBridgeClient';
import { ideClient } from '../ideClient';
import type { RunCandidate, RunPlan, RunPlanSource, RunPlatform, RunService, SavedRunConfig } from '../ideClient';

/** Phase of the Quick-Run flow. */
export type QuickRunPhase =
  /** Reading the mechanical plan from the repo's run data. */
  | 'loading'
  /** Plan loaded; waiting for the user to press Run. */
  | 'ready'
  /** The launch command was sent to the terminal. */
  | 'launching'
  /** Polling the dev URL until the terminal-launched server answers (web). */
  | 'waiting'
  /** The app is up (web URL reachable, or native launched) — tracer can attach. */
  | 'running'
  /** No run data and no saved recipe — the user must type the command. */
  | 'needs-input'
  /** A launch failed (probe timeout / no command) — show the reason + let AI fix. */
  | 'error';

/** One selectable platform with whether the project supports it + has a saved recipe. */
export type PlatformOption = {
  /** The platform this option targets. */
  platform: RunPlatform;
  /** Whether the project actually supports running on this platform. */
  supported: boolean;
  /** Whether a previously-successful recipe is saved for this platform. */
  saved: boolean;
};

/** A resolved, launchable recipe for the selected platform. */
export type ResolvedRecipe = {
  /** The platform this recipe runs. */
  platform: RunPlatform;
  /** Shell command that starts the app (e.g. `npm run dev`). */
  command: string;
  /** Working directory RELATIVE to the repo root ('' = root). */
  cwd: string;
  /** Dev URL to open + attach the tracer to (web only). */
  url?: string;
  /** Human-readable terminal title for a stack service. */
  title?: string;
  /** Whether this came from a hand-typed recipe (vs the wiki runbook / saved). */
  manual: boolean;
};

/** Where Quick Test got the launch setup from. */
export type QuickRunSetupSource = 'loading' | 'wiki' | 'saved' | 'package' | 'missing';

/** A hand-typed recipe from the manual form. */
export type ManualRecipeInput = {
  /** Shell command to run. */
  command: string;
  /** Dev URL (web only). */
  url?: string;
  /** Working directory relative to the repo root. */
  cwd?: string;
};

/** How much of a web stack the split Run button should launch. */
export type QuickRunMode = 'interface' | 'full' | 'custom';

/** Optional service selection supplied by the Run dropdown. */
export type QuickRunSelection = {
  mode: QuickRunMode;
  serviceIds?: string[];
};

/** Public surface of the hook (consumed by `QuickRunBar`). */
export type QuickRunState = {
  /** Current flow phase. */
  phase: QuickRunPhase;
  /** Selectable platform options (every platform, flagged supported/saved). */
  options: PlatformOption[];
  /** The currently-selected platform. */
  selected: RunPlatform;
  /** Select a platform (the panel handles the unsupported warning + redirect). */
  select: (platform: RunPlatform) => void;
  /** The recipe that will run for the selected platform (null when none). */
  recipe: ResolvedRecipe | null;
  /** Independently launchable services detected for the web stack. */
  services: RunService[];
  /** Whether the active recipe came from a saved (no-AI) config. */
  fromSaved: boolean;
  /** Source of the currently-available setup, used to show whether wiki runbook was loaded. */
  setupSource: QuickRunSetupSource;
  /** The dev URL handed to the embedded browser once the server is up (web). */
  readyUrl: string | null;
  /** Human-readable error when phase is `error`. */
  error: string | null;
  /** Launch the selected recipe in the IDE terminal + wait for readiness. */
  run: (selection?: QuickRunSelection) => Promise<void>;
  /** Launch a hand-typed recipe (manual plane / override). */
  runManual: (input: ManualRecipeInput) => Promise<void>;
  /**
   * Stop the running/launching app: kill the spawned dev-server terminal
   * session, detach its output stream, blank the embedded browser, and return
   * to `ready`. Idempotent — safe to call when nothing is running.
   */
  stop: () => void;
  /** Cancel an in-flight launch / reset back to ready. */
  reset: () => void;
  /** True while an app is launching/waiting/running (so the UI shows Stop). */
  active: boolean;
  /** Re-read the plan from disk (e.g. after the wiki was (re)built). */
  reload: () => void;
};

/** Optional timing overrides (kept tiny in tests so the probe loop is fast). */
export type QuickRunOptions = {
  /** Max time (ms) to wait for the dev URL before failing. */
  probeTimeoutMs?: number;
  /** Poll interval (ms) while waiting for the dev URL. */
  probeIntervalMs?: number;
  /**
   * Grace window (ms) before the GUESSED fallback port may be probed. Until it
   * elapses (or the server prints its own URL), only the real printed URL is
   * accepted — so we never grab whatever already holds the default port (e.g.
   * AionUi's own dev server on 5173) while the test server is still booting.
   */
  fallbackGraceMs?: number;
};

/** Max time (ms) to wait for the dev server to answer before failing. */
const DEFAULT_PROBE_TIMEOUT_MS = 90_000;
/** Poll interval (ms) while waiting for the dev URL. */
const DEFAULT_PROBE_INTERVAL_MS = 1000;
/**
 * Default grace window before the guessed fallback port is trusted. Long enough
 * for a dev server to print its real URL (Vite is sub-second, but cold installs
 * / slow machines need headroom), short enough not to stall a server that truly
 * has no banner.
 */
const DEFAULT_FALLBACK_GRACE_MS = 8000;

/** The platforms shown in the bar, in display order. */
const ALL_PLATFORMS: RunPlatform[] = ['web', 'desktop', 'android'];

/** Order platforms are preferred in when auto-picking a default / fallback. */
const PREFERENCE: RunPlatform[] = ['web', 'desktop', 'android'];

/** First supported platform, or 'web' as a last resort. */
const firstSupported = (plan: RunPlan | null): RunPlatform => {
  if (!plan) return 'web';
  return PREFERENCE.find((p) => plan.support[p]) ?? 'web';
};

/** Find the plan candidate for a platform. */
const candidateFor = (plan: RunPlan | null, platform: RunPlatform): RunCandidate | undefined =>
  plan?.candidates.find((c) => c.platform === platform);

/** Sleep helper. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Scan terminal output for the dev server's REAL URL. Dev servers (Vite, Next,
 * CRA, Astro…) print a line like `Local: http://localhost:5174/`. We must read
 * this rather than trust the planned port, because the planned port can be taken
 * by another process (e.g. AionUi itself runs Vite on 5173), in which case the
 * server silently moves to the next free port — and navigating to the planned
 * URL would open the WRONG app. ANSI escapes are stripped first.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const parseDevUrl = (output: string): string | null => {
  const clean = output.replace(ANSI_RE, '');
  // Prefer an explicitly-labelled local URL, else any localhost/127.0.0.1 URL.
  const labelled = clean.match(
    /(?:Local|On Your Network|App running at|ready on)[^\n]*?(https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s)]*)/i
  );
  if (labelled?.[1]) return labelled[1].replace(/\/+$/, '');
  const any = clean.match(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s)]*/i);
  return any ? any[0].replace(/\/+$/, '') : null;
};

/** Join a repo root with a relative subdir (forward-slash safe; '' → root). */
const joinPath = (root: string, rel: string): string => {
  if (!rel) return root;
  const sep = root.includes('\\') ? '\\' : '/';
  const trimmedRoot = root.replace(/[/\\]+$/, '');
  const relNative = rel.replace(/[/\\]+/g, sep).replace(/^[/\\]+/, '');
  return `${trimmedRoot}${sep}${relNative}`;
};

/**
 * Drive the no-AI Quick-Run flow for a repo.
 *
 * @param rootPath The IDE's open folder (null disables the flow).
 * @param options  Optional timing overrides (tests use tiny values).
 */
export const useQuickRun = (rootPath: string | null, options: QuickRunOptions = {}): QuickRunState => {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const fallbackGraceMs = options.fallbackGraceMs ?? DEFAULT_FALLBACK_GRACE_MS;

  const [phase, setPhase] = useState<QuickRunPhase>('loading');
  const [plan, setPlan] = useState<RunPlan | null>(null);
  const [planSource, setPlanSource] = useState<RunPlanSource | null>(null);
  const [saved, setSaved] = useState<SavedRunConfig[]>([]);
  const [selected, setSelected] = useState<RunPlatform>('web');
  const [manualRecipe, setManualRecipeState] = useState<ResolvedRecipe | null>(null);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const mountedRef = useRef(true);
  /** Guards an in-flight probe loop so it can be cancelled on reset/unmount. */
  const launchTokenRef = useRef(0);
  /** All terminal sessions spawned for the active frontend/backend/AI stack. */
  const sessionIdsRef = useRef<string[]>([]);
  /** Session whose output is scanned for the browser-facing dev URL. */
  const outputSessionIdRef = useRef<string | null>(null);
  /** Accumulated output of the frontend/orchestrator session. */
  const outputRef = useRef('');
  /** Unsubscribe from the launch session's output stream. */
  const offDataRef = useRef<(() => void) | null>(null);

  /**
   * Detach the output listener (between launches / on unmount). When `kill` is
   * true, also terminate the spawned dev-server terminal session so Stop tears
   * down everything the launch started (no orphan dev server holding the port).
   */
  const detachOutput = useCallback((kill = false): void => {
    offDataRef.current?.();
    offDataRef.current = null;
    if (kill) {
      for (const id of sessionIdsRef.current) {
        void terminalClient.kill({ id }).catch(() => {});
        void terminalClient.remove({ id }).catch(() => {});
      }
    }
    sessionIdsRef.current = [];
    outputSessionIdRef.current = null;
    outputRef.current = '';
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      launchTokenRef.current += 1;
      // The controller is owned by IdeWorkspace, so this only runs when the
      // workspace itself closes — switching away from Quick Test keeps services.
      detachOutput(true);
    };
  }, [detachOutput]);

  // A terminal can also be closed manually from the terminal dock (or exit after
  // a crash). Treat the launched stack as one unit: tear down any sibling
  // services and return the Run control to its clean Start state.
  useEffect(
    () =>
      terminalClient.onExit((event) => {
        if (!sessionIdsRef.current.includes(event.id)) return;
        launchTokenRef.current += 1;
        detachOutput(true);
        if (!mountedRef.current) return;
        setReadyUrl(null);
        setError(null);
        setPhase((prev) => (prev === 'needs-input' ? 'needs-input' : 'ready'));
      }),
    [detachOutput]
  );

  // Load the mechanical plan + saved recipes for the repo.
  useEffect(() => {
    if (!rootPath) {
      setPhase('needs-input');
      setPlan(null);
      setPlanSource(null);
      return undefined;
    }
    let cancelled = false;
    setPhase('loading');
    setManualRecipeState(null);
    setReadyUrl(null);
    setError(null);
    void ideClient
      .qrPlan(rootPath)
      .then((res) => {
        if (cancelled || !mountedRef.current) return;
        if (!res.ok) {
          setPhase('needs-input');
          return;
        }
        setPlan(res.data.plan);
        setPlanSource(res.data.source);
        setSaved(res.data.saved);
        const support = res.data.plan.support;
        const savedPlatforms = new Set(res.data.saved.map((config) => config.platform));
        const isAvailable = (candidate: RunPlatform): boolean => support[candidate] || savedPlatforms.has(candidate);
        const anyAvailable = PREFERENCE.some(isAvailable);
        setSelected((prev) =>
          isAvailable(prev) ? prev : (PREFERENCE.find(isAvailable) ?? firstSupported(res.data.plan))
        );
        const hasRecipe = res.data.plan.hasRunData || res.data.saved.length > 0;
        setPhase(anyAvailable && hasRecipe ? 'ready' : 'needs-input');
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setPhase('needs-input');
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, reloadToken]);

  // Platform options shown in the bar: every platform, flagged supported/saved.
  const platOptions = useMemo<PlatformOption[]>(
    () =>
      ALL_PLATFORMS.map((platform) => ({
        platform,
        supported: (plan?.support[platform] ?? false) || saved.some((config) => config.platform === platform),
        saved: saved.some((s) => s.platform === platform),
      })),
    [plan, saved]
  );

  const services = useMemo<RunService[]>(() => {
    const detected = plan?.services ?? [];
    if (detected.length > 0) return detected;
    const fallback =
      saved.find((config) => config.platform === 'web' && Boolean(config.command)) ?? candidateFor(plan, 'web');
    if (!fallback?.command) return [];
    return [
      {
        id: 'fallback:web',
        name: fallback.cwd.match(/[^\\/]+$/)?.[0] ?? fallback.command,
        kind: 'frontend',
        command: fallback.command,
        cwd: fallback.cwd,
        url: fallback.url,
      },
    ];
  }, [plan, saved]);

  // Resolve the recipe for the selected platform: a manual override wins, then a
  // saved recipe (no-AI replay), then the plan candidate.
  const { recipe, fromSaved } = useMemo<{ recipe: ResolvedRecipe | null; fromSaved: boolean }>(() => {
    if (manualRecipe && manualRecipe.platform === selected) return { recipe: manualRecipe, fromSaved: false };
    const savedConfig = saved.find((s) => s.platform === selected);
    if (savedConfig && savedConfig.command) {
      return {
        recipe: {
          platform: selected,
          command: savedConfig.command,
          cwd: savedConfig.cwd,
          url: savedConfig.url,
          manual: savedConfig.manual,
        },
        fromSaved: true,
      };
    }
    const candidate = candidateFor(plan, selected);
    if (candidate && candidate.command) {
      return {
        recipe: {
          platform: selected,
          command: candidate.command,
          cwd: candidate.cwd,
          url: candidate.url,
          manual: false,
        },
        fromSaved: false,
      };
    }
    return { recipe: null, fromSaved: false };
  }, [manualRecipe, saved, plan, selected]);

  const setupSource = useMemo<QuickRunSetupSource>(() => {
    if (phase === 'loading') return 'loading';
    if (fromSaved) return 'saved';
    if (planSource?.graphHasRunbook && planSource.runbookCommandCount > 0) return 'wiki';
    if (plan?.hasRunData) return 'package';
    return 'missing';
  }, [phase, fromSaved, planSource, plan]);

  const select = useCallback((next: RunPlatform): void => {
    setSelected(next);
  }, []);

  /**
   * Wait for the web app to be reachable, resolving the URL the tracer should
   * open. Crucially this does NOT trust the guessed port: a dev server (Vite,
   * etc.) silently moves to the next free port when its default is taken (e.g.
   * AionUi itself already holds 5173, so the test app lands on 5174). We watch
   * the terminal's own output for the URL it actually printed and prefer that;
   * the guessed `fallbackUrl` is only probed as a backstop. Returns the live URL
   * or null on timeout.
   */
  const waitForLiveUrl = useCallback(
    async (fallbackUrl: string | undefined, token: number): Promise<string | null> => {
      const startedAt = Date.now();
      const deadline = startedAt + probeTimeoutMs;
      for (;;) {
        if (token !== launchTokenRef.current || !mountedRef.current) return null;
        // 1) Prefer a URL the dev server actually printed (correct port). This is
        // authoritative: it is THIS dev server's real address, whatever port it
        // landed on after collision-avoidance.
        const printed = parseDevUrl(outputRef.current);
        if (printed) {
          // eslint-disable-next-line no-await-in-loop -- this is a condition-based polling loop with cancellation checks.
          const res = await ideClient.qrProbe(printed).catch((): null => null);
          if (res?.ok && res.data.reachable) return printed;
        }
        // 2) Backstop: the GUESSED url (framework default port). Only probed
        // AFTER a grace window in which no real URL was printed — otherwise we
        // race the test server's startup and grab whatever ALREADY holds that
        // port (e.g. AionUi's own dev server on 5173), opening the wrong app.
        // Once the server prints its own line, (1) wins and we never reach here.
        const graceElapsed = Date.now() - startedAt >= fallbackGraceMs;
        if (fallbackUrl && graceElapsed && !printed) {
          // eslint-disable-next-line no-await-in-loop -- each probe depends on the previous polling state and elapsed time.
          const res = await ideClient.qrProbe(fallbackUrl).catch((): null => null);
          if (res?.ok && res.data.reachable) return fallbackUrl;
        }
        if (Date.now() >= deadline) return null;
        // eslint-disable-next-line no-await-in-loop -- this loop intentionally waits between probes.
        await sleep(probeIntervalMs);
      }
    },
    [probeTimeoutMs, probeIntervalMs, fallbackGraceMs]
  );

  /** Shared launch path for one or more resolved recipes. */
  const launch = useCallback(
    async (
      toRun: ResolvedRecipe,
      companions: ResolvedRecipe[] = [],
      browserFacing = toRun.platform === 'web'
    ): Promise<void> => {
      if (!rootPath) return;
      const token = (launchTokenRef.current += 1);
      setError(null);
      setReadyUrl(null);
      setPhase('launching');
      detachOutput();
      outputRef.current = '';
      offDataRef.current = terminalClient.onData((event) => {
        if (event.id === outputSessionIdRef.current) outputRef.current += event.data;
      });

      const recipes = [toRun, ...companions];
      for (const [index, current] of recipes.entries()) {
        if (!current.command.trim()) continue;
        const cwd = current.cwd ? joinPath(rootPath, current.cwd) : rootPath;
        const terminalOptions = { cwd, ...(current.title ? { title: current.title } : {}) };
        // eslint-disable-next-line no-await-in-loop -- services need distinct terminal sessions and deterministic ownership.
        const created = await terminalClient.create({ options: terminalOptions }).catch((): null => null);
        if (token !== launchTokenRef.current || !mountedRef.current) return;
        if (!created || !created.ok) {
          detachOutput(true);
          setError('terminal');
          setPhase('error');
          return;
        }
        const sessionId = created.data.id;
        sessionIdsRef.current.push(sessionId);
        if (index === 0 && browserFacing) outputSessionIdRef.current = sessionId;
        emitter.emit('ide.terminal.focus', { id: sessionId });
        // eslint-disable-next-line no-await-in-loop -- let each fresh shell initialize before writing its command.
        await sleep(150);
        if (token !== launchTokenRef.current || !mountedRef.current) return;
        void terminalClient.write({ id: sessionId, data: `${current.command}\r` }).catch(() => {});
      }

      let liveUrl = toRun.url;
      if (browserFacing && toRun.platform === 'web') {
        setPhase('waiting');
        let resolved: string | null;
        if (toRun.command.trim()) {
          resolved = await waitForLiveUrl(toRun.url, token);
        } else if (toRun.url) {
          const probe = await ideClient.qrProbe(toRun.url).catch((): null => null);
          resolved = probe?.ok === true && probe.data.reachable === true ? toRun.url : null;
        } else {
          resolved = null;
        }
        if (token !== launchTokenRef.current || !mountedRef.current) return;
        if (!resolved) {
          setError('timeout');
          setPhase('error');
          return;
        }
        liveUrl = resolved;
        setReadyUrl(resolved);
      }
      if (token !== launchTokenRef.current || !mountedRef.current) return;
      setPhase('running');

      void ideClient
        .qrSave(rootPath, {
          platform: toRun.platform,
          command: toRun.command,
          cwd: toRun.cwd,
          url: liveUrl,
          manual: toRun.manual,
        })
        .then((res) => {
          if (res.ok && mountedRef.current) setSaved(res.data.configs);
        })
        .catch(() => {});
    },
    [rootPath, waitForLiveUrl, detachOutput]
  );

  const run = useCallback(
    async (selection: QuickRunSelection = { mode: 'interface' }): Promise<void> => {
      if (!recipe) {
        setPhase('needs-input');
        return;
      }
      if (selected !== 'web' || services.length === 0) {
        await launch(recipe);
        return;
      }

      let chosen: RunService[];
      if (selection.mode === 'interface') {
        chosen = services.filter((service) => service.kind === 'frontend' && !service.orchestrator).slice(0, 1);
        if (chosen.length === 0) {
          await launch(recipe);
          return;
        }
      } else if (selection.mode === 'full') {
        const localServices = services.filter((service) => !service.orchestrator && !service.id.startsWith('compose:'));
        const orchestrator = services.find((service) => service.orchestrator);
        const groupPrefix = orchestrator?.id.endsWith(':full') ? orchestrator.id.slice(0, -'full'.length) : null;
        const containerServices = groupPrefix
          ? services.filter((service) => !service.orchestrator && service.id.startsWith(groupPrefix))
          : [];
        const containerFallbacks = containerServices.filter(
          (container) => !localServices.some((local) => local.kind === container.kind)
        );
        chosen = [...localServices, ...containerFallbacks];
        if (chosen.length === 0) chosen = services.filter((service) => !service.orchestrator);
      } else {
        const selectedIds = new Set(selection.serviceIds ?? []);
        chosen = services.filter((service) => selectedIds.has(service.id) && !service.orchestrator);
      }
      if (chosen.length === 0) {
        setPhase('needs-input');
        return;
      }

      const primaryIndex = Math.max(
        0,
        chosen.findIndex((service) => service.kind === 'frontend' || service.orchestrator)
      );
      const ordered = [chosen[primaryIndex], ...chosen.filter((_, index) => index !== primaryIndex)];
      const recipes = ordered.map<ResolvedRecipe>((service) => ({
        platform: 'web',
        command: service.command,
        cwd: service.cwd,
        url: service.url,
        title: service.name,
        manual: false,
      }));
      const browserFacing = ordered[0].kind === 'frontend' || Boolean(ordered[0].orchestrator);
      await launch(recipes[0], recipes.slice(1), browserFacing);
    },
    [recipe, selected, services, launch]
  );

  const runManual = useCallback(
    async (input: ManualRecipeInput): Promise<void> => {
      const manual: ResolvedRecipe = {
        platform: selected,
        command: input.command.trim(),
        cwd: (input.cwd ?? '').trim(),
        url: selected === 'web' ? input.url?.trim() || undefined : undefined,
        manual: true,
      };
      if (!manual.command && !manual.url) return;
      setManualRecipeState(manual);
      await launch(manual);
    },
    [selected, launch]
  );

  const reset = useCallback((): void => {
    launchTokenRef.current += 1;
    detachOutput();
    setReadyUrl(null);
    setError(null);
    setPhase((prev) => (prev === 'needs-input' ? 'needs-input' : 'ready'));
  }, [detachOutput]);

  /**
   * Stop the active run: cancel any in-flight probe, KILL the spawned dev-server
   * terminal session (frees the port), clear the embedded browser's URL, and
   * return to `ready`. This is the Run↔Stop toggle's teardown — pressing Stop
   * undoes everything Run started. Idempotent.
   */
  const stop = useCallback((): void => {
    launchTokenRef.current += 1;
    detachOutput(true);
    setReadyUrl(null);
    setError(null);
    setPhase((prev) => (prev === 'needs-input' ? 'needs-input' : 'ready'));
  }, [detachOutput]);

  const reload = useCallback((): void => setReloadToken((t) => t + 1), []);

  // Active while the app is launching, waiting for its URL, or running — this is
  // when the bar shows Stop instead of Run.
  const active = phase === 'launching' || phase === 'waiting' || phase === 'running';

  return {
    phase,
    options: platOptions,
    selected,
    select,
    recipe,
    services,
    fromSaved,
    setupSource,
    readyUrl,
    error,
    run,
    runManual,
    stop,
    reset,
    active,
    reload,
  };
};
