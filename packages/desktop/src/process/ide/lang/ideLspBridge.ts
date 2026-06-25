/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE LSP IPC bridge — the Main-process surface that lets the renderer drive a
 * real language server: list/offer servers, install on opt-in, open/sync a
 * file, and ask for completion / hover / definition. Live diagnostics are
 * pushed back through an emitter so the editor can paint Monaco markers.
 *
 * This is the execution layer over the pure catalog ({@link file://./lspCatalog.ts})
 * + install manager ({@link file://./lspInstallManager.ts}) + runtime
 * ({@link file://./lspRuntime.ts}). All request channels use an always-resolving
 * envelope so the renderer never hangs on a swallowed rejection.
 *
 * Channels:
 *  - `ide.lsp-list`        — catalog + which servers are installed.
 *  - `ide.lsp-install`     — opt-in install (npm fetch or PATH adopt).
 *  - `ide.lsp-sync`        — open/update a document's text in the server.
 *  - `ide.lsp-completion`  — completion items at a position.
 *  - `ide.lsp-hover`       — hover info at a position.
 *  - `ide.lsp-definition`  — definition location(s) at a position.
 *  - `ide.lsp-stop`        — dispose a session.
 *  - `ide.lsp-diagnostics` — emitter: server-pushed diagnostics per file.
 *
 * The global bootstrap calls {@link registerIdeLspBridge} once.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { app } from 'electron';
import { LSP_CATALOG, catalogForLanguage, type LspServerInfo } from './lspCatalog';
import {
  ensureServerInstalled,
  listInstalledServerIds,
  type InstallOutcome,
} from './lspInstallManager';
import {
  disposeAllSessions,
  disposeSession,
  getOrCreateSession,
  type LspCompletion,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
  type LspSignature,
  type LspSymbol,
  type LspTextEdit,
} from './lspRuntime';

/** IPC channel names for the IDE LSP surface (renderer-safe contract). */
export const IDE_LSP_CHANNELS = {
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

/** Always-resolving result envelope. */
export type IdeLspResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** One catalog entry annotated with install + language match state. */
export type LspServerStatus = {
  server: LspServerInfo;
  installed: boolean;
};

/** Request shapes. */
export type LspListRequest = { language?: string };
export type LspInstallRequest = { serverId: string };
export type LspEnsureRequest = { language: string };
/** The server resolved+ready for a language, or null when none is available. */
export type LspEnsureResult = { serverId: string } | null;
export type LspSyncRequest = { rootPath: string; serverId: string; filePath: string; content: string };
export type LspPositionRequest = { rootPath: string; serverId: string; filePath: string; line: number; column: number };
export type LspRenameRequest = LspPositionRequest & { newName: string };
export type LspFormatRequest = { rootPath: string; serverId: string; filePath: string; tabSize?: number; insertSpaces?: boolean };
export type LspDocRequest = { rootPath: string; serverId: string; filePath: string };
export type LspStopRequest = { rootPath: string; serverId: string };

/** Emitter payload: diagnostics for one file (after a sync/edit). */
export type LspDiagnosticsEnvelope = {
  rootPath: string;
  serverId: string;
  filePath: string;
  diagnostics: LspDiagnostic[];
};

/** Typed LSP channels. Exported for bootstrap registration wiring. */
export const ideLspChannels = {
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

/** Forward a session's diagnostics to the renderer, tagged with its origin. */
const makeDiagnosticsListener =
  (rootPath: string, serverId: string) =>
  (filePath: string, diagnostics: LspDiagnostic[]): void => {
    ideLspChannels.diagnostics.emit({ rootPath, serverId, filePath, diagnostics });
  };

/** Resolve a session for a request, syncing diagnostics back to the renderer. */
const sessionFor = (req: { rootPath: string; serverId: string }) =>
  getOrCreateSession(req.rootPath, req.serverId, makeDiagnosticsListener(req.rootPath, req.serverId));

/**
 * Register the IDE LSP IPC handlers. Idempotent (re-registration replaces the
 * bound handlers). Intended to be called once during Main-process bootstrap.
 */
export function registerIdeLspBridge(): void {
  // Best-effort teardown of every spawned language server on app exit so no
  // child process is orphaned (especially on Windows where children are not
  // killed transitively). Registered once; `will-quit` fires after windows close.
  app.once('will-quit', (): void => {
    void disposeAllSessions().catch((): undefined => undefined);
  });

  ideLspChannels.list.provider(async (req): Promise<IdeLspResult<LspServerStatus[]>> => {
    try {
      const installed = new Set(await listInstalledServerIds());
      const pool = req.language ? [catalogForLanguage(req.language)].filter((s): s is LspServerInfo => Boolean(s)) : [...LSP_CATALOG];
      return { ok: true, data: pool.map((server) => ({ server, installed: installed.has(server.id) })) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.install.provider(async (req): Promise<IdeLspResult<InstallOutcome>> => {
    try {
      return { ok: true, data: await ensureServerInstalled(req.serverId) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Auto-enable: resolve the recommended server for a language and make sure it
  // is ready (npm fetch into the app data dir, or adopt a binary already on
  // PATH). Returns the server id when the editor can attach it now, or null when
  // no server serves the language / it needs a manual toolchain install. This
  // powers "smart understanding on by default" — the editor calls it on open
  // instead of waiting for a manual opt-in.
  ideLspChannels.ensure.provider(async (req): Promise<IdeLspResult<LspEnsureResult>> => {
    try {
      const server = catalogForLanguage(req.language);
      if (!server) return { ok: true, data: null };
      const outcome = await ensureServerInstalled(server.id);
      const ready = outcome.status === 'installed' || outcome.status === 'already-installed';
      return { ok: true, data: ready ? { serverId: server.id } : null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.sync.provider(async (req): Promise<IdeLspResult<boolean>> => {
    try {
      const session = await sessionFor(req);
      if (!session) return { ok: false, error: 'Language server unavailable.' };
      session.syncDocument(req.filePath, req.content);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.completion.provider(async (req): Promise<IdeLspResult<LspCompletion[]>> => {
    try {
      const session = await sessionFor(req);
      if (!session) return { ok: false, error: 'Language server unavailable.' };
      return { ok: true, data: await session.completion(req.filePath, req.line, req.column) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.hover.provider(async (req): Promise<IdeLspResult<LspHover>> => {
    try {
      const session = await sessionFor(req);
      if (!session) return { ok: false, error: 'Language server unavailable.' };
      return { ok: true, data: await session.hover(req.filePath, req.line, req.column) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.definition.provider(async (req): Promise<IdeLspResult<LspLocation[]>> => {
    try {
      const session = await sessionFor(req);
      if (!session) return { ok: false, error: 'Language server unavailable.' };
      return { ok: true, data: await session.definition(req.filePath, req.line, req.column) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.references.provider(async (req): Promise<IdeLspResult<LspLocation[]>> => {
    try {
      const session = await sessionFor(req);
      if (!session) return { ok: false, error: 'Language server unavailable.' };
      return { ok: true, data: await session.references(req.filePath, req.line, req.column) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.rename.provider(async (req): Promise<IdeLspResult<LspTextEdit[]>> => {
    try {
      const session = await sessionFor(req);
      if (!session) return { ok: false, error: 'Language server unavailable.' };
      return { ok: true, data: await session.rename(req.filePath, req.line, req.column, req.newName) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.format.provider(async (req): Promise<IdeLspResult<LspTextEdit[]>> => {
    try {
      const session = await sessionFor(req);
      if (!session) return { ok: false, error: 'Language server unavailable.' };
      return { ok: true, data: await session.formatting(req.filePath, req.tabSize, req.insertSpaces) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.symbols.provider(async (req): Promise<IdeLspResult<LspSymbol[]>> => {
    try {
      const session = await sessionFor(req);
      if (!session) return { ok: false, error: 'Language server unavailable.' };
      return { ok: true, data: await session.documentSymbols(req.filePath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.signature.provider(async (req): Promise<IdeLspResult<LspSignature[]>> => {
    try {
      const session = await sessionFor(req);
      if (!session) return { ok: false, error: 'Language server unavailable.' };
      return { ok: true, data: await session.signatureHelp(req.filePath, req.line, req.column) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ideLspChannels.stop.provider(async (req): Promise<IdeLspResult<boolean>> => {
    try {
      await disposeSession(req.rootPath, req.serverId);
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
