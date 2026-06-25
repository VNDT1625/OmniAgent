/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `TextCodeAdapter` — Monaco-backed editor for text and code (Yêu cầu 2a,
 * criterion 2.1: "mọi ngôn ngữ lập trình, json/xml/yaml/csv/md/html/ini/log").
 * Also serves as the `RawTextAdapter` fallback (criterion 2.9) when used with the
 * `plaintext` language.
 *
 * Reuses `@monaco-editor/react` (already a project dependency, see HTMLViewer).
 * Renderer-only.
 */

import { Button } from '@arco-design/web-react';
import { Save } from '@icon-park/react';
import MonacoEditor, { type OnMount } from '@monaco-editor/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EditorAdapterProps } from '../adapterRegistry';
import { languageForFile } from './languageMap';
import { configureMonacoTypeScript, isTypeScriptLike } from './monacoTsSetup';
import { resolveEngine, shouldUseMonacoTsWorker } from './languageEngineRegistry';
import { attachLspToModel, syncLspDocument } from './monacoLspProvider';
import { consumeEditorGoto, onEditorGoto } from '../editorGoto';
import { ideClient } from '@renderer/pages/studio/ide/ideClient';
import type { KnowledgeGraph } from '@renderer/pages/studio/ide/ideClient';
import { importSpecifierOnLine, resolveImport, relationsFor } from '@renderer/pages/studio/ide/codeRelations';
import { lspClient } from '@renderer/pages/studio/ide/lspClient';
import { emitter, useAddEventListener } from '@renderer/utils/emitter';

/** The Monaco editor instance type, derived from the addon's onMount signature. */
type MonacoStandaloneEditor = Parameters<OnMount>[0];
/** The Monaco namespace, from the addon's onMount second arg. */
type MonacoApi = Parameters<OnMount>[1];

/** Map a lint severity to a Monaco MarkerSeverity numeric value. */
const markerSeverity = (monaco: MonacoApi, severity: 'error' | 'warning' | 'info'): number => {
  const S = monaco.MarkerSeverity;
  if (severity === 'error') return S.Error;
  if (severity === 'info') return S.Info;
  return S.Warning;
};

/** Resolve the current app theme for Monaco. */
const monacoTheme = (): 'vs-dark' | 'light' =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'vs-dark' : 'light';

/** Repo-relative, forward-slash path of `abs` within `root` (or `abs` when outside). */
const toRelPath = (abs: string, root: string): string => {
  const a = abs.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : a;
};

/**
 * Edit text/code with Monaco. Edits flow back through {@link EditorAdapterProps.onChange};
 * Ctrl/Cmd+S and the toolbar button persist via {@link EditorAdapterProps.onSave}.
 */
