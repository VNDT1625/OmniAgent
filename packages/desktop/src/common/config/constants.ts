/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tomni / Omni / AionUI common constants (rebranded)
 */

// ===== Product identity =====
export const PRODUCT_ID = 'tomni';
export const PRODUCT_NAME = 'Tomni';
export const PRODUCT_FULL_NAME = 'Tomni Agentic';
export const LEGACY_PRODUCT_ID = 'aionui';
export const LEGACY_PRODUCT_NAME = 'AionUi';

// ===== Workspace metadata =====
export const OMNI_WORKSPACE_META_DIR = '.omni';
export const LEGACY_WORKSPACE_META_DIR = '.aionui';
export const WORKSPACE_SPECS_DIR = 'specs';
export const WORKSPACE_UNDERSTAND_DIR = 'understand';
export const WORKSPACE_SPECS_REL_PATH = '.omni/specs';
export const LEGACY_WORKSPACE_SPECS_REL_PATH = '.aionui/specs';
export const WORKSPACE_UNDERSTAND_REL_PATH = '.omni/understand';
export const LEGACY_WORKSPACE_UNDERSTAND_REL_PATH = '.aionui/understand';

// ===== 文件处理相关常量 =====

/** 临时文件时间戳分隔符 */
export const AIONUI_TIMESTAMP_SEPARATOR = '_aionui_';

/** 用于匹配和清理时间戳后缀的正则表达式 */
export const AIONUI_TIMESTAMP_REGEX = /_aionui_\d{13}(\.\w+)?$/;
export const AIONUI_FILES_MARKER = '[[AION_FILES]]';

// ===== 媒体类型相关常量 =====

/** 支持的图片文件扩展名 */
export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg'] as const;

/** 文件扩展名到MIME类型的映射 */
export const MIME_TYPE_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.svg': 'image/svg+xml',
};

/** MIME类型到文件扩展名的映射 */
export const MIME_TO_EXT_MAP: Record<string, string> = {
  jpeg: '.jpg',
  jpg: '.jpg',
  png: '.png',
  gif: '.gif',
  webp: '.webp',
  bmp: '.bmp',
  tiff: '.tiff',
  'svg+xml': '.svg',
};

/** 默认图片文件扩展名 */
export const DEFAULT_IMAGE_EXTENSION = '.png';

// ===== WebUI 相关常量 =====

/** WebUI default port: 25808 for production, 25809 for development, 25810 for multi-instance dev */
export const WEBUI_DEFAULT_PORT = (() => {
  if (process.env.NODE_ENV === 'production') return 25808;
  if (process.env.AIONUI_MULTI_INSTANCE === '1') return 25810;
  return 25809;
})();

export const TEAM_MODE_ENABLED = true;

/**
 * Music Studio (Tomni Agentic music) feature flag.
 *
 * Gates the in-app music-making capability (page route + agent MCP tools).
 * Default OFF: the app behaves exactly as before until this is turned on, so
 * the feature can ship dark and be removed by flipping one constant. Mirrors
 * the TEAM_MODE_ENABLED gating pattern used by the router.
 */
export const MUSIC_STUDIO_ENABLED = true;

// ===== AI Provider 相关常量 =====

// Stable ID for the Google Auth virtual provider.
// Shared between frontend (useModelProviderList) and backend (SystemActions).
export const GOOGLE_AUTH_PROVIDER_ID = 'google-auth-gemini';
