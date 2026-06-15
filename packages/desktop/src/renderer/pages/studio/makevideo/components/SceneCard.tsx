/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `SceneCard` — one scene of a video project. Shows:
 *  - The rendered image (or placeholder) with frame-start/end override buttons.
 *  - Title, narration, image prompt.
 *  - Per-scene action buttons: render image, generate voice, generate video clip.
 *  - Audio player when audioPath is set.
 *  - Video preview when videoClipPath is set.
 *
 * Renderer-only; all text via i18n; Arco + icon-park + UnoCSS tokens only.
 */

import { Button, Spin, Tooltip } from '@arco-design/web-react';
import { Caution, Film, Music, Picture, Refresh, VideoOne } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import GenerationProgress, { getGenEstimate } from '../../components/GenerationProgress';
import type { Scene } from '../makeVideoClient';

type SceneCardProps = {
  scene: Scene;
  busy: boolean;
  disabled: boolean;
  /** Which sub-action is currently running for this scene. */
  busyAction?: 'image' | 'voice' | 'clip' | null;
  voiceReady: boolean;
  videoClipReady: boolean;
  onRenderImage: (sceneId: string) => void;
  onGenerateVoice: (sceneId: string) => void;
  onGenerateVideoClip: (sceneId: string) => void;
  onSetFrameEnd: (sceneId: string, imagePath: string | null) => void;
};

