/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LSP runtime — spawns an installed language server and speaks LSP to it over
 * stdio, exposing the handful of features the editor needs: completion, hover,
 * go-to-definition, and live diagnostics.
 *
 * One {@link LspSession} per (rootPath + server id). The session owns the child
 * process, performs the `initialize` handshake, tracks open documents
 * (`textDocument/didOpen` + `didChange`), and routes JSON-RPC responses back to
 * their awaiting callers by `id`. Server-initiated `publishDiagnostics`
 * notifications are surfaced through a callback so the bridge can forward them
 * to the renderer as Monaco markers.
 *
 * The wire codec is the pure {@link file://./lspProtocol.ts}; this module adds
 * the process + state + request/response correlation. Sessions are cached by
 * {@link getOrCreateSession} and torn down by {@link disposeSession} /
 * {@link disposeAllSessions} (called on app quit).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  LspMessageBuffer,
  buildNotification,
  buildRequest,
  encodeMessage,
  isNotification,
  isResponse,
  type JsonRpcResponse,
} from './lspProtocol';
import { ensureServerInstalled, type InstalledServer } from './lspInstallManager';
import { parseDocumentSymbols, parseTextEditArray, parseWorkspaceEdit } from './lspConvert';

/** A diagnostic as published by a server (subset of the LSP shape). */
export type LspDiagnostic = {
  /** 1-based line (converted from LSP's 0-based range). */
  line: number;
  /** 1-based column. */
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source?: string;
};

/** A completion item (subset). */
export type LspCompletion = {
  label: string;
  detail?: string;
  kind?: number;
  insertText?: string;
};

/** A hover result (markdown/plaintext contents). */
export type LspHover = { contents: string } | null;

/** A definition location. */
export type LspLocation = { path: string; line: number; column: number };

/** A single text edit (1-based range) produced by rename/format. */
export type LspTextEdit = {
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
};

/** A document symbol for the outline view (nested via `children`). */
export type LspSymbol = {
  name: string;
  kind: number;
  line: number;
  column: number;
  detail?: string;
  children?: LspSymbol[];
};

/** One signature for signature help (parameter hints). */
export type LspSignature = {
  label: string;
  parameters: string[];
  activeParameter?: number;
};

/** Callback invoked when the server publishes diagnostics for a file. */
export type DiagnosticsListener = (filePath: string, diagnostics: LspDiagnostic[]) => void;

/** Per-request timeout (ms). A server that never replies must not wedge a call. */
const REQUEST_TIMEOUT_MS = 15000;

/** Map an LSP severity number (1..4) to our union. */
const toSeverity = (value: unknown): LspDiagnostic['severity'] => {
  switch (value) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    default:
      return 'hint';
  }
};

/** Convert an LSP 0-based position to our 1-based line/column. */
const toOneBased = (pos: { line?: number; character?: number } | undefined): { line: number; column: number } => ({
  line: (pos?.line ?? 0) + 1,
  column: (pos?.character ?? 0) + 1,
});

/** Convert a file path to an LSP `file://` URI. */
const toUri = (filePath: string): string => pathToFileURL(filePath).toString();

