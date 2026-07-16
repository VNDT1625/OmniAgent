/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Translate } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SubtitleCue } from '../constants';

/**
 * Vietnamese real-time subtitle overlay (criterion 1.6).
 *
 * A presentational layer painted over the browser viewport region. It renders
 * the most recent translated caption cues fed to it; the live cue stream
 * (transcribe → translate, via `mediaPipeline`) is wired later (Task 15.x), so
 * for now it shows an idle hint when there are no cues and degrades gracefully.
 *
 * Pointer events are disabled on the container so the overlay never steals
 * clicks from the page beneath it — only the caption pill itself is visible.
 */
const SubtitleOverlay: React.FC<{
  enabled: boolean;
  cues: SubtitleCue[];
}> = ({ enabled, cues }) => {
  const { t } = useTranslation();

  if (!enabled) return null;

  // Show the latest couple of cues, newest at the bottom (player-style).
  const recent = cues.slice(-2);

  return (
    <div className='pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-6px px-16px pb-24px'>
      {recent.length === 0 ? (
        <span className='inline-flex items-center gap-8px px-14px py-8px rd-10px bg-[rgba(0,0,0,0.62)] text-13px text-white/90 backdrop-blur-sm'>
          <Translate theme='outline' size='14' />
          {t('browser.subtitle_overlay.idle')}
        </span>
      ) : (
        recent.map((cue) => (
          <span
            key={cue.id}
            className='max-w-[80%] px-16px py-8px rd-10px bg-[rgba(0,0,0,0.72)] text-15px leading-snug text-center text-white shadow-lg backdrop-blur-sm'
          >
            {cue.text}
          </span>
        ))
      )}
    </div>
  );
};

export default SubtitleOverlay;
