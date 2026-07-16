/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `MakeVideoView` — the Make Video Studio surface (AI movie/anime factory).
 *
 * Pipeline per scene:
 *  1. Generate script (LLM)
 *  2. Render image (cloud image model)
 *  3. Generate voice narration (OpenAI TTS / ElevenLabs)
 *  4. Generate video clip (fal.ai image-to-video, with optional end-frame)
 *  5. Export final .mp4 (ffmpeg concat + audio mux)
 *
 * Controls bar exposes model pickers for all 3 generation types plus config
 * dialogs for voice and video-clip providers. The storyboard grid shows each
 * scene with its image, audio player, video preview, and per-scene action buttons.
 *
 * Renderer-only; all text via i18n; Arco + icon-park + UnoCSS tokens only.
 */

import { Button, Empty, Message, Modal, Result, Select, Spin } from '@arco-design/web-react';
import {
  DocDetail,
  Download,
  Left,
  MovieBoard,
  Music,
  PauseOne,
  Picture,
  Plus,
  Refresh,
  Setting,
  VideoOne,
  VideoTwo,
} from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useAgents } from '@/renderer/hooks/agent/useAgents';
import { useMakeVideo } from './useMakeVideo';
import { useMakeVideoConfig } from './useMakeVideoConfig';
import { buildScriptModelOptions, type ScriptModelOption } from './scriptModelOptions';
import SceneCard from './components/SceneCard';
import NewProjectDialog from './components/NewProjectDialog';
import VoiceConfigDialog from './components/VoiceConfigDialog';
import VideoClipConfigDialog from './components/VideoClipConfigDialog';
import GenerationProgress, { getGenEstimate } from '../components/GenerationProgress';
import type { VideoProject } from './makeVideoClient';

type MakeVideoViewProps = {
  onBack: () => void;
};

const SCRIPT_MODEL_KEY = 'studio.makeVideo.scriptModel';
const IMAGE_MODEL_KEY = 'studio.makeVideo.imageModel';
const SCENE_COUNT_KEY = 'studio.makeVideo.sceneCount';

