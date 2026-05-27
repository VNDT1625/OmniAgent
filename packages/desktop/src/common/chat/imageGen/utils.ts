/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import { jsonrepair } from 'jsonrepair';
import { IMAGE_EXTENSIONS, MIME_TYPE_MAP, MIME_TO_EXT_MAP, DEFAULT_IMAGE_EXTENSION } from '@/common/config/constants';

type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

export type ImageContent = {
  type: 'image_url';
  image_url: {
    url: string;
    detail: 'auto' | 'low' | 'high';
  };
};

export function safeJsonParse<T = unknown>(jsonString: string, fallbackValue: T): T {
  if (!jsonString || typeof jsonString !== 'string') {
    return fallbackValue;
  }
  try {
    return JSON.parse(jsonString) as T;
  } catch (_error) {
    try {
      const repairedJson = jsonrepair(jsonString);
      return JSON.parse(repairedJson) as T;
    } catch (_repairError) {
      console.warn('[ImageGen] JSON parse failed:', jsonString.substring(0, 50));
      return fallbackValue;
    }
  }
}

export function isImageFile(file_path: string): boolean {
  const ext = path.extname(file_path).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext as ImageExtension);
}

export function isHttpUrl(str: string): boolean {
  return str.startsWith('http://') || str.startsWith('https://');
}

export async function fileToBase64(file_path: string): Promise<string> {
  try {
    const fileBuffer = await fs.promises.readFile(file_path);
    return fileBuffer.toString('base64');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('ENOENT') || errorMessage.includes('no such file')) {
      throw new Error(`Image file not found: ${file_path}`, { cause: error });
    }
    throw new Error(`Failed to read image file: ${errorMessage}`, { cause: error });
  }
}

export function getImageMimeType(file_path: string): string {
  const ext = path.extname(file_path).toLowerCase();
  return MIME_TYPE_MAP[ext] || MIME_TYPE_MAP[DEFAULT_IMAGE_EXTENSION];
}

export function getFileExtensionFromDataUrl(dataUrl: string): string {
  const mimeTypeMatch = dataUrl.match(/^data:image\/([^;]+);base64,/);
  if (mimeTypeMatch && mimeTypeMatch[1]) {
    const mimeType = mimeTypeMatch[1].toLowerCase();
    return MIME_TO_EXT_MAP[mimeType] || DEFAULT_IMAGE_EXTENSION;
  }
  return DEFAULT_IMAGE_EXTENSION;
}

export async function saveGeneratedImage(base64Data: string, workspaceDir: string): Promise<string> {
  const timestamp = Date.now();
  const fileExtension = getFileExtensionFromDataUrl(base64Data);
  const file_name = `img-${timestamp}${fileExtension}`;
  const file_path = path.join(workspaceDir, file_name);

  const base64WithoutPrefix = base64Data.replace(/^data:image\/[^;]+;base64,/, '');
  const imageBuffer = Buffer.from(base64WithoutPrefix, 'base64');

  try {
    await fs.promises.writeFile(file_path, imageBuffer);
    return file_path;
  } catch (error) {
    console.error('[ImageGen] Failed to save image file:', error);
    throw new Error(`Failed to save image: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export function parseImageUris(raw: string[] | string | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  const parsed = safeJsonParse<string[]>(raw, null);
  return Array.isArray(parsed) ? parsed : [raw];
}

export async function processImageUri(imageUri: string, workspaceDir: string): Promise<ImageContent | null> {
  if (isHttpUrl(imageUri)) {
    return {
      type: 'image_url',
      image_url: { url: imageUri, detail: 'auto' },
    };
  }

  let processedUri = imageUri;
  if (imageUri.startsWith('@')) {
    processedUri = imageUri.substring(1);
  }

  let fullPath = processedUri;
  if (!path.isAbsolute(processedUri)) {
    fullPath = path.join(workspaceDir, processedUri);
  }

  try {
    await fs.promises.access(fullPath, fs.constants.F_OK);

    if (!isImageFile(fullPath)) {
      throw new Error(`File is not a supported image type: ${fullPath}`);
    }

    const base64Data = await fileToBase64(fullPath);
    const mimeType = getImageMimeType(fullPath);
    return {
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64Data}`, detail: 'auto' },
    };
  } catch (error) {
    const possiblePaths = [imageUri, path.join(workspaceDir, imageUri)].filter((p, i, arr) => arr.indexOf(p) === i);
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (errorMessage.includes('Image file not found') || errorMessage.includes('not a supported image type')) {
      throw error;
    }

    throw new Error(
      `Image file not found. Searched paths:\n${possiblePaths.map((p) => `- ${p}`).join('\n')}\n\nPlease ensure the image file exists and has a valid image extension (.jpg, .png, .gif, .webp, etc.)`,
      { cause: error }
    );
  }
}

/** Read a local image path (possibly prefixed with @) to a Buffer. */
export async function resolveLocalImageBuffer(
  imageUri: string,
  workspaceDir: string
): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  let processedUri = imageUri.startsWith('@') ? imageUri.substring(1) : imageUri;
  if (!path.isAbsolute(processedUri)) {
    processedUri = path.join(workspaceDir, processedUri);
  }
  await fs.promises.access(processedUri, fs.constants.F_OK);
  if (!isImageFile(processedUri)) {
    throw new Error(`File is not a supported image type: ${processedUri}`);
  }
  const buffer = await fs.promises.readFile(processedUri);
  return {
    buffer,
    mimeType: getImageMimeType(processedUri),
    filename: path.basename(processedUri),
  };
}