const TextCodeAdapter: React.FC<EditorAdapterProps> = ({
  filePath,
  content,
  dirty,
  saving,
  onChange,
  onSave,
  readOnly,
  workspace,
}) => {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<'vs-dark' | 'light'>(monacoTheme);
  const language = languageForFile(filePath);
  const editorRef = useRef<MonacoStandaloneEditor | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const lintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Disposer for an attached LSP session's Monaco providers (if any). */
  const lspDisposeRef = useRef<(() => void) | null>(null);
  /** The LSP server id driving this file, once a session is attached. */
  const lspServerRef = useRef<string | null>(null);
  /** Disposer for the inline (Tab) completion provider. */
  const inlineDisposeRef = useRef<(() => void) | null>(null);
  /** Disposer for the graph-backed import hover provider. */
  const hoverDisposeRef = useRef<(() => void) | null>(null);
  /** Cached knowledge graph for the workspace (powers import hovers). */
  const kgGraphRef = useRef<KnowledgeGraph | null>(null);
  /** Disposer for the impact CodeLens provider. */
  const codeLensDisposeRef = useRef<(() => void) | null>(null);
  /** Fire to ask Monaco to re-query the impact CodeLens. */
  const codeLensRefreshRef = useRef<(() => void) | null>(null);
  /** Debounce timer for the deterministic single-file graph refresh on edit. */
  const kgRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Run oxlint on the current file and paint inline markers in Monaco. */
  const runLint = useCallback((): void => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    if (!ed || !monaco) return;
    const model = ed.getModel();
    if (!model) return;
    void ideClient
      .lintFile(filePath, '')
      .then((res) => {
        // Re-check the model is still the same file (tab may have switched).
        if (!monacoRef.current || ed.getModel() !== model) return;
        if (!res.ok) {
          monaco.editor.setModelMarkers(model, 'oxlint', []);
          return;
        }
        const markers = res.data.map((d) => ({
          severity: markerSeverity(monaco, d.severity),
          message: d.rule ? `${d.message} (${d.rule})` : d.message,
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.line,
          endColumn: d.column + 1,
          source: 'oxlint',
        }));
        monaco.editor.setModelMarkers(model, 'oxlint', markers);
      })
      .catch(() => {
        /* lint unavailable — leave markers untouched */
      });
  }, [filePath]);

  /** Debounced lint trigger (after edits settle). */
  const scheduleLint = useCallback((): void => {
    if (lintTimer.current) clearTimeout(lintTimer.current);
    lintTimer.current = setTimeout(runLint, 700);
  }, [runLint]);

  /** Reveal + place the cursor at a 1-based line/column (clamped to ≥ 1). */
  const revealPosition = useCallback((line?: number, column?: number): void => {
    const ed = editorRef.current;
    if (!ed || !line || line < 1) return;
    const col = column && column >= 1 ? column : 1;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: col });
    ed.focus();
  }, []);

  // Track app theme changes so Monaco follows light/dark.
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(monacoTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // Listen for "reveal this file at line:col" requests (terminal file links).
  useEffect(() => {
    return onEditorGoto((req) => {
      if (req.path !== filePath) return;
      revealPosition(req.line, req.column);
      consumeEditorGoto(filePath);
    });
  }, [filePath, revealPosition]);

  const handleSave = useCallback(() => {
    if (!readOnly && dirty) void onSave();
  }, [readOnly, dirty, onSave]);

  // Keyboard save (Ctrl/Cmd+S) while the editor area is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSave]);

  // Clean up the pending lint timer on unmount.
  useEffect(() => {
    return () => {
      if (lintTimer.current) clearTimeout(lintTimer.current);
    };
  }, []);

  // Tear down any attached LSP providers when the file/component goes away.
  useEffect(() => {
    return () => {
      lspDisposeRef.current?.();
      lspDisposeRef.current = null;
      lspServerRef.current = null;
      inlineDisposeRef.current?.();
      inlineDisposeRef.current = null;
      hoverDisposeRef.current?.();
      hoverDisposeRef.current = null;
      codeLensDisposeRef.current?.();
      codeLensDisposeRef.current = null;
      codeLensRefreshRef.current = null;
      if (kgRefreshTimerRef.current) {
        clearTimeout(kgRefreshTimerRef.current);
        kgRefreshTimerRef.current = null;
      }
    };
  }, [filePath]);

  // Load the workspace's knowledge graph once so import hovers can show the
  // target file's summary + symbols. Best-effort: a repo with no built graph
  // simply yields no enriched hover.
  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    void ideClient
      .kgGet(workspace)
      .then((res) => {
        if (!cancelled && res.ok) {
          kgGraphRef.current = res.data;
          codeLensRefreshRef.current?.();
        }
      })
      .catch(() => {
        /* no graph / bridge unavailable — hovers stay plain */
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  // Refetch the knowledge graph when it changes elsewhere (e.g. the user clicked
  // "Refresh understanding" in the relations rail) so hovers/CodeLens update.
  useAddEventListener(
    'ide.kg.updated',
    (payload) => {
      if (!workspace || payload.rootPath !== workspace) return;
      void ideClient
        .kgGet(workspace)
        .then((res) => {
          if (res.ok) {
            kgGraphRef.current = res.data;
            codeLensRefreshRef.current?.();
          }
        })
        .catch(() => {
          /* best-effort */
        });
    },
    [workspace]
  );

  /**
   * Register Monaco's inline (ghost-text) completion provider for this file:
   * "Tab completion". On a typing pause it sends the code around the cursor to
   * the model (via {@link ideClient.inlineComplete}) and shows the returned
   * snippet as ghost text the user accepts with Tab. Debounced + cancellable so
   * each keystroke supersedes the previous request; fails soft (no suggestion)
   * when no model is configured or the bridge is unavailable (e.g. WebUI).
   */
  const attachInlineCompletion = useCallback(
    (monaco: MonacoApi): void => {
      const provider = monaco.languages.registerInlineCompletionsProvider(language, {
        provideInlineCompletions: async (
          model: { getOffsetAt: (pos: { lineNumber: number; column: number }) => number; getValue: () => string },
          position: { lineNumber: number; column: number },
          _context: unknown,
          token: { isCancellationRequested: boolean }
        ) => {
          if (readOnly) return { items: [] };
          // Debounce: wait out the typing burst; bail if a newer request arrived.
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (token.isCancellationRequested) return { items: [] };
          const offset = model.getOffsetAt(position);
          const full = model.getValue();
          const prefix = full.slice(0, offset);
          const suffix = full.slice(offset);
          if (prefix.trim().length === 0) return { items: [] };
          const res = await ideClient
            .inlineComplete({ prefix, suffix, language, filePath })
            .catch((): null => null);
          if (!res || !res.ok || res.data.length === 0 || token.isCancellationRequested) return { items: [] };
          return {
            items: [
              {
                insertText: res.data,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                },
              },
            ],
          };
        },
        freeInlineCompletions: () => {},
      });
      inlineDisposeRef.current = () => provider.dispose();
    },
    [language, filePath, readOnly]
  );

  /**
   * Graph-backed import hover: hovering an import line shows what that file IS —
   * its one-line summary, its top symbols, and how many files depend on it
   * ("used by N"). Powered by the workspace knowledge graph ({@link kgGraphRef}).
   * IDE workspace only; no graph → no enriched hover (the editor stays normal).
   */
  const attachRelationsHover = useCallback(
    (monaco: MonacoApi): void => {
      if (!workspace) return;
      const root = workspace.replace(/\\/g, '/').replace(/\/+$/, '');
      const abs = filePath.replace(/\\/g, '/');
      const activeRel = abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
      const targetUri = monaco.Uri.file(filePath).toString();
      const provider = monaco.languages.registerHoverProvider(language, {
        provideHover: (
          model: { uri: { toString: () => string }; getLineContent: (lineNumber: number) => string },
          position: { lineNumber: number }
        ) => {
          if (model.uri.toString() !== targetUri) return null;
          const graph = kgGraphRef.current;
          if (!graph) return null;
          const spec = importSpecifierOnLine(model.getLineContent(position.lineNumber));
          if (!spec) return null;
          const knownIds = new Set(graph.nodes.map((n) => n.id));
          const target = resolveImport(activeRel, spec, knownIds);
          if (!target) return null;
          const node = graph.nodes.find((n) => n.id === target);
          if (!node) return null;
          const parts: string[] = [`**${node.label}** · \`${node.id}\``];
          if (node.summary) parts.push(node.summary);
          const syms = node.symbols.slice(0, 8).map((s) => `- \`${s.name}\` _(${s.kind})_`);
          if (syms.length > 0) parts.push(syms.join('\n'));
          parts.push(`_${t('ide.relations.usedBy', { count: node.importedBy })}_`);
          return { contents: [{ value: parts.join('\n\n') }] };
        },
      });
      hoverDisposeRef.current = () => provider.dispose();
    },
    [workspace, filePath, language, t]
  );

  /**
   * Impact CodeLens: a lens at the top of the file showing how many files depend
   * on it ("Editing this affects N files"), clickable to reveal the Related-code
   * rail. Powered by the workspace graph edges ({@link kgGraphRef}). IDE only.
   */
  const attachImpactCodeLens = useCallback(
    (monaco: MonacoApi, revealCommandId: string | null): void => {
      if (!workspace) return;
      const activeRel = toRelPath(filePath, workspace);
      const targetUri = monaco.Uri.file(filePath).toString();
      const changeEmitter = new monaco.Emitter<void>();
      codeLensRefreshRef.current = () => changeEmitter.fire();
      const provider = monaco.languages.registerCodeLensProvider(language, {
        onDidChange: changeEmitter.event,
        provideCodeLenses: (model: { uri: { toString: () => string } }) => {
          const empty = { lenses: [] as never[], dispose: () => {} };
          if (model.uri.toString() !== targetUri) return empty;
          const graph = kgGraphRef.current;
          if (!graph) return empty;
          const used = relationsFor(activeRel, graph.edges).usedBy.length;
          if (used === 0) return empty;
          return {
            lenses: [
              {
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
                command: { id: revealCommandId ?? '', title: t('ide.relations.affects', { count: used }) },
              },
            ],
            dispose: () => {},
          };
        },
      });
      codeLensDisposeRef.current = () => {
        provider.dispose();
        changeEmitter.dispose();
      };
    },
    [workspace, filePath, language, t]
  );

  /**
   * Deterministic single-file graph refresh after an edit settles: re-parses
   * this file's symbols into the persisted graph (no model call) so hovers +
   * relations stay accurate as the single user edits. Debounced; fails soft.
   */
  const scheduleKgRefresh = useCallback((): void => {
    if (!workspace) return;
    const root = workspace;
    if (kgRefreshTimerRef.current) clearTimeout(kgRefreshTimerRef.current);
    kgRefreshTimerRef.current = setTimeout(() => {
      kgRefreshTimerRef.current = null;
      const model = editorRef.current?.getModel();
      if (!model) return;
      const activeRel = toRelPath(filePath, root);
      void ideClient
        .kgRefreshFile(root, activeRel, model.getValue())
        .then((res) => {
          const node = res.ok ? res.data : null;
          const graph = kgGraphRef.current;
          if (!node || !graph) return;
          const idx = graph.nodes.findIndex((n) => n.id === node.id);
          if (idx >= 0) graph.nodes[idx] = node;
          else graph.nodes.push(node);
        })
        .catch(() => {
          /* refresh is best-effort */
        });
    }, 2500);
  }, [workspace, filePath]);

  /**
   * Attach a real language server for this file's language, on by default. Only
   * for an IDE workspace (we have `workspace`/rootPath) and a non-builtin
   * language (TS/JS keep Monaco's zero-process worker). Auto-ensures the server
   * (npm fetch into the app data dir, or adopt a PATH binary) — no manual
   * opt-in. Fails soft: any miss leaves the editor on its free engine.
   */
  const maybeAttachLsp = useCallback(
    (monaco: MonacoApi): void => {
      if (!workspace || isTypeScriptLike(language)) return;
      const root = workspace;
      // Auto-enable: resolve + ready the recommended server for this language
      // (npm fetch into the app data dir, or adopt a PATH binary). No manual
      // opt-in. Fails soft: no server / needs-manual-toolchain leaves the editor
      // on its free engine.
      void lspClient
        .ensure(language)
        .then((res) => {
          if (!res.ok || !res.data) return;
          const serverId = res.data.serverId;
          lspServerRef.current = serverId;
          lspDisposeRef.current = attachLspToModel({
            monaco: monaco as unknown as Parameters<typeof attachLspToModel>[0]['monaco'],
            language,
            filePath,
            rootPath: root,
            serverId,
            getContent: () => editorRef.current?.getModel()?.getValue() ?? content,
          });
        })
        .catch(() => {
          /* LSP bridge unavailable (e.g. WebUI) — keep the free engine */
        });
    },
    [workspace, language, filePath, content]
  );

  return (
    <div className='flex flex-col h-full w-full gap-8px'>
      <div className='flex items-center justify-between'>
        <span className='text-12px text-t-tertiary font-mono'>{language}</span>
        <Button
          type='primary'
          size='small'
          icon={<Save theme='outline' size='14' />}
          loading={saving}
          disabled={readOnly || !dirty}
          onClick={handleSave}
        >
          {t('editor.action.save')}
        </Button>
      </div>
      <div className='flex-1 min-h-0 border border-border-base rd-6px overflow-hidden'>
        <MonacoEditor
          height='100%'
          language={language}
          theme={theme}
          value={content}
          options={{ readOnly, minimap: { enabled: false }, fontSize: 13, wordWrap: 'on', scrollBeyondLastLine: false, inlineSuggest: { enabled: true } }}
          onChange={(value) => {
            onChange(value ?? '');
            scheduleLint();
            scheduleKgRefresh();
            // Push the edit to the language server (if attached) so it refreshes
            // diagnostics for the live buffer. Fails soft when no LSP session.
            if (workspace && lspServerRef.current) {
              syncLspDocument(workspace, lspServerRef.current, filePath, value ?? '');
            }
          }}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;
            // Enable Monaco's bundled TS/JS language service (the "monaco-builtin"
            // engine): inline type/syntax diagnostics, completion, hover. Free,
            // no external process. The Language Engine Registry decides; with no
            // workspace analysis loaded it falls back to the default (TS/JS →
            // monaco-builtin), matching the prior hardcoded behavior.
            const engine = resolveEngine(language, null);
            if (shouldUseMonacoTsWorker(engine) && isTypeScriptLike(language)) {
              configureMonacoTypeScript(monaco as Parameters<typeof configureMonacoTypeScript>[0]);
            }
            // For non-TS/JS languages, try a real language server (opt-in, IDE
            // workspace only). Free engines (syntax highlight) remain the default
            // when no server is installed.
            maybeAttachLsp(monaco);
            // Ghost-text "Tab completion" (model-backed). Works for every file;
            // fails soft when no model is configured.
            attachInlineCompletion(monaco);
            // Graph-backed import hover (summary + symbols + used-by).
            attachRelationsHover(monaco);
            // Impact CodeLens ("editing this affects N files") + reveal command.
            const revealCmdId = editor.addCommand(0, () => {
              emitter.emit('ide.relations.reveal', { filePath });
            });
            attachImpactCodeLens(monaco, revealCmdId ?? null);
            // Initial lint pass once the model is ready.
            scheduleLint();
            // Go-to-definition (F12) / find-references (Shift+F12): resolve the
            // identifier under the cursor via the workspace (which owns rootPath
            // + file opening) over the emitter.
            const emitNav = (mode: 'definition' | 'references'): void => {
              const model = editor.getModel();
              const pos = editor.getPosition();
              if (!model || !pos) return;
              const word = model.getWordAtPosition(pos);
              if (!word) return;
              // When a language server is attached, hand the workspace the LSP
              // context so it resolves type-aware (accurate) instead of grepping.
              const serverId = lspServerRef.current;
              const lsp =
                serverId && workspace
                  ? { serverId, filePath, line: pos.lineNumber, column: word.startColumn }
                  : undefined;
              void import('@renderer/utils/emitter').then(({ emitter }) =>
                emitter.emit('ide.nav.request', { symbol: word.word, mode, lsp })
              );
            };
            editor.addAction({
              id: 'aionui.goToDefinition',
              label: 'Go to Definition',
              keybindings: [monaco.KeyCode.F12],
              contextMenuGroupId: 'navigation',
              contextMenuOrder: 1.1,
              run: () => emitNav('definition'),
            });
            editor.addAction({
              id: 'aionui.findReferences',
              label: 'Find All References',
              keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
              contextMenuGroupId: 'navigation',
              contextMenuOrder: 1.2,
              run: () => emitNav('references'),
            });
            editor.addAction({
              id: 'aionui.runTestAtCursor',
              label: 'Run Test at Cursor',
              keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.F10],
              contextMenuGroupId: 'navigation',
              contextMenuOrder: 1.3,
              run: () => {
                const model = editor.getModel();
                const pos = editor.getPosition();
                if (!model || !pos) return;
                void import('@renderer/utils/emitter').then(({ emitter }) =>
                  emitter.emit('ide.test.runAtCursor', {
                    filePath,
                    content: model.getValue(),
                    line: pos.lineNumber,
                  })
                );
              },
            });
          }}
        />
      </div>
    </div>
  );
};

export default TextCodeAdapter;
