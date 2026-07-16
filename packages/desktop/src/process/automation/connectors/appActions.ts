/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * App-function connectors for the Automation feature — the nodes that drive an
 * AionUi sub-app to *produce* an artifact the rest of the pipeline can upload or
 * publish.
 *
 *  - `action.app.makeVideo`: runs the Make Video pipeline (LLM scene script →
 *    cloud image per scene), persists a {@link VideoProject}, and yields the
 *    first rendered scene image as the artifact. (Stitching the scenes into a
 *    single `.mp4` is a later enhancement; the node already produces a concrete
 *    file so downstream cloud/social steps work today.)
 *  - `action.app.editor`: writes a text/markdown document to disk (create or
 *    append) and yields it as the artifact.
 *
 * Both connectors are dependency-injected so they unit-test without Electron,
 * the network, or the real filesystem. The production wiring (in the bridge)
 * supplies the Make Video store + provider-backed `runScript`/`runImage` and a
 * real fs.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EditorNodeConfig, MakeVideoNodeConfig, Artifact } from '../automationTypes';
import type { Scene, VideoProject } from '@process/makevideo/makeVideoTypes';
import { makeArtifact, substituteInput } from './artifacts';

// ---------------------------------------------------------------------------
// Make Video connector
// ---------------------------------------------------------------------------

