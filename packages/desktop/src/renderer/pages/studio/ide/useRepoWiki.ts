/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useRepoWiki` — state + actions for the production-grade, persistent "Wiki"
 * tab of the IDE.
 *
 * The wiki is no longer regenerated from scratch and held only in React state.
 * This hook drives the durable pipeline in `process/ide/wiki/`:
 *   - {@link UseRepoWiki.load} reads the previously-built wiki off disk (instant,
 *     no model calls) so opening the tab shows the saved wiki.
 *   - {@link UseRepoWiki.build} runs the full pipeline in the Main process —
 *     scan → VERIFY the docs against the real code (auto-fixing stale references)
 *     → plan → author each section with a self-evaluate/improve loop → persist —
 *     streaming phase progress via {@link ideClient.onWikiProgress}. On success
 *     the assembled, saved wiki replaces the current view.
 *
 * Per-section Markdown is not streamed (the build returns the whole wiki when it
 * finishes and the persisted result is the source of truth); live feedback comes
 * from the phase progress (`verifying`, `writing 3/6 · architecture · q=0.92`).
 *
 * Renderer-only: talks to Main exclusively via {@link ideClient}.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ideClient, type PersistedDocReport, type PersistedWiki, type WikiBootstrapPhase } from './ideClient';
import { recordGenDuration } from '../components/GenerationProgress';

/** Lifecycle of the wiki as a whole. */
export type WikiStatus = 'idle' | 'loading' | 'building' | 'ready' | 'error';

/** State of a single section (rendered in the contents nav + reading column). */
export type WikiSectionState = {
  plan: { id: string; titleKey: string };
  status: 'pending' | 'writing' | 'done' | 'error';
  /** Authored Markdown. */
  content: string;
  /** Error text when `status === 'error'`. */
  error: string | null;
  /** Final self-evaluation score (0..1). */
  quality?: number;
  /** Number of improvement passes the refine loop ran. */
  iterations?: number;
};

/** A doc's verification summary surfaced in the "verified docs" report. */
export type WikiDocReport = PersistedDocReport;

/** Public shape returned by {@link useRepoWiki}. */
export type UseRepoWiki = {
  status: WikiStatus;
  /** Build/load error text, or null. */
  error: string | null;
  /** Paths of the files the wiki was grounded on (evidence list). */
  keyFiles: string[];
  /** Authored sections, in reading order. */
  sections: WikiSectionState[];
  /** Per-doc verification summary from the last build (empty for a fresh load with none). */
  docReports: WikiDocReport[];
  /** Mean self-evaluation score across sections (0..1), or null. */
  quality: number | null;
  /** When the loaded/built wiki was produced (epoch ms), or null. */
  builtAt: number | null;
  /** True when the current wiki was loaded from disk (vs freshly built this session). */
  persisted: boolean;
  /** Live build phase, or null when not building. */
  phase: WikiBootstrapPhase | null;
  /** Live build phase detail (counts / current section / quality), or null. */
  phaseDetail: string | null;
  /** Index of the section currently being authored, or -1 (kept for panel compat). */
  activeIndex: number;
  /** Load the persisted wiki for `rootPath` (instant; no model). */
  load: (rootPath: string) => Promise<void>;
  /** Build (or rebuild) + persist the wiki for `rootPath` with `model`. */
  build: (rootPath: string, model: string, language?: string) => Promise<void>;
  /** Cancel the active build without deleting an already-persisted wiki. */
  cancel: () => void;

  /** Discard the current wiki view (back to idle). */
  reset: () => void;
};

/** Project a persisted wiki into the hook's section view-model. */
const toSections = (wiki: PersistedWiki): WikiSectionState[] =>
  wiki.sections.map(
    (section): WikiSectionState => ({
      plan: { id: section.id, titleKey: section.titleKey },
      status: 'done',
      content: section.content,
      error: null,
      quality: section.quality,
      iterations: section.iterations,
    })
  );

export const useRepoWiki = (): UseRepoWiki => {
  const [status, setStatus] = useState<WikiStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [keyFiles, setKeyFiles] = useState<string[]>([]);
  const [sections, setSections] = useState<WikiSectionState[]>([]);
  const [docReports, setDocReports] = useState<WikiDocReport[]>([]);
  const [quality, setQuality] = useState<number | null>(null);
  const [builtAt, setBuiltAt] = useState<number | null>(null);
  const [persisted, setPersisted] = useState(false);
  const [phase, setPhase] = useState<WikiBootstrapPhase | null>(null);
  const [phaseDetail, setPhaseDetail] = useState<string | null>(null);
  // Run token: every build/load bumps it; stale async callbacks check it and bail.
  const runRef = useRef(0);
  const activeBuildRootRef = useRef<string | null>(null);
  const progressOffRef = useRef<(() => void) | null>(null);

  const applyWiki = useCallback((wiki: PersistedWiki, fromDisk: boolean): void => {
    setKeyFiles(wiki.keyFiles);
    setSections(toSections(wiki));
    setDocReports(wiki.docReports);
    setQuality(typeof wiki.quality === 'number' ? wiki.quality : null);
    setBuiltAt(wiki.builtAt);
    setPersisted(fromDisk);
    setStatus('ready');
  }, []);

  const cancel = useCallback((): void => {
    const rootPath = activeBuildRootRef.current;
    activeBuildRootRef.current = null;
    runRef.current++;
    progressOffRef.current?.();
    progressOffRef.current = null;
    setPhase(null);
    setPhaseDetail(null);
    setStatus('idle');
    if (rootPath) void ideClient.wikiCancel(rootPath).catch((): undefined => undefined);
  }, []);

  const load = useCallback(
    async (rootPath: string): Promise<void> => {
      const token = ++runRef.current;
      setStatus('loading');
      setError(null);
      const result = await ideClient.wikiLoad(rootPath).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        code: 'error' as const,
      }));
      if (runRef.current !== token) return;
      if (result.ok && result.data) {
        applyWiki(result.data, true);
        return;
      }
      // No persisted wiki (or a load error) → idle so the user can build one.
      setStatus('idle');
    },
    [applyWiki]
  );

  const build = useCallback(
    async (rootPath: string, model: string, language?: string): Promise<void> => {
      const token = ++runRef.current;
      activeBuildRootRef.current = rootPath;
      setStatus('building');
      setError(null);
      setPhase('scanning');
      setPhaseDetail(null);
      const startedAt = Date.now();

      // Live phase progress for THIS run (ignore stale / other-repo updates).
      const off = ideClient.onWikiProgress((p) => {
        if (runRef.current !== token || p.rootPath !== rootPath) return;
        setPhase(p.phase);
        setPhaseDetail(p.detail ?? null);
      });
      progressOffRef.current = off;

      const result = await ideClient.wikiBuild({ rootPath, model, language }).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        code: 'error' as const,
      }));
      off();
      if (progressOffRef.current === off) progressOffRef.current = null;
      if (activeBuildRootRef.current === rootPath) activeBuildRootRef.current = null;
      if (runRef.current !== token) return;
      setPhase(null);
      setPhaseDetail(null);
      if (result.ok) {
        recordGenDuration('ide.wikiBuild', Date.now() - startedAt);
        applyWiki(result.data, false);
        return;
      }
      setError((result as { ok: false; error: string }).error);
      setStatus('error');
    },
    [applyWiki]
  );

  const reset = useCallback((): void => {
    cancel();
    runRef.current++;
    setStatus('idle');
    setError(null);
    setKeyFiles([]);
    setSections([]);
    setDocReports([]);
    setQuality(null);
    setBuiltAt(null);
    setPersisted(false);
    setPhase(null);
    setPhaseDetail(null);
  }, [cancel]);

  // Stop Main-process work too when the whole workspace unmounts.
  useEffect(
    () => () => {
      runRef.current++;
      progressOffRef.current?.();
      const rootPath = activeBuildRootRef.current;
      if (rootPath) void ideClient.wikiCancel(rootPath).catch((): undefined => undefined);
    },
    []
  );

  return {
    status,
    error,
    keyFiles,
    sections,
    docReports,
    quality,
    builtAt,
    persisted,
    phase,
    phaseDetail,
    activeIndex: -1,
    load,
    build,
    cancel,
    reset,
  };
};

export default useRepoWiki;
