/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the IDE LSP IPC surface (`process/ide/lang/
 * ideLspBridge.ts`). That bridge imports Node-only modules (child_process, the
 * install manager), so it must not be loaded in the renderer. Mirroring
 * {@link file://./ideClient.ts}, this module re-declares the channel-name strings,
 * rebuilds matching `bridge.buildProvider`/`buildEmitter` invokers, and borrows
 * only TYPES via `import type`.
 *
 * Every request is timeout-guarded so an unregistered channel (LSP bridge not
 * wired, e.g. WebUI mode) rejects fast and the editor falls back to its
 * built-in (Monaco TS worker / syntax) engine instead of hanging.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  IdeLspResult,
  LspDiagnosticsEnvelope,
  LspDocRequest,
  LspEnsureRequest,
  LspEnsureResult,
  LspFormatRequest,
  LspInstallRequest,
  LspListRequest,
  LspPositionRequest,
  LspRenameRequest,
  LspServerStatus,
  LspStopRequest,
  LspSyncRequest,
} from '@process/ide/lang/ideLspBridge';
import type { InstallOutcome } from '@process/ide/lang/lspInstallManager';
import type {
  LspCompletion,
  LspHover,
  LspLocation,
  LspSignature,
  LspSymbol,
  LspTextEdit,
} from '@process/ide/lang/lspRuntime';

/** IDE LSP IPC channel names (mirror of the bridge channel consts). */
const IDE_LSP_CHANNELS = {
  list: 'ide.lsp-list',
  install: 'ide.lsp-install',
  ensure: 'ide.lsp-ensure',
  sync: 'ide.lsp-sync',
  completion: 'ide.lsp-completion',
  hover: 'ide.lsp-hover',
  definition: 'ide.lsp-definition',
  references: 'ide.lsp-references',
  rename: 'ide.lsp-rename',
  format: 'ide.lsp-format',
  symbols: 'ide.lsp-symbols',
  signature: 'ide.lsp-signature',
  stop: 'ide.lsp-stop',
  diagnostics: 'ide.lsp-diagnostics',
} as const;

/** Timeout (ms) for a metadata/file op (fast). */
const FAST_TIMEOUT_MS = 15000;
/** Timeout (ms) for an install (npm fetch / PATH probe can be slow). */
const INSTALL_TIMEOUT_MS = 180000;
/** Timeout (ms) for a feature request (server round-trip). */
const FEATURE_TIMEOUT_MS = 20000;

/** Raw typed invokers — each `.invoke(req)` round-trips to the Main process. */
const channels = {
  list: bridge.buildProvider<IdeLspResult<LspServerStatus[]>, LspListRequest>(IDE_LSP_CHANNELS.list),
  install: bridge.buildProvider<IdeLspResult<InstallOutcome>, LspInstallRequest>(IDE_LSP_CHANNELS.install),
  ensure: bridge.buildProvider<IdeLspResult<LspEnsureResult>, LspEnsureRequest>(IDE_LSP_CHANNELS.ensure),
  sync: bridge.buildProvider<IdeLspResult<boolean>, LspSyncRequest>(IDE_LSP_CHANNELS.sync),
  completion: bridge.buildProvider<IdeLspResult<LspCompletion[]>, LspPositionRequest>(IDE_LSP_CHANNELS.completion),
  hover: bridge.buildProvider<IdeLspResult<LspHover>, LspPositionRequest>(IDE_LSP_CHANNELS.hover),
  definition: bridge.buildProvider<IdeLspResult<LspLocation[]>, LspPositionRequest>(IDE_LSP_CHANNELS.definition),
  references: bridge.buildProvider<IdeLspResult<LspLocation[]>, LspPositionRequest>(IDE_LSP_CHANNELS.references),
  rename: bridge.buildProvider<IdeLspResult<LspTextEdit[]>, LspRenameRequest>(IDE_LSP_CHANNELS.rename),
  format: bridge.buildProvider<IdeLspResult<LspTextEdit[]>, LspFormatRequest>(IDE_LSP_CHANNELS.format),
  symbols: bridge.buildProvider<IdeLspResult<LspSymbol[]>, LspDocRequest>(IDE_LSP_CHANNELS.symbols),
  signature: bridge.buildProvider<IdeLspResult<LspSignature[]>, LspPositionRequest>(IDE_LSP_CHANNELS.signature),
  stop: bridge.buildProvider<IdeLspResult<boolean>, LspStopRequest>(IDE_LSP_CHANNELS.stop),
  diagnostics: bridge.buildEmitter<LspDiagnosticsEnvelope>(IDE_LSP_CHANNELS.diagnostics),
};

