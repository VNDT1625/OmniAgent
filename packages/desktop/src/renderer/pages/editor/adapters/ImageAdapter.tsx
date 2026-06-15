/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ImageAdapter` — view + basic edits for images (Yêu cầu 2a, criterion 2.6:
 * "cắt, xoay, đổi kích cỡ"). Uses the Canvas API only (no extra deps).
 *
 * Content is a base64 payload (binary mode). Edits are applied on an offscreen
 * canvas; saving re-encodes to base64 PNG and persists via the shared hook.
 * Renderer-only.
 */

import { Button, InputNumber, Space } from '@arco-design/web-react';
import { Rotation, Save, ZoomIn } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorAdapterProps } from '../adapterRegistry';

/** Guess an image data-URL mime from the file extension (defaults to png). */
const mimeForFile = (filePath: string): string => {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png';
};

/** Load an HTMLImageElement from a data URL. */
const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = dataUrl;
  });

/**
 * View and apply simple transforms (rotate 90°, resize) to an image, then save.
 */
const ImageAdapter: React.FC<EditorAdapterProps> = ({
  filePath,
  content,
  dirty,
  saving,
  onChange,
  onSave,
  readOnly,
}) => {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const mime = mimeForFile(filePath);
  const dataUrl = content.startsWith('data:') ? content : `data:${mime};base64,${content}`;

  // Draw the current content onto the canvas whenever it changes.
  const draw = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const img = await loadImage(dataUrl);
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    setSize({ width: img.naturalWidth, height: img.naturalHeight });
  }, [dataUrl]);

  useEffect(() => {
    void draw();
  }, [draw]);

  /** Re-encode the canvas back into the content buffer as base64 (no data: prefix). */
  const commitCanvas = useCallback(
    (canvas: HTMLCanvasElement) => {
      const next = canvas.toDataURL(mime);
      const comma = next.indexOf(',');
      onChange(comma >= 0 ? next.slice(comma + 1) : next);
    },
    [mime, onChange]
  );

  /** Rotate the image 90° clockwise. */
  const rotate = useCallback(async () => {
    if (readOnly) return;
    const img = await loadImage(dataUrl);
    const out = document.createElement('canvas');
    out.width = img.naturalHeight;
    out.height = img.naturalWidth;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    commitCanvas(out);
  }, [readOnly, dataUrl, commitCanvas]);

  /** Resize the image to the given width/height. */
  const resize = useCallback(
    async (width: number, height: number) => {
      if (readOnly || width <= 0 || height <= 0) return;
      const img = await loadImage(dataUrl);
      const out = document.createElement('canvas');
      out.width = width;
      out.height = height;
      const ctx = out.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, width, height);
      commitCanvas(out);
    },
    [readOnly, dataUrl, commitCanvas]
  );

  return (
    <div className='flex flex-col h-full w-full gap-8px'>
      <Space wrap>
        <Button
          size='small'
          icon={<Rotation theme='outline' size='14' />}
          disabled={readOnly}
          onClick={() => void rotate()}
        >
          {t('editor.image.rotate')}
        </Button>
        <span className='text-12px text-t-tertiary inline-flex items-center gap-4px'>
          <ZoomIn theme='outline' size='14' />
          {t('editor.image.size')}
        </span>
        <InputNumber
          size='small'
          style={{ width: 96 }}
          min={1}
          value={size.width}
          disabled={readOnly}
          onChange={(v) => setSize((s) => ({ ...s, width: Number(v) || s.width }))}
        />
        <span className='text-t-tertiary'>×</span>
        <InputNumber
          size='small'
          style={{ width: 96 }}
          min={1}
          value={size.height}
          disabled={readOnly}
          onChange={(v) => setSize((s) => ({ ...s, height: Number(v) || s.height }))}
        />
        <Button size='small' disabled={readOnly} onClick={() => void resize(size.width, size.height)}>
          {t('editor.image.apply')}
        </Button>
        <Button
          type='primary'
          size='small'
          icon={<Save theme='outline' size='14' />}
          loading={saving}
          disabled={readOnly || !dirty}
          onClick={() => void onSave()}
        >
          {t('editor.action.save')}
        </Button>
      </Space>
      <div className='flex-1 min-h-0 overflow-auto flex-center bg-fill-2 rd-6px p-12px'>
        <canvas ref={canvasRef} className='max-w-full max-h-full object-contain' />
      </div>
    </div>
  );
};

export default ImageAdapter;