const SceneCard: React.FC<SceneCardProps> = ({
  scene,
  busy,
  disabled,
  busyAction,
  voiceReady,
  videoClipReady,
  onRenderImage,
  onGenerateVoice,
  onGenerateVideoClip,
  onSetFrameEnd,
}) => {
  const { t } = useTranslation();
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [showVideo, setShowVideo] = useState(false);

  // Resolve the on-disk image to a data URL for display.
  useEffect(() => {
    let alive = true;
    if (!scene.imagePath) {
      setImageUrl(null);
      return;
    }
    void ipcBridge.fs.getImageBase64
      .invoke({ path: scene.imagePath })
      .then((base64) => {
        if (alive && base64) setImageUrl(base64);
      })
      .catch((): undefined => undefined);
    return () => {
      alive = false;
    };
  }, [scene.imagePath]);

  // Build a file:// URL for the video clip preview.
  useEffect(() => {
    if (scene.videoClipPath) {
      // Electron renderer can load local files via file:// protocol.
      setVideoUrl(`file://${scene.videoClipPath.replace(/\\/g, '/')}`);
    } else {
      setVideoUrl(null);
      setShowVideo(false);
    }
  }, [scene.videoClipPath]);

  const audioUrl = scene.audioPath ? `file://${scene.audioPath.replace(/\\/g, '/')}` : null;

  const isBusyImage = busy && busyAction === 'image';
  const isBusyVoice = busy && busyAction === 'voice';
  const isBusyClip = busy && busyAction === 'clip';

  return (
    <div className='flex flex-col rd-12px border border-b-1 bg-2 overflow-hidden'>
      {/* Image / Video area (16:9) */}
      <div className='relative w-full aspect-video bg-fill-2 flex-center overflow-hidden'>
        {isBusyImage ? (
          <div className='flex flex-col items-center gap-8px text-t-tertiary w-full px-16px'>
            <Spin size={22} />
            <span className='text-12px'>{t('makeVideo.scene.rendering')}</span>
            <GenerationProgress
              active
              label=''
              estimateMs={getGenEstimate('makevideo.image', 25000)}
              className='w-full max-w-200px'
            />
          </div>
        ) : isBusyClip ? (
          <div className='flex flex-col items-center gap-8px text-t-tertiary w-full px-16px'>
            <Spin size={22} />
            <span className='text-12px'>{t('makeVideo.scene.generatingClip')}</span>
            <GenerationProgress
              active
              label=''
              estimateMs={getGenEstimate('makevideo.clip', 60000)}
              className='w-full max-w-200px'
            />
          </div>
        ) : showVideo && videoUrl ? (
          <video
            src={videoUrl}
            controls
            autoPlay
            loop
            className='size-full object-cover'
            onError={() => setShowVideo(false)}
          />
        ) : imageUrl ? (
          <img src={imageUrl} alt={scene.title} className='size-full object-cover' />
        ) : scene.imageError ? (
          <div className='flex flex-col items-center gap-6px text-danger px-12px text-center'>
            <Caution theme='outline' size={22} />
            <span className='text-11px leading-snug'>{scene.imageError}</span>
          </div>
        ) : (
          <Picture theme='outline' size={28} className='text-t-quaternary' />
        )}

        {/* Scene index badge */}
        <span className='absolute top-8px left-8px px-7px py-1px rd-full bg-bg-1/80 text-11px font-[500] text-t-secondary'>
          {t('makeVideo.scene.index', { n: scene.index + 1 })}
        </span>

        {/* Video clip toggle */}
        {videoUrl && !isBusyClip && (
          <Tooltip content={showVideo ? t('makeVideo.scene.showImage') : t('makeVideo.scene.showVideo')}>
            <button
              type='button'
              onClick={() => setShowVideo((v) => !v)}
              className='absolute top-8px right-8px p-4px rd-full bg-bg-1/80 text-t-secondary hover:text-primary transition-colors border-none cursor-pointer'
            >
              {showVideo ? <Picture theme='outline' size={14} /> : <VideoOne theme='outline' size={14} />}
            </button>
          </Tooltip>
        )}
      </div>

      {/* Text */}
      <div className='flex flex-col gap-6px p-12px'>
        <span className='text-14px font-[600] text-t-primary'>{scene.title || t('makeVideo.scene.untitled')}</span>
        <p className='m-0 text-13px text-t-secondary leading-relaxed'>{scene.narration}</p>
        <p className='m-0 text-12px text-t-tertiary italic leading-snug line-clamp-2'>{scene.imagePrompt}</p>

        {/* Audio player */}
        {audioUrl && <audio src={audioUrl} controls className='w-full h-32px mt-4px' style={{ height: 32 }} />}
        {scene.audioError && (
          <span className='text-11px text-danger flex items-center gap-4px'>
            <Caution theme='outline' size={12} />
            {scene.audioError}
          </span>
        )}
        {scene.videoClipError && (
          <span className='text-11px text-danger flex items-center gap-4px'>
            <Caution theme='outline' size={12} />
            {scene.videoClipError}
          </span>
        )}

        {/* Frame end override */}
        {scene.frameEndPath && (
          <div className='flex items-center gap-6px text-11px text-t-tertiary'>
            <Film theme='outline' size={12} />
            <span className='truncate flex-1'>{t('makeVideo.scene.frameEndSet')}</span>
            <button
              type='button'
              onClick={() => onSetFrameEnd(scene.id, null)}
              className='text-danger hover:underline border-none bg-transparent cursor-pointer text-11px p-0'
            >
              {t('makeVideo.scene.clearFrameEnd')}
            </button>
          </div>
        )}

        {/* Action buttons */}
        <div className='flex flex-wrap gap-6px pt-4px'>
          {/* Render image */}
          <Button
            size='mini'
            type={imageUrl ? 'text' : 'outline'}
            loading={isBusyImage}
            disabled={disabled}
            icon={imageUrl ? <Refresh theme='outline' size={13} /> : <Picture theme='outline' size={13} />}
            onClick={() => onRenderImage(scene.id)}
          >
            {imageUrl ? t('makeVideo.scene.regenerate') : t('makeVideo.scene.render')}
          </Button>

          {/* Generate voice */}
          <Tooltip content={!voiceReady ? t('makeVideo.scene.voiceNotConfigured') : undefined}>
            <Button
              size='mini'
              type={scene.audioPath ? 'text' : 'outline'}
              loading={isBusyVoice}
              disabled={disabled || !voiceReady}
              icon={<Music theme='outline' size={13} />}
              onClick={() => onGenerateVoice(scene.id)}
            >
              {scene.audioPath ? t('makeVideo.scene.regenVoice') : t('makeVideo.scene.genVoice')}
            </Button>
          </Tooltip>

          {/* Generate video clip */}
          <Tooltip
            content={
              !videoClipReady
                ? t('makeVideo.scene.clipNotConfigured')
                : !imageUrl
                  ? t('makeVideo.scene.clipNeedsImage')
                  : undefined
            }
          >
            <Button
              size='mini'
              type={scene.videoClipPath ? 'text' : 'outline'}
              loading={isBusyClip}
              disabled={disabled || !videoClipReady || !imageUrl}
              icon={<VideoOne theme='outline' size={13} />}
              onClick={() => onGenerateVideoClip(scene.id)}
            >
              {scene.videoClipPath ? t('makeVideo.scene.regenClip') : t('makeVideo.scene.genClip')}
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
};

export default SceneCard;