/** Error thrown when an LSP IPC call does not reply within its budget. */
export class LspBridgeTimeoutError extends Error {
  constructor(channel: string, timeoutMs: number) {
    super(`[LspClient] No reply on "${channel}" after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'LspBridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so an unregistered channel rejects fast. */
const invokeWithTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new LspBridgeTimeoutError(channel, timeoutMs));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Timeout-guarded IDE LSP invokers for the renderer. */
export const lspClient = {
  /** List catalog servers (optionally filtered to one language) + install state. */
  list: (language?: string): Promise<IdeLspResult<LspServerStatus[]>> =>
    invokeWithTimeout(IDE_LSP_CHANNELS.list, () => channels.list.invoke({ language }), FAST_TIMEOUT_MS),
  /** Opt-in install (npm fetch or PATH adopt) of a catalog server. */
  install: (serverId: string): Promise<IdeLspResult<InstallOutcome>> =>
    invokeWithTimeout(IDE_LSP_CHANNELS.install, () => channels.install.invoke({ serverId }), INSTALL_TIMEOUT_MS),
  /**
   * Auto-enable the recommended server for a language: resolve + make it ready
   * (npm fetch into app data dir, or adopt a PATH binary). Resolves to the
   * server id when ready, or `null` when none is available / needs a manual
   * toolchain. Used by the editor to turn on smart understanding by default.
   */
  ensure: (language: string): Promise<IdeLspResult<LspEnsureResult>> =>
    invokeWithTimeout(IDE_LSP_CHANNELS.ensure, () => channels.ensure.invoke({ language }), INSTALL_TIMEOUT_MS),
  /** Open or update a document's text in the server (drives diagnostics). */
  sync: (rootPath: string, serverId: string, filePath: string, content: string): Promise<IdeLspResult<boolean>> =>
    invokeWithTimeout(
      IDE_LSP_CHANNELS.sync,
      () => channels.sync.invoke({ rootPath, serverId, filePath, content }),
      FAST_TIMEOUT_MS
    ),
  /** Completion items at a 1-based position. */
  completion: (
    rootPath: string,
    serverId: string,
    filePath: string,
    line: number,
    column: number
  ): Promise<IdeLspResult<LspCompletion[]>> =>
    invokeWithTimeout(
      IDE_LSP_CHANNELS.completion,
      () => channels.completion.invoke({ rootPath, serverId, filePath, line, column }),
      FEATURE_TIMEOUT_MS
    ),
  /** Hover info at a 1-based position. */
  hover: (
    rootPath: string,
    serverId: string,
    filePath: string,
    line: number,
    column: number
  ): Promise<IdeLspResult<LspHover>> =>
    invokeWithTimeout(
      IDE_LSP_CHANNELS.hover,
      () => channels.hover.invoke({ rootPath, serverId, filePath, line, column }),
      FEATURE_TIMEOUT_MS
    ),
  /** Definition location(s) at a 1-based position. */
  definition: (
    rootPath: string,
    serverId: string,
    filePath: string,
    line: number,
    column: number
  ): Promise<IdeLspResult<LspLocation[]>> =>
    invokeWithTimeout(
      IDE_LSP_CHANNELS.definition,
      () => channels.definition.invoke({ rootPath, serverId, filePath, line, column }),
      FEATURE_TIMEOUT_MS
    ),
  /** All references to the symbol at a 1-based position. */
  references: (
    rootPath: string,
    serverId: string,
    filePath: string,
    line: number,
    column: number
  ): Promise<IdeLspResult<LspLocation[]>> =>
    invokeWithTimeout(
      IDE_LSP_CHANNELS.references,
      () => channels.references.invoke({ rootPath, serverId, filePath, line, column }),
      FEATURE_TIMEOUT_MS
    ),
  /** Rename the symbol at a position; returns edits across the workspace. */
  rename: (
    rootPath: string,
    serverId: string,
    filePath: string,
    line: number,
    column: number,
    newName: string
  ): Promise<IdeLspResult<LspTextEdit[]>> =>
    invokeWithTimeout(
      IDE_LSP_CHANNELS.rename,
      () => channels.rename.invoke({ rootPath, serverId, filePath, line, column, newName }),
      FEATURE_TIMEOUT_MS
    ),
  /** Format the whole document; returns the edits to apply. */
  format: (
    rootPath: string,
    serverId: string,
    filePath: string,
    tabSize?: number,
    insertSpaces?: boolean
  ): Promise<IdeLspResult<LspTextEdit[]>> =>
    invokeWithTimeout(
      IDE_LSP_CHANNELS.format,
      () => channels.format.invoke({ rootPath, serverId, filePath, tabSize, insertSpaces }),
      FEATURE_TIMEOUT_MS
    ),
  /** Document symbols (outline) for a file. */
  symbols: (rootPath: string, serverId: string, filePath: string): Promise<IdeLspResult<LspSymbol[]>> =>
    invokeWithTimeout(
      IDE_LSP_CHANNELS.symbols,
      () => channels.symbols.invoke({ rootPath, serverId, filePath }),
      FEATURE_TIMEOUT_MS
    ),
  /** Signature help (parameter hints) at a 1-based position. */
  signature: (
    rootPath: string,
    serverId: string,
    filePath: string,
    line: number,
    column: number
  ): Promise<IdeLspResult<LspSignature[]>> =>
    invokeWithTimeout(
      IDE_LSP_CHANNELS.signature,
      () => channels.signature.invoke({ rootPath, serverId, filePath, line, column }),
      FEATURE_TIMEOUT_MS
    ),
  /** Dispose the session for a workspace + server. */
  stop: (rootPath: string, serverId: string): Promise<IdeLspResult<boolean>> =>
    invokeWithTimeout(IDE_LSP_CHANNELS.stop, () => channels.stop.invoke({ rootPath, serverId }), FAST_TIMEOUT_MS),
  /** Subscribe to server-pushed diagnostics. Returns an unsubscribe fn. */
  onDiagnostics: (listener: (event: LspDiagnosticsEnvelope) => void): (() => void) =>
    channels.diagnostics.on((envelope) => listener(envelope)),
};

export type { LspServerStatus, LspDiagnosticsEnvelope } from '@process/ide/lang/ideLspBridge';
export type {
  LspCompletion,
  LspHover,
  LspLocation,
  LspDiagnostic,
  LspTextEdit,
  LspSymbol,
  LspSignature,
} from '@process/ide/lang/lspRuntime';
export type { InstallOutcome, InstalledServer } from '@process/ide/lang/lspInstallManager';
