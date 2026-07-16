/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useMakeVideo` — state + actions for the Make Video Studio view (the AI
 * movie/anime factory). Owns the project list, the active project, and the
 * generation flow:
 *
 *  1. `generateScript` asks the LLM for a scene-by-scene script and saves it.
 *  2. `generateImage` renders one scene via the cloud image model, persisting
 *     the saved image path on that scene.
 *  3. `generateAllImages` renders every scene sequentially (cloud-only; one at a
 *     time to be gentle on rate limits).
 *
 * Everything runs through the Main-process bridge against the user's configured
 * cloud providers — no local model hosting. Failures surface as friendly state.
 *
 * Renderer-only.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  makeVideoClient,
  type GenerateImageData,
  type GenerateVideoClipRequest,
  type GenerateVoiceRequest,
  type MakeVideoResult,
  type Scene,
  type ScriptRequest,
  type VideoClipConfig,
  type VideoProject,
  type VoiceConfig,
} from './makeVideoClient';
import { recordGenDuration } from '../components/GenerationProgress';

/** Failure arm of the result envelope; cast target under the no-`strictNullChecks` tsconfig. */
type MakeVideoFailure = { ok: false; error: string; code: 'no-model' | 'no-image-model' | 'error' };

/** Status of the active generation step. */
export type GenStatus = 'idle' | 'script' | 'images' | 'voices' | 'clips' | 'exporting';

/** Determinate progress for a multi-step generation (render-all scenes). */
export type GenProgress = { current: number; total: number };

/** Public shape returned by {@link useMakeVideo}. */
export type UseMakeVideo = {
  projects: VideoProject[];
  active: VideoProject | null;
  loading: boolean;
  bridgeError: string | null;
  status: GenStatus;
  /** Scene id currently rendering an image, if any. */
  busySceneId: string | null;
  /** Determinate progress while rendering all images (else null). */
  imagesProgress: GenProgress | null;
  /** Whether a "generate all" loop has been asked to stop after the current scene. */
  canceling: boolean;
  /** Path to the last exported final video. */
  exportedVideoPath: string | null;
  reload: () => Promise<void>;
  newProject: (topic: string, style: string, language: string) => Promise<VideoProject | null>;
  open: (id: string) => Promise<void>;
  closeActive: () => void;
  remove: (id: string) => Promise<void>;
  generateScript: (model: string, sceneCount: number) => Promise<void>;
  generateImage: (sceneId: string, model: string) => Promise<void>;
  generateAllImages: (model: string) => Promise<void>;
  generateVoice: (sceneId: string, voiceConfig: VoiceConfig) => Promise<void>;
  generateAllVoices: (voiceConfig: VoiceConfig) => Promise<void>;
  generateVideoClip: (sceneId: string, videoClipConfig: VideoClipConfig) => Promise<void>;
  generateAllVideoClips: (videoClipConfig: VideoClipConfig) => Promise<void>;
  /** Request the running "generate all" loop to stop after the current scene. */
  cancelGeneration: () => void;
  exportFinal: (outputPath?: string) => Promise<void>;
  setFrameStart: (sceneId: string, imagePath: string | null) => Promise<void>;
  setFrameEnd: (sceneId: string, imagePath: string | null) => Promise<void>;
};

let idCounter = 0;
const localId = (): string => `mv${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

export const useMakeVideo = (): UseMakeVideo => {
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [active, setActive] = useState<VideoProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [status, setStatus] = useState<GenStatus>('idle');
  const [busySceneId, setBusySceneId] = useState<string | null>(null);
  const [imagesProgress, setImagesProgress] = useState<GenProgress | null>(null);
  const [exportedVideoPath, setExportedVideoPath] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);
  /** Cooperative cancel flag for the "generate all" loops (checked per scene). */
  const cancelRef = useRef(false);

  const cancelGeneration = useCallback((): void => {
    cancelRef.current = true;
    setCanceling(true);
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await makeVideoClient.list();
      if (result.ok) {
        setProjects(result.data);
        setBridgeError(null);
      } else {
        setBridgeError((result as MakeVideoFailure).error);
      }
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Persist a project and reflect it in both the list and the active slot. */
  const persist = useCallback(async (project: VideoProject): Promise<VideoProject | null> => {
    const result = await makeVideoClient.save(project).catch((): null => null);
    if (result && result.ok) {
      setActive(result.data);
      setProjects((prev) => {
        const exists = prev.some((p) => p.id === result.data.id);
        return exists ? prev.map((p) => (p.id === result.data.id ? result.data : p)) : [result.data, ...prev];
      });
      return result.data;
    }
    if (result && !result.ok) setBridgeError((result as MakeVideoFailure).error);
    return null;
  }, []);

  const newProject = useCallback(
    async (topic: string, style: string, language: string): Promise<VideoProject | null> => {
      const now = Date.now();
      const project: VideoProject = {
        id: localId(),
        topic,
        style,
        language,
        scenes: [],
        createdAt: now,
        updatedAt: now,
      };
      return persist(project);
    },
    [persist]
  );

  const open = useCallback(async (id: string): Promise<void> => {
    const result = await makeVideoClient.get(id).catch((): null => null);
    if (result && result.ok && result.data) setActive(result.data);
  }, []);

  const closeActive = useCallback((): void => setActive(null), []);

  const remove = useCallback(async (id: string): Promise<void> => {
    const result = await makeVideoClient.remove(id).catch((): null => null);
    if (result && result.ok) {
      setProjects(result.data);
      setActive((prev) => (prev && prev.id === id ? null : prev));
    }
  }, []);

  const generateScript = useCallback(
    async (model: string, sceneCount: number): Promise<void> => {
      if (!active) return;
      setStatus('script');
      setBridgeError(null);
      const startedAt = Date.now();
      try {
        const request: ScriptRequest = {
          model,
          topic: active.topic,
          style: active.style,
          language: active.language,
          sceneCount,
        };
        const result = await makeVideoClient.generateScript(request);
        if (result.ok) {
          recordGenDuration('makevideo.script', Date.now() - startedAt);
          await persist({ ...active, scenes: result.data });
        } else {
          setBridgeError((result as MakeVideoFailure).error);
        }
      } catch (error) {
        setBridgeError(error instanceof Error ? error.message : String(error));
      } finally {
        setStatus('idle');
      }
    },
    [active, persist]
  );

  const renderScene = useCallback(async (project: VideoProject, scene: Scene, model: string): Promise<VideoProject> => {
    const startedAt = Date.now();
    const result = await makeVideoClient
      .generateImage({ projectId: project.id, sceneId: scene.id, prompt: scene.imagePrompt, model })
      .catch(
        (error: unknown): MakeVideoResult<GenerateImageData> => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          code: 'error',
        })
      );
    if (result.ok) recordGenDuration('makevideo.image', Date.now() - startedAt);
    const scenes = project.scenes.map((s) => {
      if (s.id !== scene.id) return s;
      return result.ok
        ? { ...s, imagePath: result.data.imagePath, imageError: null }
        : { ...s, imageError: (result as MakeVideoFailure).error };
    });
    return { ...project, scenes };
  }, []);

  const generateImage = useCallback(
    async (sceneId: string, model: string): Promise<void> => {
      if (!active) return;
      const scene = active.scenes.find((s) => s.id === sceneId);
      if (!scene) return;
      setBusySceneId(sceneId);
      try {
        const next = await renderScene(active, scene, model);
        await persist(next);
      } finally {
        setBusySceneId(null);
      }
    },
    [active, persist, renderScene]
  );

  const generateAllImages = useCallback(
    async (model: string): Promise<void> => {
      if (!active) return;
      setStatus('images');
      cancelRef.current = false;
      setCanceling(false);
      const total = active.scenes.length;
      setImagesProgress({ current: 0, total });
      let working = active;
      try {
        for (let i = 0; i < active.scenes.length; i++) {
          if (cancelRef.current) break;
          const scene = active.scenes[i];
          setBusySceneId(scene.id);
          working = await renderScene(working, scene, model);
          const saved = await persist(working);
          if (saved) working = saved;
          setImagesProgress({ current: i + 1, total });
        }
      } finally {
        setBusySceneId(null);
        setImagesProgress(null);
        setStatus('idle');
        cancelRef.current = false;
        setCanceling(false);
      }
    },
    [active, persist, renderScene]
  );

  // ---------------------------------------------------------------------------
  // Voice generation
  // ---------------------------------------------------------------------------

  const generateVoice = useCallback(
    async (sceneId: string, voiceConfig: VoiceConfig): Promise<void> => {
      if (!active) return;
      const scene = active.scenes.find((s) => s.id === sceneId);
      if (!scene) return;
      setBusySceneId(sceneId);
      try {
        const req: GenerateVoiceRequest = {
          projectId: active.id,
          sceneId,
          text: scene.narration,
          voiceConfig,
        };
        const result = await makeVideoClient.generateVoice(req);
        if (!result.ok) setBridgeError((result as MakeVideoFailure).error);
        // Bridge already persisted audioPath on the scene; reload.
        const refreshed = await makeVideoClient.get(active.id);
        if (refreshed.ok && refreshed.data) {
          setActive(refreshed.data);
          setProjects((prev) => prev.map((p) => (p.id === refreshed.data!.id ? refreshed.data! : p)));
        }
      } finally {
        setBusySceneId(null);
      }
    },
    [active]
  );

  const generateAllVoices = useCallback(
    async (voiceConfig: VoiceConfig): Promise<void> => {
      if (!active) return;
      setStatus('voices');
      cancelRef.current = false;
      setCanceling(false);
      const total = active.scenes.length;
      setImagesProgress({ current: 0, total });
      try {
        for (let i = 0; i < active.scenes.length; i++) {
          if (cancelRef.current) break;
          const scene = active.scenes[i];
          setBusySceneId(scene.id);
          const req: GenerateVoiceRequest = {
            projectId: active.id,
            sceneId: scene.id,
            text: scene.narration,
            voiceConfig,
          };
          await makeVideoClient.generateVoice(req).catch((): undefined => undefined);
          setImagesProgress({ current: i + 1, total });
        }
        // Reload project after all voices done.
        const refreshed = await makeVideoClient.get(active.id);
        if (refreshed.ok && refreshed.data) {
          setActive(refreshed.data);
          setProjects((prev) => prev.map((p) => (p.id === refreshed.data!.id ? refreshed.data! : p)));
        }
      } finally {
        setBusySceneId(null);
        setImagesProgress(null);
        setStatus('idle');
        cancelRef.current = false;
        setCanceling(false);
      }
    },
    [active]
  );

  // ---------------------------------------------------------------------------
  // Video clip generation (image-to-video)
  // ---------------------------------------------------------------------------

  const generateVideoClip = useCallback(
    async (sceneId: string, videoClipConfig: VideoClipConfig): Promise<void> => {
      if (!active) return;
      const scene = active.scenes.find((s) => s.id === sceneId);
      if (!scene) return;
      const frameStartPath = scene.frameStartPath ?? scene.imagePath;
      if (!frameStartPath) {
        setBridgeError('Render an image for this scene first before generating a video clip.');
        return;
      }
      setBusySceneId(sceneId);
      try {
        const req: GenerateVideoClipRequest = {
          projectId: active.id,
          sceneId,
          frameStartPath,
          frameEndPath: scene.frameEndPath ?? null,
          prompt: scene.imagePrompt,
          videoClipConfig,
        };
        const result = await makeVideoClient.generateVideoClip(req);
        if (!result.ok) setBridgeError((result as MakeVideoFailure).error);
        const refreshed = await makeVideoClient.get(active.id);
        if (refreshed.ok && refreshed.data) {
          setActive(refreshed.data);
          setProjects((prev) => prev.map((p) => (p.id === refreshed.data!.id ? refreshed.data! : p)));
        }
      } finally {
        setBusySceneId(null);
      }
    },
    [active]
  );

  const generateAllVideoClips = useCallback(
    async (videoClipConfig: VideoClipConfig): Promise<void> => {
      if (!active) return;
      setStatus('clips');
      cancelRef.current = false;
      setCanceling(false);
      const total = active.scenes.length;
      setImagesProgress({ current: 0, total });
      try {
        for (let i = 0; i < active.scenes.length; i++) {
          if (cancelRef.current) break;
          const scene = active.scenes[i];
          const frameStartPath = scene.frameStartPath ?? scene.imagePath;
          if (!frameStartPath) {
            setImagesProgress({ current: i + 1, total });
            continue;
          }
          setBusySceneId(scene.id);
          const req: GenerateVideoClipRequest = {
            projectId: active.id,
            sceneId: scene.id,
            frameStartPath,
            frameEndPath: scene.frameEndPath ?? null,
            prompt: scene.imagePrompt,
            videoClipConfig,
          };
          await makeVideoClient.generateVideoClip(req).catch((): undefined => undefined);
          setImagesProgress({ current: i + 1, total });
        }
        const refreshed = await makeVideoClient.get(active.id);
        if (refreshed.ok && refreshed.data) {
          setActive(refreshed.data);
          setProjects((prev) => prev.map((p) => (p.id === refreshed.data!.id ? refreshed.data! : p)));
        }
      } finally {
        setBusySceneId(null);
        setImagesProgress(null);
        setStatus('idle');
        cancelRef.current = false;
        setCanceling(false);
      }
    },
    [active]
  );

  // ---------------------------------------------------------------------------
  // Final export
  // ---------------------------------------------------------------------------

  const exportFinal = useCallback(
    async (outputPath?: string): Promise<void> => {
      if (!active) return;
      // A scene contributes a segment when it has a video clip OR a rendered
      // image (still images become slideshow clips via ffmpeg — no paid video
      // API required). Video clips take priority when both are present.
      const segments = active.scenes
        .filter((s) => s.videoClipPath || s.imagePath)
        .map((s) => ({
          videoClipPath: s.videoClipPath ?? null,
          imagePath: s.imagePath ?? null,
          audioPath: s.audioPath ?? null,
        }));
      if (segments.length === 0) {
        setBridgeError('Nothing to export yet. Render at least one scene image (or a video clip) first.');
        return;
      }
      setStatus('exporting');
      try {
        const req = {
          projectId: active.id,
          segments,
          outputPath: outputPath ?? '',
        };
        const result = await makeVideoClient.exportFinal(req);
        if (result.ok) {
          setExportedVideoPath(result.data.outputPath);
        } else {
          setBridgeError((result as MakeVideoFailure).error);
        }
      } finally {
        setStatus('idle');
      }
    },
    [active]
  );

  // ---------------------------------------------------------------------------
  // Frame start / end overrides
  // ---------------------------------------------------------------------------

  const setFrameStart = useCallback(
    async (sceneId: string, imagePath: string | null): Promise<void> => {
      if (!active) return;
      const updated: VideoProject = {
        ...active,
        scenes: active.scenes.map((s) => (s.id === sceneId ? { ...s, frameStartPath: imagePath } : s)),
      };
      await persist(updated);
    },
    [active, persist]
  );

  const setFrameEnd = useCallback(
    async (sceneId: string, imagePath: string | null): Promise<void> => {
      if (!active) return;
      const updated: VideoProject = {
        ...active,
        scenes: active.scenes.map((s) => (s.id === sceneId ? { ...s, frameEndPath: imagePath } : s)),
      };
      await persist(updated);
    },
    [active, persist]
  );

  return {
    projects,
    active,
    loading,
    bridgeError,
    status,
    busySceneId,
    imagesProgress,
    canceling,
    exportedVideoPath,
    reload,
    newProject,
    open,
    closeActive,
    remove,
    generateScript,
    generateImage,
    generateAllImages,
    generateVoice,
    generateAllVoices,
    generateVideoClip,
    generateAllVideoClips,
    cancelGeneration,
    exportFinal,
    setFrameStart,
    setFrameEnd,
  };
};

export default useMakeVideo;
