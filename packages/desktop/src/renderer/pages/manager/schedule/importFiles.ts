/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Input-file helpers for the Schedule "Import" flow (Requirement 6.4–6.6,
 * extended for multi-file + prompt input).
 *
 * Two responsibilities:
 *
 * 1. **Downscale images before sending to the vision model.** A raw phone photo
 *    is 3–12 MB; sent verbatim as base64 it makes the multimodal request huge
 *    and either crawls or is rejected by the endpoint (the "3 minutes, no
 *    result" symptom). We re-encode to a max ~{@link MAX_IMAGE_DIM}px JPEG at
 *    {@link JPEG_QUALITY}, which a timetable/agenda reads fine but is ~20× smaller.
 *
 * 2. **Classify a picked file** into the channel that carries it to the model:
 *    `image` (downscaled data URL), `text` (read inline as UTF-8), or `doc`
 *    (binary office/pdf — extracted to text in the Main process by path).
 *
 * Renderer-only. No Node.js APIs (the path, when needed, comes from Electron's
 * `webUtils.getPathForFile` via the preload bridge).
 */

/** Longest edge (px) an image is downscaled to before sending to the model. */
export const MAX_IMAGE_DIM = 1600;
/** JPEG quality for the re-encoded image (0–1). */
export const JPEG_QUALITY = 0.82;
/** Hard cap on how many images we attach (keeps the request bounded). */
export const MAX_IMAGES = 4;

/** Text-like extensions read inline as UTF-8 in the renderer. */
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'log',
  'ics',
  'xml',
  'html',
  'htm',
]);

/** Binary document extensions extracted to text by the Main process (by path). */
const DOC_EXTS = new Set(['pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'odp', 'ods', 'rtf']);

/** Which transport a picked file uses on its way to the model. */
export type ImportFileKind = 'image' | 'text' | 'doc' | 'unsupported';

/** The lowercased extension of a file name (without the dot), or ''. */
const extOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** Classify a {@link File} into its import transport. */
export const classifyImportFile = (file: File): ImportFileKind => {
  if (file.type.startsWith('image/')) return 'image';
  const ext = extOf(file.name);
  if (ext === '' && file.type.startsWith('text/')) return 'text';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (DOC_EXTS.has(ext)) return 'doc';
  if (file.type.startsWith('text/')) return 'text';
  return 'unsupported';
};

/** Read a text-like file as a UTF-8 string (bounded — caller truncates further). */
export const readTextFile = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsText(file);
  });

/** Load a File into an HTMLImageElement via an object URL (revoked after load). */
const loadImage = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });

/**
 * Downscale + re-encode an image file to a compact JPEG data URL.
 *
 * The longest edge is clamped to {@link MAX_IMAGE_DIM}; smaller images are left
 * at native size (never upscaled). Falls back to the original bytes (as a data
 * URL) if the canvas pipeline is unavailable, so import still works.
 */
export const downscaleImageToDataUrl = async (file: File): Promise<string> => {
  try {
    const img = await loadImage(file);
    const longest = Math.max(img.naturalWidth, img.naturalHeight) || MAX_IMAGE_DIM;
    const scale = longest > MAX_IMAGE_DIM ? MAX_IMAGE_DIM / longest : 1;
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  } catch {
    // Fallback: send the original file unmodified rather than failing the import.
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    });
  }
};
