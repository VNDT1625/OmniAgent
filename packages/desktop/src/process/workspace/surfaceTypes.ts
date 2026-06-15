/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared types for the **Workspace** feature — running several sub-agents in
 * parallel inside a single chat, each driving its own live "surface".
 *
 * A surface is one self-contained capability the user can see and the agent can
 * interact with:
 *
 * - `browser` — a live embedded browser tab (a {@link WebContentsView}) the
 *   sub-agent navigates/reads/clicks to research a page (e.g. "search jobs on
 *   site A").
 * - `editor`  — a file the sub-agent reads and rewrites through the fs bridge
 *   (e.g. "edit document B").
 *
 * The orchestrator (`workspaceOrchestrator.ts`) takes a list of {@link SurfaceSpec}s
 * and runs each on its own sub-agent **concurrently**, gated by the
 * ResourceCoordinator (`TaskKind: 'agent'`) so the machine never thrashes
 * (Requirement 5, criterion 3.12). Progress for every surface is streamed to the
 * renderer as {@link WorkspaceEvent}s so each frame shows its own live narration.
 *
 * This module is types-only (no runtime behaviour) so it can be imported by both
 * the Main-process orchestrator/bridge and — via `import type` — the renderer
 * page, without crossing the process boundary at runtime.
 */

/** The kind of capability a surface exposes. */
export type SurfaceKind = 'browser' | 'editor';

/** A browser surface: a sub-agent researching/operating a live web page. */
export type BrowserSurfaceSpec = {
  /** Discriminant. */
  kind: 'browser';
  /** Initial URL to open in the surface's tab (optional; the agent may navigate). */
  url?: string;
  /** Natural-language instruction for this sub-agent ("read jobs on site A and list them"). */
  instruction: string;
  /** Model id driving this sub-agent (criterion 1.2). */
  model: string;
};

/** An editor surface: a sub-agent reading and rewriting a file. */
export type EditorSurfaceSpec = {
  /** Discriminant. */
  kind: 'editor';
  /** Absolute (or workspace-relative) path of the file the sub-agent edits. */
  filePath: string;
  /** Natural-language instruction ("append a summary section to this file"). */
  instruction: string;
  /** Model id driving this sub-agent. */
  model: string;
};

/** A single sub-agent task: which surface to run and what to do on it. */
export type SurfaceSpec = BrowserSurfaceSpec | EditorSurfaceSpec;

/** Lifecycle status of one surface / sub-agent. */
export type SurfaceStatus =
  /** Accepted but waiting for a ResourceCoordinator lease (machine busy). */
  | 'queued'
  /** Lease granted; the surface is being prepared (e.g. opening the tab). */
  | 'starting'
  /** The sub-agent is actively working. */
  | 'running'
  /** Finished successfully with an answer. */
  | 'done'
  /** Failed (model / network / tool error). */
  | 'error'
  /** Cancelled by the user before finishing. */
  | 'stopped';

/**
 * Renderer-facing snapshot of one surface. The page renders one live frame per
 * surface from this state.
 */
export type SurfaceState = {
  /** Stable surface id (unique within a workspace run). */
  id: string;
  /** Which capability this surface exposes. */
  kind: SurfaceKind;
  /** Short human title (the URL host or the file name). */
  title: string;
  /** Current lifecycle status. */
  status: SurfaceStatus;
  /**
   * For browser surfaces: the backing tab id, so the renderer can position the
   * native {@link WebContentsView} overlay over this surface's frame. Undefined
   * for editor surfaces (which render inline in the DOM).
   */
  tabId?: string;
  /** For editor surfaces: the file path being edited. */
  filePath?: string;
  /** Number of tool steps executed so far. */
  steps: number;
  /** Final answer once `status === 'done'`. */
  answer?: string;
  /** Error message once `status === 'error'`. */
  error?: string;
};

/**
 * One streamed update about a workspace run. The renderer reduces these into the
 * per-surface {@link SurfaceState}s and the shared narration log.
 */
export type WorkspaceEvent =
  /** A surface was created (lease granted, frame should appear). */
  | { type: 'surface-created'; surface: SurfaceState }
  /** A surface changed lifecycle status. */
  | { type: 'surface-status'; id: string; status: SurfaceStatus }
  /** A sub-agent started a tool action (live narration). */
  | { type: 'surface-step'; id: string; tool: string; summary: string }
  /** Result/observation of the most recent action. */
  | { type: 'surface-observation'; id: string; tool: string; ok: boolean; summary: string }
  /** A sub-agent produced its final answer. */
  | { type: 'surface-final'; id: string; answer: string }
  /** A sub-agent failed. */
  | { type: 'surface-error'; id: string; message: string }
  /** The whole workspace run finished (all surfaces settled). */
  | { type: 'run-complete'; ok: boolean };

/** Sink the orchestrator pushes {@link WorkspaceEvent}s through. */
export type WorkspaceEventSink = (event: WorkspaceEvent) => void;

/** Outcome of a finished workspace run. */
export type WorkspaceRunResult = {
  /** Final state of every surface. */
  surfaces: SurfaceState[];
  /** `true` when no surface ended in `error`. */
  ok: boolean;
};

/** Progress a surface runner reports back to the orchestrator while it works. */
export type SurfaceProgress =
  /** The sub-agent began a tool action. */
  | { type: 'step'; tool: string; summary: string }
  /** Result of the most recent action. */
  | { type: 'observation'; tool: string; ok: boolean; summary: string };

/**
 * Context handed to a surface runner for one run: the surface id, a cooperative
 * cancellation signal, and a progress sink.
 */
export type SurfaceRunContext = {
  /** The surface this run drives. */
  surfaceId: string;
  /** Aborted when the user cancels the workspace (cooperative). */
  signal: AbortSignal;
  /** Push live progress for this surface. */
  emit: (progress: SurfaceProgress) => void;
};

/** What a runner returns after `prepare` so the orchestrator can build {@link SurfaceState}. */
export type SurfacePrepared = {
  /** Short human title for the surface frame. */
  title: string;
  /** Backing tab id for browser surfaces (renderer overlay positioning). */
  tabId?: string;
  /** File path for editor surfaces. */
  filePath?: string;
};

/** Result of a finished surface run. */
export type SurfaceRunOutcome = {
  /** The sub-agent's final answer. */
  answer: string;
  /** Number of tool steps executed. */
  steps: number;
};

/**
 * A pluggable runner that knows how to drive one {@link SurfaceKind}. The
 * orchestrator owns concurrency/leasing and stays decoupled from the concrete
 * browser/editor machinery behind this interface (which keeps it unit-testable
 * without Electron or the network).
 */
export type ISurfaceRunner = {
  /**
   * Prepare the surface so the renderer can show its frame (e.g. open a browser
   * tab). Should be cheap and fast; the heavy agent loop runs in {@link run}.
   */
  prepare: (spec: SurfaceSpec) => Promise<SurfacePrepared>;
  /** Run the sub-agent loop against the prepared surface, streaming progress. */
  run: (spec: SurfaceSpec, prepared: SurfacePrepared, ctx: SurfaceRunContext) => Promise<SurfaceRunOutcome>;
  /** Best-effort teardown after the run settles (e.g. keep or close the tab). */
  dispose?: (spec: SurfaceSpec, prepared: SurfacePrepared) => void;
};

/** Estimated RAM (MB) charged against the `agent` budget per running sub-agent. */
export const SURFACE_AGENT_COST_MB = 256;

/** Derive a short title from a URL host (browser surface fallback). */
export const hostTitle = (url: string | undefined): string => {
  if (!url) return 'about:blank';
  try {
    return new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Derive a short title from a file path (editor surface). */
export const fileTitle = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base.length > 0 ? base : filePath;
};