const MakeVideoView: React.FC<MakeVideoViewProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const mv = useMakeVideo();
  const cfg = useMakeVideoConfig();
  const { providers, getAvailableModels } = useModelProviderList();
  const { agents } = useAgents();
  const [creating, setCreating] = useState(false);
  const [showVoiceCfg, setShowVoiceCfg] = useState(false);
  const [showClipCfg, setShowClipCfg] = useState(false);

  // Script can run on a provider model (API-key cloud OR local OpenAI-compatible
  // server) OR a CLI agent — all three surfaced in one grouped picker.
  const scriptModelOptions = useMemo<ScriptModelOption[]>(
    () => buildScriptModelOptions(providers, getAvailableModels, agents),
    [providers, getAvailableModels, agents]
  );

  // Image generation needs a configured image-capable provider (no CLI path),
  // so it stays on the flat provider-model list.
  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const provider of providers) {
      for (const model of getAvailableModels(provider)) {
        if (seen.has(model)) continue;
        seen.add(model);
        options.push(model);
      }
    }
    return options;
  }, [providers, getAvailableModels]);

  const imageModelOptions = useMemo(() => {
    const imageLike = modelOptions.filter((m) => /image|imagen|imagine|flux|dall|sd|diffusion/i.test(m));
    return imageLike.length > 0 ? imageLike : modelOptions;
  }, [modelOptions]);

  const [scriptModel, setScriptModel] = useState<string | null>(() => localStorage.getItem(SCRIPT_MODEL_KEY));
  const [imageModel, setImageModel] = useState<string | null>(() => localStorage.getItem(IMAGE_MODEL_KEY));
  const [sceneCount, setSceneCount] = useState<number>(() => {
    const stored = Number(localStorage.getItem(SCENE_COUNT_KEY));
    return Number.isFinite(stored) && stored >= 2 ? stored : 5;
  });

  useEffect(() => {
    if (!scriptModel && scriptModelOptions.length > 0) setScriptModel(scriptModelOptions[0].value);
  }, [scriptModel, scriptModelOptions]);
  useEffect(() => {
    if (!imageModel && imageModelOptions.length > 0) setImageModel(imageModelOptions[0]);
  }, [imageModel, imageModelOptions]);

  const pickScriptModel = (v: string): void => {
    setScriptModel(v);
    try {
      localStorage.setItem(SCRIPT_MODEL_KEY, v);
    } catch {
      /* non-fatal */
    }
  };
  const pickImageModel = (v: string): void => {
    setImageModel(v);
    try {
      localStorage.setItem(IMAGE_MODEL_KEY, v);
    } catch {
      /* non-fatal */
    }
  };
  const pickSceneCount = (v: number): void => {
    setSceneCount(v);
    try {
      localStorage.setItem(SCENE_COUNT_KEY, String(v));
    } catch {
      /* non-fatal */
    }
  };

  const handleCreate = (topic: string, style: string, language: string): void => {
    setCreating(false);
    void mv.newProject(topic, style, language);
  };

  const confirmRemove = (project: VideoProject): void => {
    Modal.confirm({
      title: t('makeVideo.remove.title'),
      content: t('makeVideo.remove.content', { topic: project.topic }),
      okText: t('makeVideo.remove.confirm'),
      cancelText: t('makeVideo.remove.cancel'),
      okButtonProps: { status: 'danger' },
      onOk: () => mv.remove(project.id),
    });
  };

  // Show export success notification.
  useEffect(() => {
    if (mv.exportedVideoPath) {
      Message.success({ content: t('makeVideo.export.success', { path: mv.exportedVideoPath }), duration: 6000 });
    }
  }, [mv.exportedVideoPath, t]);

  const busy = mv.status !== 'idle';
  const showUnavailable = mv.bridgeError !== null && mv.projects.length === 0 && !mv.loading && !mv.active;

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <header className='shrink-0 flex items-center gap-12px px-16px h-52px border-b border-b-1'>
        <Button
          type='text'
          icon={<Left theme='outline' size={18} />}
          className='!text-t-secondary'
          onClick={mv.active ? mv.closeActive : onBack}
        >
          {t('studio.action.back')}
        </Button>
        <span className='flex items-center gap-8px'>
          <MovieBoard theme='outline' size={18} fill='currentColor' className='text-primary' />
          <span className='text-14px font-[500] text-t-primary truncate'>
            {mv.active ? mv.active.topic : t('makeVideo.title')}
          </span>
        </span>
        <div className='flex-1' />
        {!mv.active ? (
          <Button type='primary' icon={<Plus theme='outline' size={15} />} onClick={() => setCreating(true)}>
            {t('makeVideo.newProject')}
          </Button>
        ) : null}
      </header>

      {showUnavailable ? (
        <div className='flex-1 min-h-0 flex-center'>
          <Result
            status='warning'
            title={t('makeVideo.unavailableTitle')}
            subTitle={t('makeVideo.unavailableSubtitle')}
          >
            <Button type='outline' icon={<Refresh theme='outline' size={14} />} onClick={() => void mv.reload()}>
              {t('makeVideo.retry')}
            </Button>
          </Result>
        </div>
      ) : mv.active ? (
        <ProjectStoryboard
          project={mv.active}
          busy={busy}
          status={mv.status}
          busySceneId={mv.busySceneId}
          imagesProgress={mv.imagesProgress}
          canceling={mv.canceling}
          scriptModel={scriptModel}
          imageModel={imageModel}
          sceneCount={sceneCount}
          scriptModelOptions={scriptModelOptions}
          imageModelOptions={imageModelOptions}
          voiceReady={cfg.voiceReady}
          videoClipReady={cfg.videoClipReady}
          onPickScriptModel={pickScriptModel}
          onPickImageModel={pickImageModel}
          onPickSceneCount={pickSceneCount}
          onGenerateScript={() => scriptModel && void mv.generateScript(scriptModel, sceneCount)}
          onRenderAll={() => imageModel && void mv.generateAllImages(imageModel)}
          onRenderScene={(sceneId) => imageModel && void mv.generateImage(sceneId, imageModel)}
          onGenerateVoice={(sceneId) => void mv.generateVoice(sceneId, cfg.voiceConfig)}
          onGenerateAllVoices={() => void mv.generateAllVoices(cfg.voiceConfig)}
          onGenerateVideoClip={(sceneId) => void mv.generateVideoClip(sceneId, cfg.videoClipConfig)}
          onGenerateAllVideoClips={() => void mv.generateAllVideoClips(cfg.videoClipConfig)}
          onCancel={mv.cancelGeneration}
          onExportFinal={() => void mv.exportFinal()}
          onSetFrameEnd={(sceneId, path) => void mv.setFrameEnd(sceneId, path)}
          onOpenVoiceConfig={() => setShowVoiceCfg(true)}
          onOpenClipConfig={() => setShowClipCfg(true)}
        />
      ) : (
        <div className='flex-1 min-h-0 overflow-y-auto p-20px'>
          {mv.loading ? (
            <div className='h-full flex-center'>
              <Spin />
            </div>
          ) : mv.projects.length === 0 ? (
            <div className='h-full flex-center flex-col gap-16px'>
              <Empty description={t('makeVideo.emptyGallery')} />
              <Button type='primary' icon={<Plus theme='outline' size={15} />} onClick={() => setCreating(true)}>
                {t('makeVideo.newProject')}
              </Button>
            </div>
          ) : (
            <div className='grid gap-16px' style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
              {mv.projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onOpen={() => void mv.open(project.id)}
                  onRemove={() => confirmRemove(project)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <NewProjectDialog visible={creating} onCancel={() => setCreating(false)} onCreate={handleCreate} />

      <VoiceConfigDialog
        visible={showVoiceCfg}
        config={cfg.voiceConfig}
        onCancel={() => setShowVoiceCfg(false)}
        onSave={(c) => {
          cfg.setVoiceConfig(c);
          setShowVoiceCfg(false);
        }}
      />

      <VideoClipConfigDialog
        visible={showClipCfg}
        config={cfg.videoClipConfig}
        onCancel={() => setShowClipCfg(false)}
        onSave={(c) => {
          cfg.setVideoClipConfig(c);
          setShowClipCfg(false);
        }}
      />
    </div>
  );
};

/** A gallery card for one project. */
const ProjectCard: React.FC<{ project: VideoProject; onOpen: () => void; onRemove: () => void }> = ({
  project,
  onOpen,
  onRemove,
}) => {
  const { t } = useTranslation();
  const rendered = project.scenes.filter((s) => s.imagePath).length;
  const hasClips = project.scenes.filter((s) => s.videoClipPath).length;
  return (
    <div
      role='button'
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === 'Enter' && onOpen()}
      className='group flex flex-col rd-12px border border-b-1 bg-2 overflow-hidden cursor-pointer hover:border-primary transition-colors'
    >
      <div className='w-full aspect-video bg-fill-2 flex-center text-t-quaternary'>
        <VideoTwo theme='outline' size={28} />
      </div>
      <div className='flex flex-col gap-4px p-12px'>
        <span className='text-14px font-[600] text-t-primary line-clamp-1'>{project.topic}</span>
        <span className='text-12px text-t-tertiary'>
          {project.style} · {t('makeVideo.card.scenes', { count: project.scenes.length, rendered })}
          {hasClips > 0 && ` · ${t('makeVideo.card.clips', { count: hasClips })}`}
        </span>
        <div className='flex justify-end'>
          <Button
            type='text'
            size='mini'
            status='danger'
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            {t('makeVideo.remove.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
};

type StoryboardProps = {
  project: VideoProject;
  busy: boolean;
  status: ReturnType<typeof useMakeVideo>['status'];
  busySceneId: string | null;
  imagesProgress: ReturnType<typeof useMakeVideo>['imagesProgress'];
  canceling: boolean;
  scriptModel: string | null;
  imageModel: string | null;
  sceneCount: number;
  scriptModelOptions: ScriptModelOption[];
  imageModelOptions: string[];
  voiceReady: boolean;
  videoClipReady: boolean;
  onPickScriptModel: (v: string) => void;
  onPickImageModel: (v: string) => void;
  onPickSceneCount: (v: number) => void;
  onGenerateScript: () => void;
  onRenderAll: () => void;
  onRenderScene: (sceneId: string) => void;
  onGenerateVoice: (sceneId: string) => void;
  onGenerateAllVoices: () => void;
  onGenerateVideoClip: (sceneId: string) => void;
  onGenerateAllVideoClips: () => void;
  onCancel: () => void;
  onExportFinal: () => void;
  onSetFrameEnd: (sceneId: string, path: string | null) => void;
  onOpenVoiceConfig: () => void;
  onOpenClipConfig: () => void;
};

const ProjectStoryboard: React.FC<StoryboardProps> = ({
  project,
  busy,
  status,
  busySceneId,
  imagesProgress,
  canceling,
  scriptModel,
  imageModel,
  sceneCount,
  scriptModelOptions,
  imageModelOptions,
  voiceReady,
  videoClipReady,
  onPickScriptModel,
  onPickImageModel,
  onPickSceneCount,
  onGenerateScript,
  onRenderAll,
  onRenderScene,
  onGenerateVoice,
  onGenerateAllVoices,
  onGenerateVideoClip,
  onGenerateAllVideoClips,
  onCancel,
  onExportFinal,
  onSetFrameEnd,
  onOpenVoiceConfig,
  onOpenClipConfig,
}) => {
  const { t } = useTranslation();
  const hasScenes = project.scenes.length > 0;
  const hasImages = project.scenes.some((s) => s.imagePath);
  const hasClips = project.scenes.some((s) => s.videoClipPath);

  const statusLabel = (): string => {
    switch (status) {
      case 'script':
        return t('makeVideo.controls.generateScript');
      case 'images':
        return t('makeVideo.controls.renderAll');
      case 'voices':
        return t('makeVideo.controls.genAllVoices');
      case 'clips':
        return t('makeVideo.controls.genAllClips');
      case 'exporting':
        return t('makeVideo.controls.exporting');
      default:
        return '';
    }
  };

  return (
    <div className='flex-1 min-h-0 flex flex-col'>
      {/* Controls — row 1: script + image */}
      <div className='shrink-0 flex flex-wrap items-end gap-12px px-16px py-10px border-b border-b-1'>
        <Control label={t('makeVideo.controls.scriptModel')}>
          <Select
            value={scriptModel ?? undefined}
            onChange={onPickScriptModel}
            size='small'
            showSearch
            className='!w-200px'
            placeholder={t('makeVideo.controls.pickModel')}
            notFoundContent={t('makeVideo.controls.noModels')}
          >
            {(() => {
              const providerOpts = scriptModelOptions.filter((o) => o.kind === 'provider');
              const cliOpts = scriptModelOptions.filter((o) => o.kind === 'cli');
              // When only one kind exists, skip the group headers for a flat list.
              if (providerOpts.length === 0 || cliOpts.length === 0) {
                return scriptModelOptions.map(renderScriptModelOption);
              }
              return [
                <Select.OptGroup key='__providers' label={t('makeVideo.controls.providerGroup')}>
                  {providerOpts.map(renderScriptModelOption)}
                </Select.OptGroup>,
                <Select.OptGroup key='__cli' label={t('makeVideo.controls.cliGroup')}>
                  {cliOpts.map(renderScriptModelOption)}
                </Select.OptGroup>,
              ];
            })()}
          </Select>
        </Control>
        <Control label={t('makeVideo.controls.scenes')}>
          <Select value={sceneCount} onChange={onPickSceneCount} size='small' className='!w-72px'>
            {[3, 4, 5, 6, 8, 10, 12, 16, 20, 24].map((n) => (
              <Select.Option key={n} value={n}>
                {n}
              </Select.Option>
            ))}
          </Select>
        </Control>
        <Button
          type='primary'
          loading={status === 'script'}
          disabled={busy || !scriptModel}
          icon={<DocDetail theme='outline' size={15} />}
          onClick={onGenerateScript}
        >
          {hasScenes ? t('makeVideo.controls.regenerateScript') : t('makeVideo.controls.generateScript')}
        </Button>

        <div className='flex-1' />

        <Control label={t('makeVideo.controls.imageModel')}>
          <Select
            value={imageModel ?? undefined}
            onChange={onPickImageModel}
            size='small'
            showSearch
            className='!w-180px'
            placeholder={t('makeVideo.controls.pickModel')}
          >
            {imageModelOptions.map((m) => (
              <Select.Option key={m} value={m}>
                {m}
              </Select.Option>
            ))}
          </Select>
        </Control>
        <Button
          loading={status === 'images'}
          disabled={busy || !hasScenes || !imageModel}
          icon={<Picture theme='outline' size={15} />}
          onClick={onRenderAll}
        >
          {t('makeVideo.controls.renderAll')}
        </Button>
      </div>

      {/* Controls — row 2: voice + video clip + export */}
      <div className='shrink-0 flex flex-wrap items-center gap-10px px-16px py-8px border-b border-b-1 bg-fill-1/30'>
        {/* Voice */}
        <Button
          size='small'
          type='text'
          icon={<Setting theme='outline' size={14} />}
          onClick={onOpenVoiceConfig}
          className={voiceReady ? '!text-success' : '!text-t-tertiary'}
        >
          {t('makeVideo.controls.voiceConfig')}
        </Button>
        <Button
          size='small'
          loading={status === 'voices'}
          disabled={busy || !hasScenes || !voiceReady}
          icon={<Music theme='outline' size={14} />}
          onClick={onGenerateAllVoices}
        >
          {t('makeVideo.controls.genAllVoices')}
        </Button>

        <div className='w-1px h-20px bg-border-1 mx-4px' />

        {/* Video clip */}
        <Button
          size='small'
          type='text'
          icon={<Setting theme='outline' size={14} />}
          onClick={onOpenClipConfig}
          className={videoClipReady ? '!text-success' : '!text-t-tertiary'}
        >
          {t('makeVideo.controls.clipConfig')}
        </Button>
        <Button
          size='small'
          loading={status === 'clips'}
          disabled={busy || !hasImages || !videoClipReady}
          icon={<VideoOne theme='outline' size={14} />}
          onClick={onGenerateAllVideoClips}
        >
          {t('makeVideo.controls.genAllClips')}
        </Button>

        <div className='flex-1' />

        {/* Export */}
        <Button
          size='small'
          type='primary'
          loading={status === 'exporting'}
          disabled={busy || (!hasClips && !hasImages)}
          icon={<Download theme='outline' size={14} />}
          onClick={onExportFinal}
        >
          {t('makeVideo.controls.exportFinal')}
        </Button>
      </div>

      {/* Live generation progress */}
      {status !== 'idle' ? (
        <div className='shrink-0 flex items-center gap-12px px-16px py-10px border-b border-b-1'>
          <div className='flex-1 min-w-0'>
            <GenerationProgress
              active
              label={statusLabel()}
              current={imagesProgress?.current}
              total={imagesProgress?.total}
              estimateMs={status === 'script' ? getGenEstimate('makevideo.script', 20000) : undefined}
            />
          </div>
          {status === 'images' || status === 'voices' || status === 'clips' ? (
            <Button
              size='small'
              status='danger'
              type='outline'
              loading={canceling}
              disabled={canceling}
              icon={<PauseOne theme='outline' size={14} />}
              onClick={onCancel}
            >
              {canceling ? t('makeVideo.controls.stopping') : t('makeVideo.controls.stop')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Scene grid */}
      <div className='flex-1 min-h-0 overflow-y-auto p-16px'>
        {!hasScenes ? (
          <div className='h-full flex-center'>
            <Empty description={status === 'script' ? t('makeVideo.generatingScript') : t('makeVideo.noScenes')} />
          </div>
        ) : (
          <div className='grid gap-16px' style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {project.scenes.map((scene) => {
              const isBusy = busySceneId === scene.id;
              // Determine which sub-action is running for this scene.
              const busyAction = isBusy
                ? status === 'images'
                  ? 'image'
                  : status === 'voices'
                    ? 'voice'
                    : status === 'clips'
                      ? 'clip'
                      : null
                : null;
              return (
                <SceneCard
                  key={scene.id}
                  scene={scene}
                  busy={isBusy}
                  disabled={busy && !isBusy}
                  busyAction={busyAction}
                  voiceReady={voiceReady}
                  videoClipReady={videoClipReady}
                  onRenderImage={onRenderScene}
                  onGenerateVoice={onGenerateVoice}
                  onGenerateVideoClip={onGenerateVideoClip}
                  onSetFrameEnd={onSetFrameEnd}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

/** Render one script-model option (hoisted so it is not recreated per render). */
const renderScriptModelOption = (o: ScriptModelOption): React.ReactNode => (
  <Select.Option key={o.value} value={o.value}>
    {o.label}
  </Select.Option>
);

/** A small labelled control wrapper. */
const Control: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className='flex flex-col gap-3px'>
    <span className='text-11px text-t-tertiary font-[500]'>{label}</span>
    {children}
  </label>
);

export default MakeVideoView;
