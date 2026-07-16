/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser sub-agent runner — adapts the existing web-agent machinery
 * (`browserViewManager` + `webAgentRunner`) to the workspace {@link ISurfaceRunner}
 * contract so a workspace surface can be a live, agent-driven browser tab.
 *
 * `prepare` opens a dedicated tab for the surface (so each parallel browser
 * surface drives its OWN tab — tab-isolated input, criterion 1.3 — and never
 * fights another surface for one page). `run` delegates to the shared
 * {@link IWebAgentRunner}, translating its streamed {@link AgentEvent}s into the
 * orchestrator's {@link SurfaceProgress}, and wiring the orchestrator's abort
 * signal to the runner's cooperative `cancel`.
 *
 * The tab is created hidden at zero bounds; the renderer positions/show it by
 * pushing real bounds for the surface's frame (same overlay mechanism the
 * Browser page already uses). `dispose` destroys the tab when the surface
 * settles so parallel runs don't leak `WebContentsView`s.
 *
 * Both Electron-touching collaborators are injected, so the runner is
 * unit-testable without a live window.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { BrowserTabId, IBrowserViewManager } from '@process/browser/browserViewManager';
import type { IWebAgentRunner } from '@process/browser/webAgentRunner';
import type {
  BrowserSurfaceSpec,
  ISurfaceRunner,
  SurfacePrepared,
  SurfaceRunContext,
  SurfaceRunOutcome,
  SurfaceSpec,
} from './surfaceTypes';
import { hostTitle } from './surfaceTypes';

/** Injected dependencies for {@link createBrowserSurfaceRunner}. */
export type BrowserSurfaceRunnerDeps = {
  /** The shared browser tab manager (source of truth for tabs). */
  viewManager: IBrowserViewManager;
  /** The shared web-agent runner that drives a tab from an instruction. */
  agentRunner: IWebAgentRunner;
};

/**
 * Create a browser {@link ISurfaceRunner}. Each surface gets its own tab so
 * parallel browser surfaces are fully isolated.
 */
export const createBrowserSurfaceRunner = (deps: BrowserSurfaceRunnerDeps): ISurfaceRunner => {
  const asBrowser = (spec: SurfaceSpec): BrowserSurfaceSpec => {
    if (spec.kind !== 'browser') throw new Error('[BrowserSurfaceRunner] received a non-browser surface spec.');
    return spec;
  };

  /** Map a prepared surface's tab id (stored on `SurfacePrepared.tabId`). */
  const tabOf = (prepared: SurfacePrepared): BrowserTabId => {
    if (!prepared.tabId) throw new Error('[BrowserSurfaceRunner] prepared surface is missing its tab id.');
    return prepared.tabId;
  };

  return {
    prepare(spec): Promise<SurfacePrepared> {
      const browser = asBrowser(spec);
      // Create the tab hidden at zero bounds; the renderer will position + show
      // it once the surface frame is laid out. An initial URL (if any) starts
      // loading immediately so the agent has a page to work with.
      //
      // background:false even though it starts hidden — this is a USER-watched
      // surface (it shows in the in-chat watch grid), so it must keep its audio
      // when made visible, unlike off-screen research/scrape tabs.
      const tabId = deps.viewManager.createTab({ url: browser.url, visible: false, background: false });
      return Promise.resolve({ title: hostTitle(browser.url), tabId });
    },

    async run(spec, prepared, ctx: SurfaceRunContext): Promise<SurfaceRunOutcome> {
      const browser = asBrowser(spec);
      const tabId = tabOf(prepared);

      // Bridge the orchestrator's cooperative cancel to the web-agent runner.
      const onAbort = (): void => deps.agentRunner.cancel(tabId);
      if (ctx.signal.aborted) deps.agentRunner.cancel(tabId);
      else ctx.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const result = await deps.agentRunner.run(
          { tabId, model: browser.model, instruction: browser.instruction },
          (event) => {
            // Refine the surface title once the tab reports a real host.
            if (event.type === 'action') {
              ctx.emit({ type: 'step', tool: event.tool, summary: event.summary });
            } else if (event.type === 'observation') {
              ctx.emit({ type: 'observation', tool: event.tool, ok: event.ok, summary: event.summary });
            }
            // 'final' / 'error' / 'stopped' are conveyed by the resolved result below.
          }
        );

        if (result.status === 'error') {
          throw new Error(result.answer || 'The web agent failed.');
        }
        return { answer: result.answer, steps: result.steps };
      } finally {
        ctx.signal.removeEventListener('abort', onAbort);
      }
    },

    dispose(_spec, prepared): void {
      // Destroy the tab so parallel browser surfaces don't leak WebContentsViews.
      if (prepared.tabId) deps.viewManager.destroyTab(prepared.tabId);
    },
  };
};