/** The Make Video collaborators the connector needs (all injectable for tests). */
export type MakeVideoActionDeps = {
  /** Provider-backed scene-script generation (mirrors `makeVideoBridge.runScript`). */
  runScript: (req: {
    model: string;
    topic: string;
    style: string;
    language: string;
    sceneCount: number;
  }) => Promise<Scene[]>;
  /** Provider-backed per-scene image render (mirrors `makeVideoBridge.runImage`). */
  runImage: (req: {
    projectId: string;
    sceneId: string;
    prompt: string;
    model: string;
  }) => Promise<{ imagePath: string | null; text: string }>;
  /** Persist the produced project so it shows up in the Make Video Studio view. */
  saveProject: (project: VideoProject) => Promise<VideoProject>;
  /**
   * Stitch the rendered scene images into an `.mp4`. Optional: when omitted, the
   * node falls back to yielding the first scene image as its artifact.
   */
  renderVideo?: (scenes: Array<{ imagePath: string; durationSec: number }>, outputPath: string) => Promise<string>;
  /** Directory for rendered videos. Defaults to the system temp dir. */
  videoDir?: string;
  /** Clock for project timestamps. Defaults to `Date.now`. */
  now?: () => number;
  /** Id generator for the project. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
};

/** Result of an `action.app.makeVideo` node — the project plus its artifact. */
export type MakeVideoActionResult = {
  /** The persisted project id. */
  projectId: string;
  /** Number of scenes the script produced. */
  sceneCount: number;
  /** The artifact (first rendered scene image), or `null` when none rendered. */
  artifact: Artifact | null;
};

/**
 * Create the Make Video action connector. It generates a script, renders every
 * scene image (sequentially, to be gentle on provider rate limits), persists the
 * project, and returns the first rendered image as the pipeline artifact.
 */
export const createMakeVideoAction = (deps: MakeVideoActionDeps) => {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;

  return {
    async run(config: MakeVideoNodeConfig, _input: unknown, nodeName: string): Promise<MakeVideoActionResult> {
      const topic = config.topic?.trim() ?? '';
      if (topic.length === 0) throw new Error(`"${nodeName}" is missing a video topic.`);
      const scriptModel = config.scriptModel?.trim() ?? '';
      if (scriptModel.length === 0) throw new Error(`"${nodeName}" is missing a script model.`);

      const sceneCount =
        Number.isFinite(config.sceneCount) && config.sceneCount > 0 ? Math.floor(config.sceneCount) : 4;
      const language = config.language?.trim() || 'English';
      const style = config.style?.trim() || 'cinematic';

      const scenes = await deps.runScript({ model: scriptModel, topic, style, language, sceneCount });

      const projectId = newId();
      let working: Scene[] = scenes;

      // Render each scene image when an image model is configured.
      const imageModel = config.imageModel?.trim() ?? '';
      if (imageModel.length > 0) {
        const rendered: Scene[] = [];
        for (const scene of scenes) {
          try {
            const { imagePath } = await deps.runImage({
              projectId,
              sceneId: scene.id,
              prompt: scene.imagePrompt,
              model: imageModel,
            });
            rendered.push({
              ...scene,
              imagePath: imagePath ?? null,
              imageError: imagePath ? null : 'No image produced.',
            });
          } catch (error) {
            rendered.push({ ...scene, imageError: error instanceof Error ? error.message : String(error) });
          }
        }
        working = rendered;
      }

      const ts = now();
      const project: VideoProject = {
        id: projectId,
        topic,
        style,
        language,
        scenes: working,
        createdAt: ts,
        updatedAt: ts,
      };
      await deps.saveProject(project);

      const renderedScenes = working.filter(
        (s): s is Scene & { imagePath: string } => typeof s.imagePath === 'string' && s.imagePath.length > 0
      );

      // When asked, stitch the scene images into a real .mp4 and yield it as the
      // artifact; otherwise fall back to the first rendered scene image.
      if (config.renderVideo && deps.renderVideo && renderedScenes.length > 0) {
        const durationSec =
          Number.isFinite(config.secondsPerScene) && (config.secondsPerScene ?? 0) > 0
            ? (config.secondsPerScene as number)
            : 3;
        const outputDir = deps.videoDir ?? os.tmpdir();
        const outputPath = path.join(outputDir, `make-video-${projectId}.mp4`);
        try {
          const videoPath = await deps.renderVideo(
            renderedScenes.map((s) => ({ imagePath: s.imagePath, durationSec })),
            outputPath
          );
          return { projectId, sceneCount: working.length, artifact: makeArtifact(videoPath, topic) };
        } catch (error) {
          // Render failure should not lose the whole run: fall back to the image.
          console.error('[Automation/makeVideo] video render failed, falling back to image:', error);
        }
      }

      const firstImage = renderedScenes[0];
      const artifact = firstImage ? makeArtifact(firstImage.imagePath, topic) : null;

      return { projectId, sceneCount: working.length, artifact };
    },
  };
};

// ---------------------------------------------------------------------------
// Editor connector
// ---------------------------------------------------------------------------

/** Minimal fs surface the editor connector needs (injectable for tests). */
export type EditorActionFs = {
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
  writeFile(filePath: string, data: string, encoding: 'utf-8'): Promise<void>;
  appendFile(filePath: string, data: string, encoding: 'utf-8'): Promise<void>;
};

/** Default fs adapter backed by Node's `fs/promises`. */
const defaultEditorFs: EditorActionFs = {
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
  writeFile: (filePath, data, encoding) => fs.promises.writeFile(filePath, data, { encoding }),
  appendFile: (filePath, data, encoding) => fs.promises.appendFile(filePath, data, { encoding }),
};

/** Injectable deps for {@link createEditorAction}. */
export type EditorActionDeps = {
  /** File-system implementation. Defaults to `fs/promises`. */
  fs?: EditorActionFs;
};

/** Result of an `action.app.editor` node — the written file as an artifact. */
export type EditorActionResult = {
  /** Absolute path written. */
  path: string;
  /** Number of characters written. */
  bytes: number;
  /** The written file as a pipeline artifact. */
  artifact: Artifact;
};

/**
 * Create the editor action connector. It writes templated text content to a
 * file (creating parent directories as needed) and returns the file as the
 * pipeline artifact so a downstream node can upload or attach it.
 */
export const createEditorAction = (deps?: EditorActionDeps) => {
  const fsImpl = deps?.fs ?? defaultEditorFs;

  return {
    async run(config: EditorNodeConfig, input: unknown, nodeName: string): Promise<EditorActionResult> {
      const target = config.path?.trim() ?? '';
      if (target.length === 0) throw new Error(`"${nodeName}" is missing an output file path.`);

      const content = substituteInput(config.content ?? '', input);
      await fsImpl.mkdir(path.dirname(target), { recursive: true });

      if (config.operation === 'append') {
        await fsImpl.appendFile(target, content, 'utf-8');
      } else {
        await fsImpl.writeFile(target, content, 'utf-8');
      }

      return { path: target, bytes: content.length, artifact: makeArtifact(target) };
    },
  };
};
