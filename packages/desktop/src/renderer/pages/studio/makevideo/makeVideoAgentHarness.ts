/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge } from '@office-ai/platform';
import { useEffect } from 'react';
import {
  makeVideoClient,
  type ExportFinalRequest,
  type Scene,
  type VideoClipConfig,
  type VideoProject,
  type VoiceConfig,
} from './makeVideoClient';

export const MAKE_VIDEO_AGENT_CHANNEL = 'makevideo.agent.run';

export type MakeVideoAgentAction =
  | { tool: 'list_projects' }
  | { tool: 'get_project'; projectId: string }
  | { tool: 'create_project'; topic: string; style: string; language: string }
  | { tool: 'update_project'; projectId: string; topic?: string; style?: string; language?: string }
  | { tool: 'replace_scenes'; projectId: string; scenes: Scene[] }
  | { tool: 'update_scene'; projectId: string; sceneId: string; patch: Partial<Pick<Scene, 'title' | 'narration' | 'imagePrompt' | 'frameStartPath' | 'frameEndPath'>> }
  | { tool: 'reorder_scenes'; projectId: string; sceneIds: string[] }
  | { tool: 'delete_project'; projectId: string }
  | { tool: 'generate_script'; projectId: string; model: string; sceneCount: number }
  | { tool: 'generate_image'; projectId: string; sceneId: string; model: string }
  | { tool: 'generate_voice'; projectId: string; sceneId: string; voiceConfig: VoiceConfig }
  | { tool: 'generate_clip'; projectId: string; sceneId: string; videoClipConfig: VideoClipConfig }
  | { tool: 'export_final'; request: ExportFinalRequest };

export type MakeVideoAgentResult =
  | { ok: true; observation: string; project?: VideoProject; projects?: VideoProject[]; outputPath?: string }
  | { ok: false; error: string; reason: 'invalid-action' | 'not-found' | 'provider-error' | 'error' };

const channel = bridge.buildProvider<MakeVideoAgentResult, MakeVideoAgentAction>(MAKE_VIDEO_AGENT_CHANNEL);
let registered = false;
let localIdCounter = 0;

