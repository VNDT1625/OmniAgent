/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ReportScreenshot` — renders a single milestone screenshot of a test step
 * (Yêu cầu 2b, criterion 2.5: "kèm ảnh ... trình bày đẹp kiểu IDE").
 *
 * The recorder writes PNGs to disk under `userData/testing/<id>/`. The renderer
 * cannot read disk directly, so the bytes are loaded as a data URL via the same
 * `getImageBase64` bridge the rest of the app uses for local images, then shown
 * in an Arco `Image` (click to zoom / preview — the IDE-style touch). Falls back
 * to a small "image unavailable" chip on a read error so a missing artifact
 * never breaks the report.
 *
 * Renderer-only: no Node.js APIs; disk access goes through the HTTP bridge.
 */

import { ipcBridge } from '@/common';
import { Image } from '@arco-design/web-react';
import { Pic } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Props for {@link ReportScreenshot}. */
export type ReportScreenshotProps = {
  /** Absolute path of the screenshot PNG written by the recorder. */
  path: string;
};

/** Load status of a single screenshot. */
type LoadState = 'loading' | 'ready' | 'error';

/**
 * Load + render one screenshot from its on-disk path, with zoom-on-click.
 */
const ReportScreenshot: React.FC<ReportScreenshotProps> = ({ path }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>('loading');
  const [src, setSrc] = useState<string>('');

  useEffect(() => {
    let active = true;
    setState('loading');
    ipcBridge.fs.getImageBase64
      .invoke({ path })
      .then((dataUrl) => {
        if (!active) return;
        if (dataUrl) {
          setSrc(dataUrl);
          setState('ready');
        } else {
          setState('error');
        }
      })
      .catch(() => {
        if (active) setState('error');
      });
    return () => {
      active = false;
    };
  }, [path]);

  if (state === 'error') {
    return (
      <span className='inline-flex items-center gap-4px rd-4px bg-fill-2 px-6px py-2px text-11px text-t-tertiary'>
        <Pic theme='outline' size='12' />
        {t('testing.report.screenshotUnavailable')}
      </span>
    );
  }

  return (
    <Image
      src={src}
      alt={t('testing.report.screenshotAlt')}
      width={120}
      height={76}
      className='rd-4px object-cover'
      loader={state === 'loading'}
      preview={state === 'ready'}
    />
  );
};

export default ReportScreenshot;
