/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Monaco ⇄ LSP bridge — wires a live language server (via {@link lspClient}) into
 * a Monaco editor for ONE open file. This is the renderer glue that turns the
 * LSP execution layer into editor features: completion, hover, go-to-definition,
 * and inline diagnostics markers.
 *
 * Used by {@link file://./TextCodeAdapter.tsx} only for languages the Language
 * Engine Registry resolves to a costly `lsp` engine the user opted into (TS/JS
 * keep the zero-process Monaco built-in worker). When the LSP bridge is absent
 * (WebUI mode) or the server is not installed, every call fails soft and the
 * editor keeps working with its free engine.
 *
 * {@link attachLspToModel} registers Monaco providers scoped to the file's
 * language and starts streaming diagnostics; it returns a disposer the adapter
 * calls on unmount / file switch.
 *
 * Renderer-only. No Node.js APIs.
 */

import {
  lspClient,
  type LspCompletion,
  type LspDiagnostic,
  type LspLocation,
  type LspSignature,
  type LspTextEdit,
} from '@renderer/pages/studio/ide/lspClient';

/** Minimal structural types for the Monaco APIs we touch (no static import). */
type Position = { lineNumber: number; column: number };
type MonacoModel = {
  uri: { toString: () => string };
  getValue: () => string;
  getWordUntilPosition: (pos: Position) => { startColumn: number; endColumn: number };
};
type MonacoMarker = {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
};
type MonacoApi = {
  MarkerSeverity: { Error: number; Warning: number; Info: number; Hint: number };
  languages: {
    registerCompletionItemProvider: (lang: string, provider: unknown) => { dispose: () => void };
    registerHoverProvider: (lang: string, provider: unknown) => { dispose: () => void };
    registerDefinitionProvider: (lang: string, provider: unknown) => { dispose: () => void };
    registerReferenceProvider: (lang: string, provider: unknown) => { dispose: () => void };
    registerRenameProvider: (lang: string, provider: unknown) => { dispose: () => void };
    registerDocumentFormattingEditProvider: (lang: string, provider: unknown) => { dispose: () => void };
    registerSignatureHelpProvider: (lang: string, provider: unknown) => { dispose: () => void };
    CompletionItemKind: { Text: number };
  };
  editor: {
    setModelMarkers: (model: MonacoModel, owner: string, markers: MonacoMarker[]) => void;
    getModels: () => MonacoModel[];
  };
  Uri: { file: (path: string) => { toString: () => string } };
};

/** Parameters for {@link attachLspToModel}. */
export type AttachLspParams = {
  monaco: MonacoApi;
  /** Monaco language id (e.g. `python`, `rust`). */
  language: string;
  /** Absolute file path of the open document. */
  filePath: string;
  /** Workspace root the server runs in. */
  rootPath: string;
  /** Catalog server id resolved for this language. */
  serverId: string;
  /** Current document text (synced to the server on attach). */
  getContent: () => string;
};

/** Map an LSP diagnostic severity to a Monaco MarkerSeverity number. */
const toMarkerSeverity = (monaco: MonacoApi, severity: LspDiagnostic['severity']): number => {
  const S = monaco.MarkerSeverity;
  switch (severity) {
    case 'error':
      return S.Error;
    case 'warning':
      return S.Warning;
    case 'info':
      return S.Info;
    default:
      return S.Hint;
  }
};

/**
 * Attach LSP-backed providers + diagnostics to the given language/file. Returns
 * a disposer that unregisters the providers, stops the diagnostics stream, and
 * tells Main to keep the session (the session is shared per root+server and is
 * torn down on app quit, not per file).
 */
export const attachLspToModel = (params: AttachLspParams): (() => void) => {
  const { monaco, language, filePath, rootPath, serverId, getContent } = params;
  const targetUri = monaco.Uri.file(filePath).toString();

  // Initial document sync so the server can produce diagnostics immediately.
  void lspClient.sync(rootPath, serverId, filePath, getContent());

  // Diagnostics → Monaco markers (only for this file's model).
  const unsubscribeDiag = lspClient.onDiagnostics((event) => {
    if (event.filePath !== filePath) return;
    const model = monaco.editor.getModels().find((m) => m.uri.toString() === targetUri);
    if (!model) return;
    const markers = event.diagnostics.map((d) => ({
      severity: toMarkerSeverity(monaco, d.severity),
      message: d.message,
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.endLine,
      endColumn: d.endColumn,
      source: d.source ?? serverId,
    }));
    monaco.editor.setModelMarkers(model, `lsp:${serverId}`, markers);
  });

  const completionProvider = monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems: async (model: MonacoModel, position: Position): Promise<{ suggestions: unknown[] }> => {
      const res = await lspClient
        .completion(rootPath, serverId, filePath, position.lineNumber, position.column)
        .catch((): null => null);
      if (!res || !res.ok) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: res.data.map((item: LspCompletion) => ({
          label: item.label,
          kind: item.kind ?? monaco.languages.CompletionItemKind.Text,
          detail: item.detail,
          insertText: item.insertText ?? item.label,
          range,
        })),
      };
    },
  });

  const hoverProvider = monaco.languages.registerHoverProvider(language, {
    provideHover: async (
      _model: MonacoModel,
      position: Position
    ): Promise<{ contents: { value: string }[] } | null> => {
      const res = await lspClient
        .hover(rootPath, serverId, filePath, position.lineNumber, position.column)
        .catch((): null => null);
      if (!res || !res.ok || !res.data) return null;
      return { contents: [{ value: res.data.contents }] };
    },
  });

  const definitionProvider = monaco.languages.registerDefinitionProvider(language, {
    provideDefinition: async (_model: MonacoModel, position: Position): Promise<unknown[]> => {
      const res = await lspClient
        .definition(rootPath, serverId, filePath, position.lineNumber, position.column)
        .catch((): null => null);
      if (!res || !res.ok) return [];
      return res.data.map((loc: LspLocation) => ({
        uri: monaco.Uri.file(loc.path),
        range: {
          startLineNumber: loc.line,
          startColumn: loc.column,
          endLineNumber: loc.line,
          endColumn: loc.column + 1,
        },
      }));
    },
  });

  const referenceProvider = monaco.languages.registerReferenceProvider(language, {
    provideReferences: async (_model: MonacoModel, position: Position): Promise<unknown[]> => {
      const res = await lspClient
        .references(rootPath, serverId, filePath, position.lineNumber, position.column)
        .catch((): null => null);
      if (!res || !res.ok) return [];
      return res.data.map((loc: LspLocation) => ({
        uri: monaco.Uri.file(loc.path),
        range: {
          startLineNumber: loc.line,
          startColumn: loc.column,
          endLineNumber: loc.line,
          endColumn: loc.column + 1,
        },
      }));
    },
  });

  // Rename (F2): collect edits across the workspace and hand them to Monaco as
  // a WorkspaceEdit. This is the real cross-file rename a coder expects.
  const renameProvider = monaco.languages.registerRenameProvider(language, {
    provideRenameEdits: async (
      _model: MonacoModel,
      position: Position,
      newName: string
    ): Promise<{ edits: unknown[] }> => {
      const res = await lspClient
        .rename(rootPath, serverId, filePath, position.lineNumber, position.column, newName)
        .catch((): null => null);
      if (!res || !res.ok) return { edits: [] };
      return {
        edits: res.data.map((edit: LspTextEdit) => ({
          resource: monaco.Uri.file(edit.path),
          textEdit: {
            range: {
              startLineNumber: edit.startLine,
              startColumn: edit.startColumn,
              endLineNumber: edit.endLine,
              endColumn: edit.endColumn,
            },
            text: edit.newText,
          },
        })),
      };
    },
  });

  // Document formatting (Shift+Alt+F / format-on-save): map LSP TextEdits to
  // Monaco edit operations for the open file.
  const formattingProvider = monaco.languages.registerDocumentFormattingEditProvider(language, {
    provideDocumentFormattingEdits: async (): Promise<unknown[]> => {
      const res = await lspClient.format(rootPath, serverId, filePath).catch((): null => null);
      if (!res || !res.ok) return [];
      return res.data.map((edit: LspTextEdit) => ({
        range: {
          startLineNumber: edit.startLine,
          startColumn: edit.startColumn,
          endLineNumber: edit.endLine,
          endColumn: edit.endColumn,
        },
        text: edit.newText,
      }));
    },
  });

  // Signature help (parameter hints) triggered on `(` and `,`.
  const signatureProvider = monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp: async (
      _model: MonacoModel,
      position: Position
    ): Promise<{ value: unknown; dispose: () => void } | null> => {
      const res = await lspClient
        .signature(rootPath, serverId, filePath, position.lineNumber, position.column)
        .catch((): null => null);
      if (!res || !res.ok || res.data.length === 0) return null;
      return {
        value: {
          signatures: res.data.map((sig: LspSignature) => ({
            label: sig.label,
            parameters: sig.parameters.map((p: string) => ({ label: p })),
          })),
          activeSignature: 0,
          activeParameter: res.data[0]?.activeParameter ?? 0,
        },
        dispose: () => {},
      };
    },
  });

  return () => {
    unsubscribeDiag();
    completionProvider.dispose();
    hoverProvider.dispose();
    definitionProvider.dispose();
    referenceProvider.dispose();
    renameProvider.dispose();
    formattingProvider.dispose();
    signatureProvider.dispose();
  };
};

/** Push a document edit to the server so diagnostics refresh. Fails soft. */
export const syncLspDocument = (rootPath: string, serverId: string, filePath: string, content: string): void => {
  void lspClient.sync(rootPath, serverId, filePath, content).catch((): undefined => undefined);
};