/** Convert an LSP `file://` URI back to a filesystem path. */
const fromUri = (uri: string): string => {
  try {
    return decodeURIComponent(new URL(uri).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
  } catch {
    return uri;
  }
};

/** One running language-server session bound to a workspace root. */
export class LspSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new LspMessageBuffer();
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly openDocs = new Map<string, number>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly rootPath: string,
    private readonly server: InstalledServer,
    private readonly onDiagnostics: DiagnosticsListener
  ) {}

  /** Whether the underlying process is alive. */
  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  /** Spawn the process and run the `initialize` handshake (once). */
  async start(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doStart();
    return this.initPromise;
  }

  private async doStart(): Promise<void> {
    const child = spawn(this.server.command, this.server.args, {
      cwd: this.rootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    child.on('exit', () => this.handleExit());
    child.on('error', () => this.handleExit());

    await this.request('initialize', {
      processId: process.pid,
      rootUri: toUri(this.rootPath),
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: { completionItem: { snippetSupport: false } },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          rename: { dynamicRegistration: false, prepareSupport: false },
          formatting: { dynamicRegistration: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          signatureHelp: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: false },
        },
      },
      workspaceFolders: [{ uri: toUri(this.rootPath), name: 'workspace' }],
    });
    this.notify('initialized', {});
    this.initialized = true;
  }

  /** Feed a stdout chunk through the decoder and dispatch complete messages. */
  private onData(chunk: Buffer): void {
    this.decoder.append(chunk);
    for (const message of this.decoder.drain()) {
      if (isResponse(message)) {
        this.resolvePending(message);
      } else if (isNotification(message) && message.method === 'textDocument/publishDiagnostics') {
        this.handlePublishDiagnostics(message.params);
      }
      // Server-initiated requests (e.g. workspace/configuration) are ignored;
      // the servers we ship work without answering them for these features.
    }
  }

  /** Resolve/reject the awaiting caller for a response `id`. */
  private resolvePending(response: JsonRpcResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.error) entry.reject(new Error(response.error.message));
    else entry.resolve(response.result);
  }

  /** Forward a `publishDiagnostics` notification to the listener. */
  private handlePublishDiagnostics(params: unknown): void {
    const payload = params as { uri?: string; diagnostics?: unknown[] } | undefined;
    if (!payload?.uri) return;
    const raw = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
    const diagnostics: LspDiagnostic[] = raw.map((item) => {
      const d = item as {
        range?: { start?: unknown; end?: unknown };
        message?: unknown;
        severity?: unknown;
        source?: unknown;
      };
      const start = toOneBased(d.range?.start as { line?: number; character?: number });
      const end = toOneBased(d.range?.end as { line?: number; character?: number });
      return {
        line: start.line,
        column: start.column,
        endLine: end.line,
        endColumn: end.column,
        message: typeof d.message === 'string' ? d.message : '',
        severity: toSeverity(d.severity),
        source: typeof d.source === 'string' ? d.source : undefined,
      };
    });
    this.onDiagnostics(fromUri(payload.uri), diagnostics);
  }

  /** Tear down pending callers when the process dies. */
  private handleExit(): void {
    this.initialized = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Language server exited.'));
    }
    this.pending.clear();
    this.openDocs.clear();
  }

  /** Send a JSON-RPC request and await its response (timeout-guarded). */
  private request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (!child || child.exitCode !== null) return Promise.reject(new Error('Language server is not running.'));
    const id = this.nextId++;
    const message = encodeMessage(buildRequest(id, method, params));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(message);
    });
  }

  /** Send a fire-and-forget JSON-RPC notification. */
  private notify(method: string, params?: unknown): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.stdin.write(encodeMessage(buildNotification(method, params)));
  }

  /** LSP language id for a file, derived from extension (best-effort). */
  private languageId(filePath: string): string {
    const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
    const map: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescriptreact',
      js: 'javascript',
      jsx: 'javascriptreact',
      py: 'python',
      rs: 'rust',
      go: 'go',
      c: 'c',
      h: 'c',
      cpp: 'cpp',
      cc: 'cpp',
      hpp: 'cpp',
    };
    return map[ext] ?? 'plaintext';
  }

  /** Open a document or push a new version if already open. */
  syncDocument(filePath: string, content: string): void {
    if (!this.initialized) return;
    const uri = toUri(filePath);
    const version = (this.openDocs.get(filePath) ?? 0) + 1;
    this.openDocs.set(filePath, version);
    if (version === 1) {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.languageId(filePath), version, text: content },
      });
    } else {
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }
  }

  /** Request completion items at a 1-based position. */
  async completion(filePath: string, line: number, column: number): Promise<LspCompletion[]> {
    const result = await this.request<unknown>('textDocument/completion', {
      textDocument: { uri: toUri(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
    });
    const items = Array.isArray(result) ? result : ((result as { items?: unknown[] })?.items ?? []);
    return (items as unknown[]).map((item) => {
      const c = item as { label?: unknown; detail?: unknown; kind?: unknown; insertText?: unknown };
      return {
        label: typeof c.label === 'string' ? c.label : '',
        detail: typeof c.detail === 'string' ? c.detail : undefined,
        kind: typeof c.kind === 'number' ? c.kind : undefined,
        insertText: typeof c.insertText === 'string' ? c.insertText : undefined,
      };
    });
  }

  /** Request hover info at a 1-based position. */
  async hover(filePath: string, line: number, column: number): Promise<LspHover> {
    const result = await this.request<unknown>('textDocument/hover', {
      textDocument: { uri: toUri(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
    });
    const contents = (result as { contents?: unknown })?.contents;
    if (contents == null) return null;
    if (typeof contents === 'string') return { contents };
    if (Array.isArray(contents)) {
      return {
        contents: contents
          .map((c) => (typeof c === 'string' ? c : ((c as { value?: string })?.value ?? '')))
          .join('\n'),
      };
    }
    const value = (contents as { value?: unknown }).value;
    return { contents: typeof value === 'string' ? value : '' };
  }

  /** Request definition location(s) at a 1-based position. */
  async definition(filePath: string, line: number, column: number): Promise<LspLocation[]> {
    const result = await this.request<unknown>('textDocument/definition', {
      textDocument: { uri: toUri(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
    });
    const list = Array.isArray(result) ? result : result ? [result] : [];
    return list.map((item) => {
      const loc = item as {
        uri?: string;
        targetUri?: string;
        range?: { start?: unknown };
        targetRange?: { start?: unknown };
      };
      const uri = loc.uri ?? loc.targetUri ?? '';
      const start = toOneBased((loc.range?.start ?? loc.targetRange?.start) as { line?: number; character?: number });
      return { path: fromUri(uri), line: start.line, column: start.column };
    });
  }

  /** Find all references to the symbol at a 1-based position. */
  async references(filePath: string, line: number, column: number): Promise<LspLocation[]> {
    const result = await this.request<unknown>('textDocument/references', {
      textDocument: { uri: toUri(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
      context: { includeDeclaration: true },
    });
    const list = Array.isArray(result) ? result : [];
    return list.map((item) => {
      const loc = item as { uri?: string; range?: { start?: unknown } };
      const start = toOneBased(loc.range?.start as { line?: number; character?: number });
      return { path: fromUri(loc.uri ?? ''), line: start.line, column: start.column };
    });
  }

  /** Rename the symbol at a position; returns edits across the whole workspace. */
  async rename(filePath: string, line: number, column: number, newName: string): Promise<LspTextEdit[]> {
    const result = await this.request<unknown>('textDocument/rename', {
      textDocument: { uri: toUri(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
      newName,
    });
    return parseWorkspaceEdit(result);
  }

  /** Format an entire document; returns the edits to apply. */
  async formatting(filePath: string, tabSize = 2, insertSpaces = true): Promise<LspTextEdit[]> {
    const result = await this.request<unknown>('textDocument/formatting', {
      textDocument: { uri: toUri(filePath) },
      options: { tabSize, insertSpaces },
    });
    return parseTextEditArray(filePath, result);
  }

  /** List the document's symbols (for an outline / breadcrumbs view). */
  async documentSymbols(filePath: string): Promise<LspSymbol[]> {
    const result = await this.request<unknown>('textDocument/documentSymbol', {
      textDocument: { uri: toUri(filePath) },
    });
    return parseDocumentSymbols(Array.isArray(result) ? result : []);
  }

  /** Signature help (parameter hints) at a 1-based position. */
  async signatureHelp(filePath: string, line: number, column: number): Promise<LspSignature[]> {
    const result = await this.request<unknown>('textDocument/signatureHelp', {
      textDocument: { uri: toUri(filePath) },
      position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
    });
    const payload = result as { signatures?: unknown[]; activeParameter?: number } | null;
    const signatures = Array.isArray(payload?.signatures) ? payload.signatures : [];
    return signatures.map((item) => {
      const s = item as { label?: unknown; parameters?: unknown[] };
      return {
        label: typeof s.label === 'string' ? s.label : '',
        parameters: Array.isArray(s.parameters)
          ? s.parameters.map((p) => {
              const label = (p as { label?: unknown }).label;
              return typeof label === 'string' ? label : '';
            })
          : [],
        activeParameter: typeof payload?.activeParameter === 'number' ? payload.activeParameter : undefined,
      };
    });
  }

  /** Shut the server down gracefully, then kill the process. */
  async dispose(): Promise<void> {
    try {
      if (this.initialized) {
        await this.request('shutdown').catch((): undefined => undefined);
        this.notify('exit');
      }
    } finally {
      this.child?.kill();
      this.child = null;
      this.initialized = false;
      this.initPromise = null;
    }
  }
}

/** Cache key: rootPath + server id. */
const sessionKey = (rootPath: string, serverId: string): string => `${rootPath}::${serverId}`;

/** Live sessions by key. */
const sessions = new Map<string, LspSession>();

/**
 * Get (or create + start) a session for a workspace + server. Ensures the
 * server is installed first; returns `null` when the server cannot be obtained
 * (not installed and needs manual setup).
 */
export const getOrCreateSession = async (
  rootPath: string,
  serverId: string,
  onDiagnostics: DiagnosticsListener
): Promise<LspSession | null> => {
  const key = sessionKey(rootPath, serverId);
  const existing = sessions.get(key);
  if (existing && existing.alive) return existing;

  const outcome = await ensureServerInstalled(serverId);
  if (outcome.status !== 'installed' && outcome.status !== 'already-installed') return null;

  const session = new LspSession(rootPath, outcome.server, onDiagnostics);
  sessions.set(key, session);
  try {
    await session.start();
  } catch {
    sessions.delete(key);
    return null;
  }
  return session;
};

/** Dispose one session (by root + server), if present. */
export const disposeSession = async (rootPath: string, serverId: string): Promise<void> => {
  const key = sessionKey(rootPath, serverId);
  const session = sessions.get(key);
  if (session) {
    sessions.delete(key);
    await session.dispose();
  }
};

/** Dispose every live session (called on app quit). */
export const disposeAllSessions = async (): Promise<void> => {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map((session) => session.dispose()));
};
