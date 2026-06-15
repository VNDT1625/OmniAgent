---
name: performance
description: |
  Performance & resource (RAM/CPU/GPU) optimization for this Electron + React + aioncore app.
  Use when: (1) App feels laggy or freezes, (2) High memory/CPU/GPU usage, (3) Slow startup,
  (4) Many concurrent heavy tasks (agents, browser, testing, OCR, transcription, patch builds),
  (5) Tuning the ResourceCoordinator (Requirement 5), (6) Before claiming a perf fix is done.
---

# Performance Skill (project-specific)

Optimize resource usage for a **desktop Electron app** — not a web server. The goal is keeping
RAM/CPU/GPU under control so the app never lags the user's machine, in line with the project's
**ResourceCoordinator** design (Requirement 5).

**Announce at start:** "I'm using the performance skill to optimize resource usage."

> Diagnose before optimizing. For any lag/leak/regression, first follow the `systematic-debugging`
> skill (find root cause) — do NOT scatter optimizations blindly.

## Architecture context (read first)

- **Three runtimes**: Main process (Node/Electron), Renderer (React 19, Chromium), and **aioncore** (Rust binary holding business logic). Each has different memory/CPU profiles — identify WHICH one is hot before optimizing.
- **Heavy work must go through `ResourceCoordinator`**: every heavy task (`agent | browser | emulator | windowsTest | patchBuild | ocr | transcription | docConvert | semanticIndex`) calls `requestLease()` before running and `releaseLease()` after. A leaked lease = phantom memory budget consumed. Verify lease accounting first when concurrency feels wrong.
- **Workers**: CPU/GPU-heavy or risky work (OCR, transcription, ffmpeg, patch build) runs in worker child processes — never block Main/Renderer.

## Measure first (project tooling — confirmed to exist)

```bash
bun run bench:startup     # scripts/benchmark-startup.ts — startup time
bun run bench:report      # scripts/run-benchmarks.ts — benchmark suite
bun run bench:db          # database microbench (bun)
bun run debug:perf        # start app with ACP_PERF=1 PERF_MONITOR=1 (perf instrumentation)
```

Also use: Chrome DevTools (Renderer) Performance + Memory tabs, `process.memoryUsage()` in Main,
and OS task manager to attribute RAM/GPU per process. Never optimize without a before/after number.

## Diagnosis order (per runtime)

1. **Attribute**: which process holds the RAM/CPU/GPU? (Electron Main vs Renderer vs aioncore vs a worker)
2. **Reproduce + measure** a baseline number.
3. **Find root cause** (systematic-debugging Phase 1). Common culprits below.
4. **One change at a time**, re-measure, keep only what helps.

## Renderer (React) checklist

- Eliminate excessive re-renders: stable props, `React.memo`, `useMemo`/`useCallback` only where measured.
- Virtualize long lists (project already uses `react-virtuoso`) — never render thousands of rows.
- Lazy-load heavy routes/panels (`React.lazy` + `Suspense`); keep initial bundle lean.
- Clean up effects: cancel timers, listeners, subscriptions, object URLs on unmount (leaks here grow RAM over time).
- Avoid large in-memory blobs (media, file contents) in component state; stream or window them.
- Heavy editor/preview (Monaco, PDF, media) — mount on demand, dispose on close.

## Main process & aioncore checklist

- **Leases**: confirm every heavy task has exactly one `requestLease` and one matching `releaseLease` (incl. error/cancel paths). Leaked leases starve the budget and cause queue stalls.
- **Concurrency**: let `ResourceCoordinator` gate parallelism by free RAM; do NOT spawn unbounded agents/workers. Queue instead of overload (Property 3).
- **Idle release**: use `idleHook` to suspend idle components (load on demand) rather than keeping everything warm.
- **Workers**: ensure they are terminated after the job; a hung worker = retained RAM. Kill + release lease on timeout/OOM, mark job `error`, don't crash Main.
- **GPU**: only request GPU for tasks that need it (vision/transcription); release promptly. Prefer CPU/local-small models when the preset is `saver`.
- **Caches/state**: bound any in-memory cache; persist large state to disk (`resource-state.json`, file-based memory) instead of holding it.

## Optimization principles

- Match effort to the active **preset** (`saver | balanced | performance`): on `saver`, prefer smaller/local models, fewer concurrent tasks, lower capture resolution.
- Lazy > eager: defer loading until needed; suspend when idle.
- Bound everything: queues, caches, concurrency, capture sizes — no unbounded growth.
- Stream/window large data instead of loading whole.
- Every optimization needs a measured before/after; revert anything that doesn't move the number.

## Before claiming done

- Re-run the relevant bench (`bench:startup` / `bench:report`) and report before→after.
- Confirm no leased task leaks (lease count returns to baseline at idle).
- Verify no functional regression and that tests still pass (`testing` skill).
- Check both light/dark and typical + heavy concurrency scenarios.

> Related skills: `systematic-debugging` (root cause first), `testing` (no regressions), `architecture` (where worker/service code goes).
