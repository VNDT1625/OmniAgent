/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public surface of the content-extraction service. Import from here:
 *
 * ```ts
 * import { getContentExtractService } from '@process/services/contentExtract';
 * const out = await getContentExtractService().extract({ kind: 'auto', input });
 * ```
 */

export {
  createContentExtractService,
  getContentExtractService,
  type IContentExtractService,
  type ExtractSource,
  type ContentExtractServiceDeps,
  type FallbackTranscript,
} from './contentExtractService';
export type { ExtractOutcome, ExtractOk, ExtractFail, ExtractVia } from './contentExtractTypes';
export { createYtDlpTranscript, type IYtDlpTranscript, parseVtt, parseJson3 } from './ytDlpTranscript';
export { createFileToMarkdown, type IFileToMarkdown } from './fileToMarkdown';
export { findExternalTool, clearExternalToolCache, type ExternalToolName } from './externalTools';
export { writeYoutubeCookieFile, toNetscapeCookieFile, type CookieLike, type CookieReader } from './youtubeCookies';