const createId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(localIdCounter++).toString(36)}`;

type MakeVideoAgentFailureReason = 'invalid-action' | 'not-found' | 'provider-error' | 'error';
type ProviderFailure = { ok: false; error: string };

const failure = (error: string, reason: MakeVideoAgentFailureReason): MakeVideoAgentResult => ({
  ok: false,
  error,
  reason,
});

const providerError = (result: ProviderFailure): MakeVideoAgentResult => providerError(result as ProviderFailure);

const loadProject = async (projectId: string): Promise<VideoProject | null> => {
  const result = await makeVideoClient.get(projectId);
  return result.ok ? result.data : null;
};

const saveProject = async (project: VideoProject): Promise<MakeVideoAgentResult> => {
  const result = await makeVideoClient.save({ ...project, updatedAt: Date.now() });
  return result.ok
    ? { ok: true, observation: `Saved film project "${result.data.topic}" with ${result.data.scenes.length} scenes.`, project: result.data }
    : providerError(result as ProviderFailure);
};

const normaliseScenes = (scenes: Scene[]): Scene[] =>
  scenes.map((scene, index) => ({
    ...scene,
    id: scene.id || createId('scene'),
    index,
    imagePath: scene.imagePath ?? null,
    imageError: scene.imageError ?? null,
    audioPath: scene.audioPath ?? null,
    audioError: scene.audioError ?? null,
    videoClipPath: scene.videoClipPath ?? null,
    videoClipError: scene.videoClipError ?? null,
    frameStartPath: scene.frameStartPath ?? null,
    frameEndPath: scene.frameEndPath ?? null,
  }));

export const runMakeVideoAgentAction = async (action: MakeVideoAgentAction): Promise<MakeVideoAgentResult> => {
  try {
    switch (action.tool) {
      case 'list_projects': {
        const result = await makeVideoClient.list();
        return result.ok
          ? { ok: true, observation: `Found ${result.data.length} film projects.`, projects: result.data }
          : providerError(result as ProviderFailure);
      }
      case 'get_project': {
        const project = await loadProject(action.projectId);
        return project
          ? { ok: true, observation: `Loaded "${project.topic}" with ${project.scenes.length} scenes.`, project }
          : failure(`Film project ${action.projectId} was not found.`, 'not-found');
      }
      case 'create_project': {
        const now = Date.now();
        return saveProject({
          id: createId('film'),
          topic: action.topic.trim(),
          style: action.style.trim(),
          language: action.language.trim(),
          scenes: [],
          createdAt: now,
          updatedAt: now,
        });
      }
      case 'update_project': {
        const project = await loadProject(action.projectId);
        if (!project) return failure(`Film project ${action.projectId} was not found.`, 'not-found');
        return saveProject({
          ...project,
          topic: action.topic?.trim() || project.topic,
          style: action.style?.trim() || project.style,
          language: action.language?.trim() || project.language,
        });
      }
      case 'replace_scenes': {
        const project = await loadProject(action.projectId);
        if (!project) return failure(`Film project ${action.projectId} was not found.`, 'not-found');
        return saveProject({ ...project, scenes: normaliseScenes(action.scenes) });
      }
      case 'update_scene': {
        const project = await loadProject(action.projectId);
        if (!project) return failure(`Film project ${action.projectId} was not found.`, 'not-found');
        if (!project.scenes.some((scene) => scene.id === action.sceneId)) {
          return failure(`Scene ${action.sceneId} was not found.`, 'not-found');
        }
        return saveProject({
          ...project,
          scenes: project.scenes.map((scene) => (scene.id === action.sceneId ? { ...scene, ...action.patch } : scene)),
        });
      }
      case 'reorder_scenes': {
        const project = await loadProject(action.projectId);
        if (!project) return failure(`Film project ${action.projectId} was not found.`, 'not-found');
        const byId = new Map(project.scenes.map((scene) => [scene.id, scene]));
        if (action.sceneIds.length !== project.scenes.length || action.sceneIds.some((id) => !byId.has(id))) {
          return failure('sceneIds must contain every existing scene exactly once.', 'invalid-action');
        }
        return saveProject({ ...project, scenes: action.sceneIds.map((id, index) => ({ ...byId.get(id)!, index })) });
      }
      case 'delete_project': {
        const result = await makeVideoClient.remove(action.projectId);
        return result.ok
          ? { ok: true, observation: `Deleted film project ${action.projectId}.`, projects: result.data }
          : providerError(result as ProviderFailure);
      }
      case 'generate_script': {
        const project = await loadProject(action.projectId);
        if (!project) return failure(`Film project ${action.projectId} was not found.`, 'not-found');
        const result = await makeVideoClient.generateScript({
          model: action.model,
          topic: project.topic,
          style: project.style,
          language: project.language,
          sceneCount: action.sceneCount,
        });
        if (!result.ok) return providerError(result as ProviderFailure);
        return saveProject({ ...project, scenes: normaliseScenes(result.data) });
      }
      case 'generate_image': {
        const project = await loadProject(action.projectId);
        const scene = project?.scenes.find((item) => item.id === action.sceneId);
        if (!project || !scene) return failure('Project or scene was not found.', 'not-found');
        const result = await makeVideoClient.generateImage({
          projectId: project.id,
          sceneId: scene.id,
          prompt: scene.imagePrompt,
          model: action.model,
        });
        if (!result.ok) return providerError(result as ProviderFailure);
        return saveProject({
          ...project,
          scenes: project.scenes.map((item) =>
            item.id === scene.id ? { ...item, imagePath: result.data.imagePath, imageError: null } : item,
          ),
        });
      }
      case 'generate_voice': {
        const project = await loadProject(action.projectId);
        const scene = project?.scenes.find((item) => item.id === action.sceneId);
        if (!project || !scene) return failure('Project or scene was not found.', 'not-found');
        const result = await makeVideoClient.generateVoice({
          projectId: project.id,
          sceneId: scene.id,
          text: scene.narration,
          voiceConfig: action.voiceConfig,
        });
        if (!result.ok) return providerError(result as ProviderFailure);
        const refreshed = await loadProject(project.id);
        return refreshed
          ? { ok: true, observation: `Generated narration for scene "${scene.title}".`, project: refreshed }
          : failure('Voice was generated but the project could not be refreshed.', 'error');
      }
      case 'generate_clip': {
        const project = await loadProject(action.projectId);
        const scene = project?.scenes.find((item) => item.id === action.sceneId);
        if (!project || !scene) return failure('Project or scene was not found.', 'not-found');
        const frameStartPath = scene.frameStartPath ?? scene.imagePath;
        if (!frameStartPath) return failure('Generate or assign a start-frame image before generating a clip.', 'invalid-action');
        const result = await makeVideoClient.generateVideoClip({
          projectId: project.id,
          sceneId: scene.id,
          frameStartPath,
          frameEndPath: scene.frameEndPath ?? null,
          prompt: scene.imagePrompt,
          videoClipConfig: action.videoClipConfig,
        });
        if (!result.ok) return providerError(result as ProviderFailure);
        const refreshed = await loadProject(project.id);
        return refreshed
          ? { ok: true, observation: `Generated video clip for scene "${scene.title}".`, project: refreshed }
          : failure('Clip was generated but the project could not be refreshed.', 'error');
      }
      case 'export_final': {
        const result = await makeVideoClient.exportFinal(action.request);
        return result.ok
          ? {
              ok: true,
              observation: `Exported the final film (${result.data.durationSec.toFixed(1)} seconds).`,
              outputPath: result.data.outputPath,
            }
          : providerError(result as ProviderFailure);
      }
      default:
        return failure('Unsupported Make Film action.', 'invalid-action');
    }
  } catch (cause) {
    return failure(cause instanceof Error ? cause.message : String(cause), 'error');
  }
};

export const registerMakeVideoAgentHarness = (): void => {
  if (registered) return;
  registered = true;
  channel.provider(runMakeVideoAgentAction);
};

export const useMakeVideoAgentHarness = (): void => {
  useEffect(() => {
    registerMakeVideoAgentHarness();
  }, []);
};
