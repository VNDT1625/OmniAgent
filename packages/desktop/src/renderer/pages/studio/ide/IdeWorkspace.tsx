/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `IdeWorkspace` — the unified IDE Studio surface. One picked folder powers four
 * modes, switched from a single left activity bar:
 *
 *  - **Files** — a file tree (left) + the {@link UniversalEditor} (right). Open,
 *    read, and edit any file in the repo. This is the working IDE.
 *  - **Understand** — an interactive knowledge graph ({@link UnderstandPanel}):
 *    a C4-level dependency view that teaches the codebase.
 *  - **Chat** — a multi-tab CLI-agent chat ({@link IdeChatPanel}) that reuses the
 *    MAIN conversation system. Each tab is a real conversation pinned to the open
 *    folder (`extra.workspace = rootPath`), so a CLI agent (Claude Code / Codex /
 *    Gemini …) runs with it as the cwd and can read every subdirectory. Multiple
 *    tabs = multiple agents working the same folder in parallel.
 *  - **Wiki** — DeepWiki-style generated architecture documentation
 *    ({@link WikiPanel}): a structured, navigable wiki with Mermaid diagrams.
 *
 * This merges the former standalone `StudioIde` (file tree + editor) and
 * `RepoIntelView` (graph + explain) into one workspace and adds the Wiki, so
 * "understand the code" is a first-class feature of the IDE rather than a
 * separate screen. The earlier weak in-IDE Ask + Agent panels were removed in
 * favour of the Chat mode's full CLI-agent system. Shared repo state lives in
 * {@link useIdeWorkspace}; the Wiki's generation state lives in {@link useRepoWiki}.
 * Editor instances are kept MOUNTED (hidden when inactive) so an in-progress AI
 * edit keeps running while the user explores other tabs.
 *
 * Renderer-only; all text via i18n; Arco + icon-park + UnoCSS tokens only.
 */

import {
  Button,
  Divider,
  Dropdown,
  Empty,
  Input,
  Menu,
  Message,
  Modal,
  Popconfirm,
  Spin,
  Tooltip,
  Tree,
} from '@arco-design/web-react';
import type { RefInputType } from '@arco-design/web-react/es/Input';
import {
  Book,
  Brain,
  Branch,
  Bug,
  Close,
  Code,
  Copy,
  DataSheet,
  Delete,
  Edit,
  FileAdditionOne,
  FileEditingOne,
  FileCode,
  FolderOpen,
  FolderPlus,
  Left,
  Lightning,
  MessageOne,
  People,
  Puzzle,
  Refresh,
  Search,
  Terminal,
  Play,
  Link,
  Right,
  TreeList,
} from '@icon-park/react';
import { ipcBridge } from '@/common';
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { baseName } from '../studioStorage';
import { useIdeWorkspace, type TreeNode } from './useIdeWorkspace';
import { useRepoWiki } from './useRepoWiki';
import { useRepoChanges } from './useRepoChanges';
import WikiPanel from './components/WikiPanel';
import UnderstandPanel from './components/UnderstandPanel';
import IdeChatPanel from './components/IdeChatPanel';
import IdeHooksPanel from './components/IdeHooksPanel';
import CommandPalette, { type PaletteCommand } from './palette/CommandPalette';
import NavResultsPanel from './components/NavResultsPanel';
import { buildTestCommand } from '@process/ide/testrun/testCommand';
import { terminalClient } from '@renderer/pages/terminal/terminalBridgeClient';
import { useIdeHooks } from './hooks/useIdeHooks';
import { emitter, useAddEventListener } from '@renderer/utils/emitter';
import type { NavHit } from './ideClient';
import DiffReviewPanel from './components/DiffReviewPanel';
import SearchPanel from './components/SearchPanel';
import GitPage from '@renderer/pages/git/GitPage';
import QuickTestPanel from './components/QuickTestPanel';
import DatabasePanel from './db/DatabasePanel';
import SpecManagerPanel from './components/SpecManagerPanel';
import LspServersPanel from './components/LspServersPanel';
import ExpBasePanel from './expbase/ExpBasePanel';
import TeamEditPanel from './teamEdit/TeamEditPanel';
import TeamCollabBar from './teamEdit/TeamCollabBar';
import { useTeamCollab } from './teamEdit/useTeamCollab';
import PeerWorkspace from './teamEdit/PeerWorkspace';
import IdeTerminalPanel from './terminal/IdeTerminalPanel';
import { ideClient } from './ideClient';
import { lspClient } from './lspClient';
import { buildQuickCommands, cwdForNode, parseScripts, sepOf, type QuickCommand } from './quickCommands';
import { relationsFor } from './codeRelations';
import type { RepoGraph } from './ideClient';
import { emitEditorGoto } from '@renderer/pages/editor/editorGoto';

const UniversalEditor = React.lazy(() => import('@renderer/pages/editor/UniversalEditor'));

type IdeWorkspaceProps = {
  onBack: () => void;
};

/** The IDE modes selectable from the activity bar. */
type IdeMode =
  | 'files'
  | 'understand'
  | 'chat'
  | 'wiki'
  | 'search'
  | 'git'
  | 'quicktest'
  | 'database'
  | 'hooks'
  | 'spec'
  | 'lsp'
  | 'expbase'
  | 'team';

const IdeWorkspace: React.FC<IdeWorkspaceProps> = ({ onBack }) => {
  const { t } = useTranslation();
  const ide = useIdeWorkspace();
  const wiki = useRepoWiki();
  const changes = useRepoChanges(ide.rootPath);
  const collab = useTeamCollab(ide.rootPath);
  const [mode, setMode] = useState<IdeMode>('files');
  const [joinCollabOpen, setJoinCollabOpen] = useState(false);

  const [specMounted, setSpecMounted] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  // Command palette (Ctrl/Cmd+P = files, Ctrl/Cmd+Shift+P = commands).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteCommandMode, setPaletteCommandMode] = useState(false);
  // Go-to-definition / find-references results.
  const [navOpen, setNavOpen] = useState(false);
  const [navLoading, setNavLoading] = useState(false);
  const [navMode, setNavMode] = useState<'definition' | 'references'>('definition');
  const [navSymbol, setNavSymbol] = useState('');
  const [navHits, setNavHits] = useState<NavHit[]>([]);

  // Own ONE hooks controller for the whole workspace so file events fire hooks
  // regardless of which mode is open. An askAgent firing switches to Chat mode
  // and drops the prompt into the composer via the emitter.
  const hooksController = useIdeHooks(ide.rootPath, {
    dispatch: true,
    onAskAgent: (prompt, hookName) => {
      if (ide.rootPath) {
        emitter.emit('ide.hook.askAgent', { rootPath: ide.rootPath, prompt, hookName });
      }
      setMode('chat');
    },
  });

  const groupCount = useMemo(() => {
    if (!ide.graph) return 0;
    return new Set(ide.graph.nodes.map((n) => n.group)).size;
  }, [ide.graph]);

  // File list for the @-mention picker (relative paths from the import graph).
  // Falls back to an empty list when the scan has not finished yet.
  const repoFiles = useMemo<string[]>(() => (ide.graph ? ide.graph.nodes.map((n) => n.id) : []), [ide.graph]);

  const openFile = (path: string): void => {
    ide.openFile(path);
    setMode('files');
  };

  // Open a repo-relative path from the palette (resolve against the root).
  const openRelFile = (relPath: string): void => {
    if (!ide.rootPath) return;
    const root = ide.rootPath.replace(/[/\\]+$/, '');
    const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
    const abs = `${root}${sep}${relPath.replace(/\//g, sep)}`;
    openFile(abs);
  };

  // Open an absolute path at a line:col (used by nav results).
  const openFileAt = (absPath: string, line: number, column: number): void => {
    openFile(absPath);
    emitEditorGoto(absPath, line, column);
    setNavOpen(false);
  };

  // Resolve a symbol nav request from the editor (F12 / Shift+F12). A single
  // definition jumps straight there; otherwise the results panel opens.
  useAddEventListener(
    'ide.nav.request',
    (payload) => {
      const root = ide.rootPath;
      if (!root) return;
      setNavMode(payload.mode);
      setNavSymbol(payload.symbol);
      setNavHits([]);
      setNavLoading(true);
      setNavOpen(true);
      // Prefer the attached language server (type-aware, accurate); fall back to
      // the heuristic repo scan when no server is attached or it returns nothing.
      const resolveHits = async (): Promise<NavHit[]> => {
        if (payload.lsp) {
          const { serverId, filePath, line, column } = payload.lsp;
          const lspRes =
            payload.mode === 'definition'
              ? await lspClient.definition(root, serverId, filePath, line, column).catch((): null => null)
              : await lspClient.references(root, serverId, filePath, line, column).catch((): null => null);
          if (lspRes && lspRes.ok && lspRes.data.length > 0) {
            return lspRes.data.map((loc) => ({ path: loc.path, line: loc.line, column: loc.column, text: '' }));
          }
        }
        const res =
          payload.mode === 'definition'
            ? await ideClient.findDefinition(root, payload.symbol)
            : await ideClient.findReferences(root, payload.symbol);
        return res.ok ? res.data : [];
      };
      void resolveHits()
        .then((hits) => {
          if (payload.mode === 'definition' && hits.length === 1) {
            setNavOpen(false);
            openFileAt(hits[0].path, hits[0].line, hits[0].column);
            return;
          }
          setNavHits(hits);
        })
        .catch(() => setNavHits([]))
        .finally(() => setNavLoading(false));
    },
    [ide.rootPath]
  );

  // Run-test-at-cursor (Ctrl/Cmd+F10): build the runner command from the
  // project's package.json + the nearest test name, then send it to a fresh
  // terminal session at the workspace root. Reuses the terminal manager — no
  // bespoke test-runner infra.
  useAddEventListener(
    'ide.test.runAtCursor',
    (payload) => {
      const root = ide.rootPath;
      if (!root) return;
      const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
      const pkgPath = `${root.replace(/[/\\]+$/, '')}${sep}package.json`;
      void (async () => {
        const pkgRes = await ideClient.readFile(pkgPath).catch((): null => null);
        const packageJson = pkgRes && pkgRes.ok ? pkgRes.data : null;
        const built = buildTestCommand({
          filePath: payload.filePath,
          content: payload.content,
          line: payload.line,
          packageJson,
        });
        if (!built.command) {
          Message.warning(t('ide.testrun.unknownRunner'));
          return;
        }
        const created = await terminalClient.create({ options: { cwd: root } }).catch((): null => null);
        if (!created || !created.ok) {
          Message.error(t('ide.testrun.terminalError'));
          return;
        }
        void terminalClient.write({ id: created.data.id, data: `${built.command}\r` }).catch(() => {});
        Message.info(
          built.testName ? t('ide.testrun.runningTest', { name: built.testName }) : t('ide.testrun.runningFile')
        );
      })();
    },
    [ide.rootPath, t]
  );

  // Command-palette commands (Ctrl/Cmd+Shift+P). Localised here; the palette
  // fuzzy-matches their labels.
  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const goto =
      (m: IdeMode): (() => void) =>
      () =>
        setMode(m);
    return [
      { id: 'files', label: t('ide.mode.files'), hint: t('ide.palette.category.go'), run: goto('files') },
      {
        id: 'understand',
        label: t('ide.mode.understand'),
        hint: t('ide.palette.category.go'),
        run: goto('understand'),
      },
      { id: 'chat', label: t('ide.mode.chat'), hint: t('ide.palette.category.go'), run: goto('chat') },
      { id: 'team', label: t('ide.mode.team'), hint: t('ide.palette.category.go'), run: goto('team') },
      { id: 'wiki', label: t('ide.mode.wiki'), hint: t('ide.palette.category.go'), run: goto('wiki') },
      { id: 'search', label: t('ide.mode.search'), hint: t('ide.palette.category.go'), run: goto('search') },
      { id: 'git', label: t('ide.mode.git'), hint: t('ide.palette.category.go'), run: goto('git') },
      { id: 'quicktest', label: t('ide.mode.quicktest'), hint: t('ide.palette.category.go'), run: goto('quicktest') },
      { id: 'database', label: t('ide.mode.database'), hint: t('ide.palette.category.go'), run: goto('database') },
      { id: 'hooks', label: t('ide.mode.hooks'), hint: t('ide.palette.category.go'), run: goto('hooks') },
      { id: 'spec', label: t('ide.mode.spec'), hint: t('ide.palette.category.go'), run: goto('spec') },
      { id: 'lsp', label: t('ide.mode.lsp'), hint: t('ide.palette.category.go'), run: goto('lsp') },
      { id: 'expbase', label: t('ide.mode.expbase'), hint: t('ide.palette.category.go'), run: goto('expbase') },
      {
        id: 'rescan',
        label: t('ide.intel.rescan'),
        hint: t('ide.palette.category.action'),
        run: () => void ide.rescan(),
      },
    ];
  }, [t, ide]);

  // Global shortcut: Ctrl/Cmd+P (files) and Ctrl/Cmd+Shift+P (commands).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        setPaletteCommandMode(e.shiftKey);
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Switching folders discards the current editors. If any have unsaved edits,
  // warn first (those changes will be lost); otherwise switch straight away.
  const requestPickFolder = (): void => {
    if (ide.hasUnsaved) {
      Modal.confirm({
        title: t('ide.workspace.switchFolderTitle'),
        content: t('ide.workspace.unsavedWarning', { count: ide.dirtyFiles.size }),
        okText: t('ide.workspace.switchAnyway'),
        cancelText: t('common.cancel'),
        okButtonProps: { status: 'danger' },
        onOk: () => void ide.pickFolder(),
      });
      return;
    }
    void ide.pickFolder();
  };

  // Close the current folder back to the welcome screen. Warn about unsaved
  // edits first (closing discards their editors).
  const requestCloseFolder = (): void => {
    if (ide.hasUnsaved) {
      Modal.confirm({
        title: t('ide.workspace.closeFolderTitle'),
        content: t('ide.workspace.closeFolderWarning', { count: ide.dirtyFiles.size }),
        okText: t('ide.workspace.closeAnyway'),
        cancelText: t('common.cancel'),
        okButtonProps: { status: 'danger' },
        onOk: () => ide.closeFolder(),
      });
      return;
    }
    ide.closeFolder();
  };

  // Restoring a previously-open folder: show a spinner instead of the empty
  // call-to-action so a returning user isn't told to open a folder again.
  if (ide.restoring && !ide.rootPath) {
    return (
      <div className='size-full flex flex-col min-h-0 bg-1'>
        <Header rootName={null} onBack={onBack} statsLine={null} onPickFolder={requestPickFolder} onRescan={null} />
        <div className='flex-1 flex-center'>
          <Spin tip={t('ide.workspace.restoring')} />
        </div>
      </div>
    );
  }

  // Peer mode: we joined a host's repo without opening a local folder. Render
  // the remote workspace (tree + viewer/editor over `/team/*`).
  if (!ide.rootPath && collab.role === 'peer' && collab.peer) {
    return <PeerWorkspace collab={collab} onBack={onBack} />;
  }

  // No folder yet: an open-folder CTA plus a Join-collab fallback for peers
  // arriving without their own repo (they live entirely off the host's disk).
  if (!ide.rootPath) {
    return (
      <div className='size-full flex flex-col min-h-0 bg-1'>
        <Header rootName={null} onBack={onBack} statsLine={null} onPickFolder={requestPickFolder} onRescan={null} />
        <div className='flex-1 flex-center flex-col gap-16px'>
          <span className='size-64px flex-center rd-18px bg-primary-light-1 text-primary'>
            <Code theme='outline' size={32} />
          </span>
          <p className='m-0 text-16px font-600 text-t-primary'>{t('ide.workspace.welcomeTitle')}</p>
          <p className='m-0 max-w-440px text-13px text-t-secondary leading-relaxed text-center'>
            {t('ide.workspace.welcomeHint')}
          </p>
          <Button type='primary' icon={<FolderOpen theme='outline' size={15} />} onClick={requestPickFolder}>
            {t('ide.intel.openFolder')}
          </Button>
          <Button
            icon={<People theme='outline' size={15} />}
            loading={collab.busy}
            onClick={() => setJoinCollabOpen(true)}
          >
            {t('ide.teamCollab.join')}
          </Button>
          <span className='text-11px text-t-tertiary max-w-440px text-center'>
            {t(
              'ide.teamCollab.joinHint',
              'Tham gia phiên collab của người khác — bạn sẽ làm việc trực tiếp trên repo của họ qua mạng, không cần tải về.'
            )}
          </span>
        </div>
        <JoinCollabModal visible={joinCollabOpen} onClose={() => setJoinCollabOpen(false)} collab={collab} />
      </div>
    );
  }

  const statsLine =
    ide.graph && ide.scanStatus === 'ready' ? (
      <span className='text-12px text-t-tertiary'>
        · {t('ide.intel.stats', { files: ide.graph.fileCount, deps: ide.graph.edges.length, groups: groupCount })}
        {ide.graph.truncated ? ` · ${t('ide.intel.truncated')}` : ''}
      </span>
    ) : null;

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <Header
        rootName={baseName(ide.rootPath)}
        onBack={onBack}
        statsLine={statsLine}
        hasUnsaved={ide.hasUnsaved}
        changeCount={changes.changes.length}
        onReview={() => setDiffOpen(true)}
        onPickFolder={requestPickFolder}
        onCloseFolder={requestCloseFolder}
        onRescan={() => void ide.rescan()}
        rescanning={ide.scanStatus === 'scanning'}
      />

      <div className='flex-1 min-h-0 flex'>
        {/* Activity bar */}
        <nav className='w-60px shrink-0 flex flex-col items-center gap-6px py-12px border-r border-b-1'>
          <ActivityItem
            icon={<Code theme='outline' size={20} />}
            label={t('ide.mode.files')}
            active={mode === 'files'}
            onClick={() => setMode('files')}
          />
          <ActivityItem
            icon={<TreeList theme='outline' size={20} />}
            label={t('ide.mode.understand')}
            active={mode === 'understand'}
            onClick={() => setMode('understand')}
          />
          <ActivityItem
            icon={<MessageOne theme='outline' size={20} />}
            label={t('ide.mode.chat')}
            active={mode === 'chat'}
            onClick={() => setMode('chat')}
          />
          <ActivityItem
            icon={<People theme='outline' size={20} />}
            label={t('ide.mode.team')}
            active={mode === 'team'}
            onClick={() => setMode('team')}
          />
          <ActivityItem
            icon={<Book theme='outline' size={20} />}
            label={t('ide.mode.wiki')}
            active={mode === 'wiki'}
            onClick={() => setMode('wiki')}
          />
          <ActivityItem
            icon={<Search theme='outline' size={20} />}
            label={t('ide.mode.search')}
            active={mode === 'search'}
            onClick={() => setMode('search')}
          />
          <ActivityItem
            icon={<Branch theme='outline' size={20} />}
            label={t('ide.mode.git')}
            active={mode === 'git'}
            onClick={() => setMode('git')}
          />
          <ActivityItem
            icon={<Bug theme='outline' size={20} />}
            label={t('ide.mode.quicktest')}
            active={mode === 'quicktest'}
            onClick={() => setMode('quicktest')}
          />
          <ActivityItem
            icon={<DataSheet theme='outline' size={20} />}
            label={t('ide.mode.database')}
            active={mode === 'database'}
            onClick={() => setMode('database')}
          />
          <ActivityItem
            icon={<Lightning theme='outline' size={20} />}
            label={t('ide.mode.hooks')}
            active={mode === 'hooks'}
            onClick={() => setMode('hooks')}
          />
          <ActivityItem
            icon={<FileCode theme='outline' size={20} />}
            label={t('ide.mode.spec')}
            active={mode === 'spec'}
            onClick={() => {
              setSpecMounted(true);
              setMode('spec');
            }}
          />
          <ActivityItem
            icon={<Puzzle theme='outline' size={20} />}
            label={t('ide.mode.lsp')}
            active={mode === 'lsp'}
            onClick={() => setMode('lsp')}
          />
          <ActivityItem
            icon={<Brain theme='outline' size={20} />}
            label={t('ide.mode.expbase')}
            active={mode === 'expbase'}
            onClick={() => setMode('expbase')}
          />
        </nav>

        {/* Mode body. Files keeps editors mounted; others render on demand. */}
        <div className='flex-1 min-w-0 min-h-0 relative'>
          <div className='absolute inset-0 flex' style={{ display: mode === 'files' ? 'flex' : 'none' }}>
            <FilesPane ide={ide} onOpenFile={openFile} />
          </div>

          {mode === 'understand' ? (
            <div className='absolute inset-0'>
              <UnderstandPanel rootPath={ide.rootPath} />
            </div>
          ) : null}

          {mode === 'chat' ? (
            <div className='absolute inset-0'>
              <IdeChatPanel rootPath={ide.rootPath} activeFile={ide.activeFile} repoFiles={repoFiles} />
            </div>
          ) : null}

          {mode === 'team' ? (
            <div className='absolute inset-0 flex flex-col min-h-0'>
              <TeamCollabBar hasFolder={!!ide.rootPath} collab={collab} />
              <div className='flex-1 min-h-0'>
                <TeamEditPanel rootPath={ide.rootPath} activeFile={ide.activeFile} collab={collab} />
              </div>
            </div>
          ) : null}

          {mode === 'wiki' ? (
            <div className='absolute inset-0'>
              <WikiPanel rootPath={ide.rootPath} wiki={wiki} />
            </div>
          ) : null}

          {mode === 'search' ? (
            <div className='absolute inset-0'>
              <SearchPanel rootPath={ide.rootPath} onOpenFile={openFile} />
            </div>
          ) : null}

          {mode === 'git' ? (
            <div className='absolute inset-0'>
              <GitPage />
            </div>
          ) : null}

          {mode === 'quicktest' ? (
            <div className='absolute inset-0'>
              <QuickTestPanel
                rootPath={ide.rootPath}
                onFixWithAgent={(pack, errorSummary, hasError) => {
                  const root = ide.rootPath;
                  if (!root) return;
                  // Switch to Chat FIRST so IdeChatPanel is mounted and listening
                  // for `ide.hook.askAgent` (it opens a tab + fills the composer).
                  setMode('chat');
                  // Build the agent prompt from the trace context pack: the
                  // rendered brief already lists the interaction path, any error,
                  // the code that actually ran (V8 coverage), and the suspected
                  // files. The framing adapts to whether a runtime error was
                  // actually captured — we must NOT tell the agent to "fix a
                  // problem" when the trace is clean (that contradicts the trace
                  // and sends the agent chasing a non-existent bug).
                  const intro = hasError
                    ? [
                        `Quick Test caught a problem while I was testing the app: ${errorSummary}`,
                        '',
                        'Here is the runtime trace captured from the live app. Use it to find and fix the root cause, then explain the fix.',
                      ]
                    : [
                        'I recorded a Quick Test session of the live app. No runtime error was captured — the trace below shows the interaction path I took.',
                        '',
                        'Review the trace and the relevant code: confirm the flows I exercised behave correctly, and flag any latent issues (missing handlers, dead ends, accessibility or state bugs). Do not invent an error that is not there.',
                      ];
                  const prompt = [...intro, '', pack.renderedContext].join('\n');
                  // Defer so the Chat panel has mounted and registered its
                  // `ide.hook.askAgent` listener before the event fires (the
                  // mode switch triggers an async re-render + effect setup).
                  setTimeout(() => {
                    emitter.emit('ide.hook.askAgent', { rootPath: root, prompt, hookName: 'Quick Test' });
                  }, 250);
                }}
                onAskAboutElement={(prompt) => {
                  const root = ide.rootPath;
                  if (!root) return;
                  // Inspect → design/change request. The brief (renderElementBrief)
                  // already carries the picked element's component, file:line, box
                  // and styles + the user's request, so it is sent verbatim to a
                  // new Chat tab via the same askAgent event the trace flow uses.
                  setMode('chat');
                  setTimeout(() => {
                    emitter.emit('ide.hook.askAgent', { rootPath: root, prompt, hookName: 'Inspect Element' });
                  }, 250);
                }}
              />
            </div>
          ) : null}

          {mode === 'database' ? (
            <div className='absolute inset-0'>
              <DatabasePanel rootPath={ide.rootPath} />
            </div>
          ) : null}

          {mode === 'hooks' ? (
            <div className='absolute inset-0'>
              <IdeHooksPanel rootPath={ide.rootPath} controller={hooksController} />
            </div>
          ) : null}

          {specMounted ? (
            <div className='absolute inset-0' style={{ display: mode === 'spec' ? 'block' : 'none' }}>
              <SpecManagerPanel rootPath={ide.rootPath} />
            </div>
          ) : null}

          {mode === 'lsp' ? (
            <div className='absolute inset-0'>
              <LspServersPanel rootPath={ide.rootPath} />
            </div>
          ) : null}

          {mode === 'expbase' ? (
            <div className='absolute inset-0'>
              <ExpBasePanel rootPath={ide.rootPath} />
            </div>
          ) : null}
        </div>
      </div>

      <IdeTerminalPanel
        defaultCwd={ide.rootPath}
        onOpenPath={(path, line, column) => {
          // Resolve a terminal file link against the open folder when relative,
          // open it in the editor, then ask the Monaco adapter to reveal the
          // line:col (the editor for this path listens via editorGoto).
          const root = ide.rootPath;
          const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
          const abs =
            !isAbsolute && root
              ? `${root.replace(/[/\\]+$/, '')}${root.includes('\\') && !root.includes('/') ? '\\' : '/'}${path.replace(/^[/\\]+/, '')}`
              : path;
          openFile(abs);
          if (line) emitEditorGoto(abs, line, column);
        }}
      />

      <DiffReviewPanel
        rootPath={ide.rootPath}
        changes={changes.changes}
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        onChanged={() => void changes.refresh()}
        onOpenFile={openFile}
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        files={repoFiles}
        onOpenFile={openRelFile}
        commands={paletteCommands}
        initialCommandMode={paletteCommandMode}
      />

      <NavResultsPanel
        open={navOpen}
        loading={navLoading}
        mode={navMode}
        symbol={navSymbol}
        rootPath={ide.rootPath}
        hits={navHits}
        onClose={() => setNavOpen(false)}
        onOpen={openFileAt}
      />
    </div>
  );
};

/** Shared header: back, repo name, scan stats, open-folder + rescan. */
const Header: React.FC<{
  rootName: string | null;
  statsLine: React.ReactNode;
  rescanning?: boolean;
  hasUnsaved?: boolean;
  changeCount?: number;
  onReview?: () => void;
  onBack: () => void;
  onPickFolder: () => void;
  onCloseFolder?: () => void;
  onRescan: (() => void) | null;
}> = ({
  rootName,
  statsLine,
  rescanning,
  hasUnsaved,
  changeCount,
  onReview,
  onBack,
  onPickFolder,
  onCloseFolder,
  onRescan,
}) => {
  const { t } = useTranslation();
  return (
    <header className='shrink-0 flex items-center gap-12px px-16px h-52px border-b border-b-1'>
      <Button type='text' icon={<Left theme='outline' size={18} />} className='!text-t-secondary' onClick={onBack}>
        {t('studio.action.back')}
      </Button>
      <span className='flex items-center gap-8px'>
        <Code theme='outline' size={18} className='text-primary' />
        <span className='text-14px font-[500] text-t-primary truncate'>{rootName ?? t('studio.ide')}</span>
        {hasUnsaved ? (
          <span
            className='size-7px rd-full bg-warning'
            title={t('ide.workspace.unsavedDot')}
            aria-label={t('ide.workspace.unsavedDot')}
          />
        ) : null}
      </span>
      {statsLine}
      <div className='flex-1' />
      {onReview && changeCount && changeCount > 0 ? (
        <Tooltip content={t('ide.diff.reviewHint')} position='br'>
          <Button
            type='primary'
            size='small'
            status='warning'
            icon={<FileEditingOne theme='outline' size={15} />}
            onClick={onReview}
          >
            {t('ide.diff.reviewBtn', { count: changeCount })}
          </Button>
        </Tooltip>
      ) : null}
      {onRescan ? (
        <Button
          type='text'
          size='small'
          icon={<Refresh theme='outline' size={15} />}
          loading={rescanning}
          onClick={onRescan}
        >
          {t('ide.intel.rescan')}
        </Button>
      ) : null}
      <Tooltip content={t('ide.workspace.openOtherFolderHint')} position='br'>
        <Button type='outline' size='small' icon={<FolderOpen theme='outline' size={15} />} onClick={onPickFolder}>
          {t('ide.workspace.openOtherFolder')}
        </Button>
      </Tooltip>
      {onCloseFolder ? (
        <Tooltip content={t('ide.workspace.closeFolderHint')} position='br'>
          <Button
            type='text'
            size='small'
            className='!text-t-secondary'
            icon={<Close theme='outline' size={15} />}
            onClick={onCloseFolder}
          >
            {t('ide.workspace.closeFolder')}
          </Button>
        </Tooltip>
      ) : null}
    </header>
  );
};

/** One activity-bar button. */
const ActivityItem: React.FC<{ icon: React.ReactNode; label: string; active: boolean; onClick: () => void }> = ({
  icon,
  label,
  active,
  onClick,
}) => (
  <Tooltip content={label} position='right'>
    <button
      type='button'
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`size-44px rd-10px flex-center cursor-pointer border-none transition-colors ${active ? 'bg-primary-light-1 text-primary' : 'bg-transparent text-t-secondary hover:bg-fill-2'}`}
    >
      {icon}
    </button>
  </Tooltip>
);

type FilesPaneProps = {
  ide: ReturnType<typeof useIdeWorkspace>;
  onOpenFile: (path: string) => void;
};

/** Skip the expensive file tree/editor reconciliation when only the active IDE mode changed. */
const filesPanePropsEqual = (previous: FilesPaneProps, next: FilesPaneProps): boolean =>
  previous.ide.rootPath === next.ide.rootPath &&
  previous.ide.tree === next.ide.tree &&
  previous.ide.treeLoading === next.ide.treeLoading &&
  previous.ide.activeFile === next.ide.activeFile &&
  previous.ide.openFiles === next.ide.openFiles &&
  previous.ide.dirtyFiles === next.ide.dirtyFiles &&
  previous.ide.editorFs === next.ide.editorFs &&
  previous.ide.graph === next.ide.graph &&
  previous.ide.loadDir === next.ide.loadDir &&
  previous.ide.closeFile === next.ide.closeFile &&
  previous.ide.markDirty === next.ide.markDirty &&
  previous.ide.refreshTree === next.ide.refreshTree;

/** Files mode: tree + kept-alive editors. */
const FilesPane: React.FC<FilesPaneProps> = React.memo(({ ide, onOpenFile }) => {
  const { t } = useTranslation();

  // Context menu state: which node was right-clicked
  const [ctxNode, setCtxNode] = useState<TreeNode | null>(null);
  const [ctxVisible, setCtxVisible] = useState(false);

  // New File dialog
  const [newFileVisible, setNewFileVisible] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [newFileLoading, setNewFileLoading] = useState(false);

  // New Folder dialog
  const [newFolderVisible, setNewFolderVisible] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFolderLoading, setNewFolderLoading] = useState(false);

  // Rename dialog
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameName, setRenameName] = useState('');
  const [renameLoading, setRenameLoading] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState<TreeNode | null>(null);

  // Quick "run in terminal" context: npm scripts found near the right-clicked
  // node + the dir they should run in. Loaded async when the menu opens.
  const [quickScripts, setQuickScripts] = useState<string[]>([]);
  const [quickScriptsCwd, setQuickScriptsCwd] = useState<string | null>(null);

  // Related-code rail visibility (graph-backed depends-on / used-by).
  const [relationsOpen, setRelationsOpen] = useState(true);
  useAddEventListener('ide.relations.reveal', () => setRelationsOpen(true), []);

  // On-demand LLM re-summary of the active file ("Refresh understanding").
  const [refreshingKg, setRefreshingKg] = useState(false);
  const handleRefreshUnderstanding = async (): Promise<void> => {
    const root = ide.rootPath;
    const active = ide.activeFile;
    if (!root || !active) return;
    setRefreshingKg(true);
    try {
      const rel = active.startsWith(root)
        ? active
            .slice(root.length)
            .replace(/^[/\\]/, '')
            .replace(/\\/g, '/')
        : active;
      const fileRes = await ideClient.readFile(active).catch((): null => null);
      const content = fileRes && fileRes.ok ? fileRes.data : '';
      const res = await ideClient.kgRefreshFile(root, rel, content, { summarize: true }).catch((): null => null);
      if (res && res.ok && res.data) {
        emitter.emit('ide.kg.updated', { rootPath: root });
        Message.success(t('ide.relations.refreshed'));
      } else {
        Message.warning(t('ide.relations.refreshFailed'));
      }
    } finally {
      setRefreshingKg(false);
    }
  };

  const newFileInputRef = useRef<RefInputType>(null);
  const newFolderInputRef = useRef<RefInputType>(null);
  const renameInputRef = useRef<RefInputType>(null);

  /** Derive the parent directory of a node (for creating siblings). */
  const parentDir = (node: TreeNode): string => {
    const p = node.key;
    // If it's a directory, create inside it; if it's a file, create alongside it.
    if (!node.isLeaf) return p;
    const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
    return p.substring(0, p.lastIndexOf(sep));
  };

  /** Relative path from rootPath for display. */
  const relativePath = (absPath: string): string => {
    if (!ide.rootPath) return absPath;
    const rel = absPath.startsWith(ide.rootPath) ? absPath.slice(ide.rootPath.length) : absPath;
    return rel.replace(/^[/\\]/, '');
  };

  const joinPath = (dir: string, name: string): string => {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
    return `${dir.replace(/[/\\]+$/, '')}${sep}${name}`;
  };

  // ── Context menu actions ──────────────────────────────────────────────────

  const handleNewFile = async (): Promise<void> => {
    if (!ctxNode || !newFileName.trim()) return;
    setNewFileLoading(true);
    try {
      const dir = parentDir(ctxNode);
      const filePath = joinPath(dir, newFileName.trim());
      const result = await ideClient.writeFile(filePath, '');
      if (!result.ok) {
        Message.error('error' in result ? result.error : t('common.unknownError'));
        return;
      }
      await ide.refreshTree();
      Message.success(t('ide.contextMenu.create'));
      setNewFileVisible(false);
      setNewFileName('');
    } catch (error) {
      Message.error(error instanceof Error ? error.message : t('common.unknownError'));
    } finally {
      setNewFileLoading(false);
    }
  };

  const handleNewFolder = async (): Promise<void> => {
    if (!ctxNode || !newFolderName.trim()) return;
    setNewFolderLoading(true);
    try {
      const dir = parentDir(ctxNode);
      const folderPath = joinPath(dir, newFolderName.trim());
      const result = await ideClient.createDir(folderPath);
      if (!result.ok) {
        Message.error('error' in result ? result.error : t('common.unknownError'));
        return;
      }
      await ide.refreshTree();
      Message.success(t('ide.contextMenu.create'));
      setNewFolderVisible(false);
      setNewFolderName('');
    } catch (error) {
      Message.error(error instanceof Error ? error.message : t('common.unknownError'));
    } finally {
      setNewFolderLoading(false);
    }
  };

  const handleRename = async (): Promise<void> => {
    if (!ctxNode || !renameName.trim()) return;
    setRenameLoading(true);
    try {
      const oldPath = ctxNode.key;
      const sep = oldPath.includes('\\') && !oldPath.includes('/') ? '\\' : '/';
      const parentPath = oldPath.substring(0, oldPath.lastIndexOf(sep));
      const newPath = joinPath(parentPath, renameName.trim());
      const result = await ideClient.renameFile(oldPath, newPath);
      if (!result.ok) {
        Message.error('error' in result ? result.error : t('common.unknownError'));
        return;
      }
      // If the renamed file was open, close it (path is now stale)
      if (ide.openFiles.includes(oldPath)) ide.closeFile(oldPath);
      await ide.refreshTree();
      Message.success(t('ide.contextMenu.rename_action'));
      setRenameVisible(false);
      setRenameName('');
    } catch (error) {
      Message.error(error instanceof Error ? error.message : t('common.unknownError'));
    } finally {
      setRenameLoading(false);
    }
  };

  const handleDelete = async (node: TreeNode): Promise<void> => {
    try {
      const result = await ideClient.deleteFile(node.key);
      if (!result.ok) {
        Message.error('error' in result ? result.error : t('common.unknownError'));
        return;
      }
      if (ide.openFiles.includes(node.key)) ide.closeFile(node.key);
      await ide.refreshTree();
    } catch (error) {
      Message.error(error instanceof Error ? error.message : t('common.unknownError'));
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleCopyPath = (node: TreeNode): void => {
    void navigator.clipboard.writeText(node.key).then(() => {
      Message.success(t('ide.contextMenu.copied'));
    });
  };

  const handleCopyRelativePath = (node: TreeNode): void => {
    void navigator.clipboard.writeText(relativePath(node.key)).then(() => {
      Message.success(t('ide.contextMenu.copied'));
    });
  };

  const handleRevealInExplorer = async (node: TreeNode): Promise<void> => {
    try {
      await ipcBridge.shell.showItemInFolder.invoke(node.key);
    } catch (error) {
      Message.error(error instanceof Error ? error.message : t('common.unknownError'));
    }
  };

  // Load npm scripts from the nearest package.json (the node's dir, else the
  // repo root) so the "Run in terminal" submenu can offer `npm run <script>`.
  const loadQuickContext = async (node: TreeNode): Promise<void> => {
    setQuickScripts([]);
    setQuickScriptsCwd(null);
    const root = ide.rootPath;
    if (!root) return;
    const sep = sepOf(node.key);
    const cwd = cwdForNode(node.key, !node.isLeaf);
    const tryRead = async (dir: string): Promise<boolean> => {
      const res = await ideClient.readFile(`${dir}${sep}package.json`).catch((): null => null);
      if (!res || !res.ok) return false;
      const scripts = parseScripts(res.data);
      if (scripts.length === 0) return false;
      setQuickScripts(scripts);
      setQuickScriptsCwd(dir);
      return true;
    };
    if (await tryRead(cwd)) return;
    if (cwd !== root) await tryRead(root);
  };

  // Commands offered in the "Run in terminal" submenu for the current node.
  const quickCommands = useMemo<QuickCommand[]>(() => {
    if (!ctxNode || !ide.rootPath) return [];
    return buildQuickCommands({
      path: ctxNode.key,
      isDir: !ctxNode.isLeaf,
      rootPath: ide.rootPath,
      scripts: quickScripts,
      scriptsCwd: quickScriptsCwd ?? undefined,
    });
  }, [ctxNode, ide.rootPath, quickScripts, quickScriptsCwd]);

  const contextMenuDroplist = ctxNode ? (
    <Menu
      className='min-w-180px'
      onClickMenuItem={(key) => {
        setCtxVisible(false);
        if (!ctxNode) return;
        if (key === 'openTerminalHere') {
          emitter.emit('ide.terminal.run', { command: '', cwd: cwdForNode(ctxNode.key, !ctxNode.isLeaf) });
          return;
        }
        if (key.startsWith('run:')) {
          const cmd = quickCommands.find((c) => `run:${c.id}` === key);
          if (cmd) emitter.emit('ide.terminal.run', { command: cmd.command, cwd: cmd.cwd });
          return;
        }
        switch (key) {
          case 'newFile':
            setNewFileName('');
            setNewFileVisible(true);
            break;
          case 'newFolder':
            setNewFolderName('');
            setNewFolderVisible(true);
            break;
          case 'rename':
            setRenameName(baseName(ctxNode.key));
            setRenameVisible(true);
            break;
          case 'delete':
            setDeleteTarget(ctxNode);
            break;
          case 'copyPath':
            handleCopyPath(ctxNode);
            break;
          case 'copyRelativePath':
            handleCopyRelativePath(ctxNode);
            break;
          case 'revealInExplorer':
            void handleRevealInExplorer(ctxNode);
            break;
        }
      }}
    >
      <Menu.Item key='newFile'>
        <span className='flex items-center gap-8px'>
          <FileAdditionOne theme='outline' size={14} />
          {t('ide.contextMenu.newFile')}
        </span>
      </Menu.Item>
      <Menu.Item key='newFolder'>
        <span className='flex items-center gap-8px'>
          <FolderPlus theme='outline' size={14} />
          {t('ide.contextMenu.newFolder')}
        </span>
      </Menu.Item>
      <Divider style={{ margin: '4px 0' }} />
      <Menu.Item key='rename'>
        <span className='flex items-center gap-8px'>
          <Edit theme='outline' size={14} />
          {t('ide.contextMenu.rename')}
        </span>
      </Menu.Item>
      <Menu.Item key='delete'>
        <span className='flex items-center gap-8px text-danger'>
          <Delete theme='outline' size={14} />
          {t('ide.contextMenu.delete')}
        </span>
      </Menu.Item>
      <Divider style={{ margin: '4px 0' }} />
      <Menu.Item key='copyPath'>
        <span className='flex items-center gap-8px'>
          <Copy theme='outline' size={14} />
          {t('ide.contextMenu.copyPath')}
        </span>
      </Menu.Item>
      <Menu.Item key='copyRelativePath'>
        <span className='flex items-center gap-8px'>
          <Copy theme='outline' size={14} />
          {t('ide.contextMenu.copyRelativePath')}
        </span>
      </Menu.Item>
      <Divider style={{ margin: '4px 0' }} />
      <Menu.SubMenu
        key='run'
        title={
          <span className='flex items-center gap-8px'>
            <Terminal theme='outline' size={14} />
            {t('ide.contextMenu.runInTerminal')}
          </span>
        }
      >
        <Menu.Item key='openTerminalHere'>
          <span className='flex items-center gap-8px'>
            <Terminal theme='outline' size={14} />
            {t('ide.contextMenu.openTerminalHere')}
          </span>
        </Menu.Item>
        <Divider style={{ margin: '4px 0' }} />
        {quickCommands.length === 0 ? (
          <Menu.Item key='runNoCommands' disabled>
            <span className='text-12px text-t-tertiary'>{t('ide.contextMenu.runNoCommands')}</span>
          </Menu.Item>
        ) : (
          quickCommands.map((cmd) => (
            <Menu.Item key={`run:${cmd.id}`}>
              <span className='flex items-center gap-8px'>
                <Play theme='outline' size={14} />
                <span className='font-mono text-12px truncate'>{cmd.label}</span>
              </span>
            </Menu.Item>
          ))
        )}
      </Menu.SubMenu>
      <Divider style={{ margin: '4px 0' }} />
      <Menu.Item key='revealInExplorer'>
        <span className='flex items-center gap-8px'>
          <FolderOpen theme='outline' size={14} />
          {t('ide.contextMenu.revealInExplorer')}
        </span>
      </Menu.Item>
    </Menu>
  ) : (
    <span />
  );

  return (
    <>
      <aside className='w-260px shrink-0 min-h-0 overflow-auto border-r border-b-1 p-8px'>
        {ide.treeLoading ? (
          <div className='flex-center h-full'>
            <Spin />
          </div>
        ) : ide.tree.length === 0 ? (
          <div className='flex-center h-full px-12px'>
            <Empty description={t('studio.ideMenu.empty')} />
          </div>
        ) : (
          <Dropdown
            trigger={['contextMenu']}
            droplist={contextMenuDroplist}
            popupVisible={ctxVisible}
            onVisibleChange={(v) => {
              if (!v) setCtxVisible(false);
            }}
          >
            <div
              onContextMenu={(e) => {
                // Find the closest tree-node element and extract its data-key
                const nodeEl = (e.target as HTMLElement).closest('[data-key]') as HTMLElement | null;
                if (!nodeEl) return;
                const key = nodeEl.getAttribute('data-key');
                if (!key) return;
                // Walk the tree to find the matching TreeNode
                const findNode = (nodes: typeof ide.tree): (typeof ide.tree)[0] | null => {
                  for (const n of nodes) {
                    if (n.key === key) return n;
                    if (n.children) {
                      const found = findNode(n.children);
                      if (found) return found;
                    }
                  }
                  return null;
                };
                const found = findNode(ide.tree);
                if (found) {
                  setCtxNode(found);
                  setCtxVisible(true);
                  void loadQuickContext(found);
                }
              }}
            >
              <Tree
                blockNode
                treeData={ide.tree}
                selectedKeys={ide.activeFile ? [ide.activeFile] : []}
                loadMore={(node) => {
                  const ref = (node as unknown as { props?: { dataRef?: TreeNode } }).props?.dataRef;
                  if (ref && !ref.isLeaf) return ide.loadDir(ref.key);
                  return Promise.resolve();
                }}
                onSelect={(keys, extra) => {
                  const node = extra.node as unknown as { props?: { dataRef?: { isLeaf?: boolean } } };
                  const ref = node.props?.dataRef;
                  if (ref?.isLeaf && typeof keys[0] === 'string') onOpenFile(keys[0]);
                }}
              />
            </div>
          </Dropdown>
        )}
      </aside>

      {/* New File Modal */}
      <Modal
        title={t('ide.contextMenu.newFile')}
        visible={newFileVisible}
        onOk={() => void handleNewFile()}
        onCancel={() => {
          setNewFileVisible(false);
          setNewFileName('');
        }}
        okText={t('ide.contextMenu.create')}
        cancelText={t('common.cancel')}
        confirmLoading={newFileLoading}
        afterOpen={() => newFileInputRef.current?.focus()}
      >
        <Input
          ref={newFileInputRef}
          placeholder={t('ide.contextMenu.fileNamePlaceholder')}
          value={newFileName}
          onChange={setNewFileName}
          onPressEnter={() => void handleNewFile()}
        />
      </Modal>

      {/* New Folder Modal */}
      <Modal
        title={t('ide.contextMenu.newFolder')}
        visible={newFolderVisible}
        onOk={() => void handleNewFolder()}
        onCancel={() => {
          setNewFolderVisible(false);
          setNewFolderName('');
        }}
        okText={t('ide.contextMenu.create')}
        cancelText={t('common.cancel')}
        confirmLoading={newFolderLoading}
        afterOpen={() => newFolderInputRef.current?.focus()}
      >
        <Input
          ref={newFolderInputRef}
          placeholder={t('ide.contextMenu.folderNamePlaceholder')}
          value={newFolderName}
          onChange={setNewFolderName}
          onPressEnter={() => void handleNewFolder()}
        />
      </Modal>

      {/* Rename Modal */}
      <Modal
        title={t('ide.contextMenu.rename')}
        visible={renameVisible}
        onOk={() => void handleRename()}
        onCancel={() => {
          setRenameVisible(false);
          setRenameName('');
        }}
        okText={t('ide.contextMenu.rename_action')}
        cancelText={t('common.cancel')}
        confirmLoading={renameLoading}
        afterOpen={() => renameInputRef.current?.focus()}
      >
        <Input
          ref={renameInputRef}
          value={renameName}
          onChange={setRenameName}
          onPressEnter={() => void handleRename()}
        />
      </Modal>

      {/* Delete Popconfirm — rendered as a hidden trigger that fires programmatically */}
      {deleteTarget ? (
        <Popconfirm
          title={t('ide.contextMenu.deleteConfirm')}
          onOk={() => void handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
          okText={t('ide.contextMenu.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ status: 'danger' }}
          popupVisible
        >
          <span style={{ display: 'none' }} />
        </Popconfirm>
      ) : null}

      <main className='flex-1 min-w-0 min-h-0 flex flex-col'>
        {ide.openFiles.length === 0 ? (
          <div className='flex-center h-full'>
            <Empty description={t('studio.ideMenu.pickFile')} />
          </div>
        ) : (
          <>
            <EditorTabs
              openFiles={ide.openFiles}
              activeFile={ide.activeFile}
              dirtyFiles={ide.dirtyFiles}
              onSelect={onOpenFile}
              onClose={ide.closeFile}
            />
            <div className='flex-1 min-h-0 relative'>
              {ide.openFiles.map((filePath) => (
                <div
                  key={filePath}
                  className='absolute inset-0 p-16px'
                  style={{ display: ide.activeFile === filePath ? 'block' : 'none' }}
                >
                  <Suspense fallback={<Spin className='flex-center size-full' />}>
                    <UniversalEditor
                      filePath={filePath}
                      workspace={ide.rootPath ?? undefined}
                      fsOverride={ide.editorFs}
                      autoSaveDelayMs={1000}
                      onSaved={(savedPath) => void ide.refreshAfterSave(savedPath)}
                      onDirtyChange={(dirty) => ide.markDirty(filePath, dirty)}
                    />
                  </Suspense>
                </div>
              ))}
            </div>
          </>
        )}
      </main>

      {ide.openFiles.length > 0 ? (
        relationsOpen ? (
          <RelationsRail
            rootPath={ide.rootPath ?? ''}
            activeFile={ide.activeFile}
            graph={ide.graph}
            onOpenFile={onOpenFile}
            onClose={() => setRelationsOpen(false)}
            onRefresh={() => void handleRefreshUnderstanding()}
            refreshing={refreshingKg}
          />
        ) : (
          <Tooltip content={t('ide.relations.show')} position='left'>
            <button
              type='button'
              aria-label={t('ide.relations.show')}
              onClick={() => setRelationsOpen(true)}
              className='w-28px shrink-0 flex flex-col items-center pt-12px border-l border-b-1 cursor-pointer bg-transparent text-t-secondary hover:bg-fill-2 hover:text-t-primary transition-colors'
            >
              <Link theme='outline' size={16} />
            </button>
          </Tooltip>
        )
      ) : null}
    </>
  );
}, filesPanePropsEqual);

/** Build an absolute path from a repo-relative path using the root's separator. */
const absFromRel = (root: string, rel: string): string => {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[/\\]+$/, '')}${sep}${rel.replace(/\//g, sep)}`;
};

/** Repo-relative, forward-slash path of an absolute file within `root`. */
const relWithinRoot = (abs: string, root: string): string => {
  const a = abs.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return a.startsWith(`${r}/`) ? a.slice(r.length + 1) : a;
};

/**
 * Related-code rail: graph-backed "Used by" (who imports this file → what an
 * edit here may affect) and "Depends on" (what this file imports) for the active
 * file. Driven by the auto-refreshed import graph so it stays accurate as the
 * single user edits. Clicking an entry opens that file.
 */
const RelationsRail: React.FC<{
  rootPath: string;
  activeFile: string | null;
  graph: RepoGraph | null;
  onOpenFile: (abs: string) => void;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}> = ({ rootPath, activeFile, graph, onOpenFile, onClose, onRefresh, refreshing }) => {
  const { t } = useTranslation();
  const data = useMemo(() => {
    if (!activeFile || !graph || !rootPath) return null;
    return relationsFor(relWithinRoot(activeFile, rootPath), graph.edges);
  }, [activeFile, graph, rootPath]);
  const open = (rel: string): void => onOpenFile(absFromRel(rootPath, rel));
  return (
    <aside className='w-240px shrink-0 min-h-0 flex flex-col border-l border-b-1 bg-1'>
      <header className='shrink-0 flex items-center justify-between h-38px px-12px border-b border-b-1'>
        <span className='flex items-center gap-8px text-12px font-[500] text-t-primary'>
          <Link theme='outline' size={14} className='text-primary' />
          {t('ide.relations.title')}
        </span>
        <span className='flex items-center gap-2px'>
          <Tooltip content={t('ide.relations.refresh')} position='bottom'>
            <Button
              type='text'
              size='mini'
              loading={refreshing}
              disabled={!activeFile}
              icon={<Refresh theme='outline' size={14} />}
              className='!text-t-secondary'
              onClick={onRefresh}
              aria-label={t('ide.relations.refresh')}
            />
          </Tooltip>
          <Button
            type='text'
            size='mini'
            icon={<Right theme='outline' size={14} />}
            className='!text-t-secondary'
            onClick={onClose}
            aria-label={t('ide.relations.hide')}
          />
        </span>
      </header>
      <div className='flex-1 min-h-0 overflow-auto p-8px'>
        {!data ? (
          <div className='flex-center h-full px-12px'>
            <Empty description={t('ide.relations.pickFile')} />
          </div>
        ) : (
          <>
            <RelationSection title={t('ide.relations.usedByTitle')} items={data.usedBy} onOpen={open} />
            <RelationSection title={t('ide.relations.dependsOnTitle')} items={data.dependsOn} onOpen={open} />
          </>
        )}
      </div>
    </aside>
  );
};

/** One section of the relations rail (a titled, clickable list of repo files). */
const RelationSection: React.FC<{ title: string; items: string[]; onOpen: (rel: string) => void }> = ({
  title,
  items,
  onOpen,
}) => {
  const { t } = useTranslation();
  return (
    <div className='mb-12px'>
      <p className='m-0 mb-4px px-4px text-11px font-600 text-t-tertiary uppercase tracking-wide'>
        {title} · {items.length}
      </p>
      {items.length === 0 ? (
        <p className='m-0 px-4px text-12px text-t-tertiary'>{t('ide.relations.none')}</p>
      ) : (
        items.map((rel) => {
          const slash = rel.lastIndexOf('/');
          const name = slash >= 0 ? rel.slice(slash + 1) : rel;
          const dir = slash >= 0 ? rel.slice(0, slash) : '';
          return (
            <button
              key={rel}
              type='button'
              title={rel}
              onClick={() => onOpen(rel)}
              className='w-full flex flex-col items-start px-6px py-4px rd-6px cursor-pointer border-none bg-transparent text-left hover:bg-fill-2 transition-colors'
            >
              <span className='text-12px text-t-primary font-mono truncate max-w-full'>{name}</span>
              {dir ? <span className='text-10px text-t-tertiary truncate max-w-full'>{dir}</span> : null}
            </button>
          );
        })
      )}
    </div>
  );
};

/** The open-file tab strip: shows each kept-alive editor with a dirty marker + close. */
const EditorTabs: React.FC<{
  openFiles: string[];
  activeFile: string | null;
  dirtyFiles: Set<string>;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}> = ({ openFiles, activeFile, dirtyFiles, onSelect, onClose }) => {
  const { t } = useTranslation();
  return (
    <div className='shrink-0 flex items-stretch gap-2px px-8px pt-6px overflow-x-auto border-b border-b-1'>
      {openFiles.map((filePath) => {
        const active = activeFile === filePath;
        const dirty = dirtyFiles.has(filePath);
        return (
          <div
            key={filePath}
            role='tab'
            aria-selected={active}
            title={filePath}
            onClick={() => onSelect(filePath)}
            className={`group flex items-center gap-6px max-w-200px pl-12px pr-8px py-6px rd-t-8px cursor-pointer border border-b-0 transition-colors ${active ? 'bg-1 border-arco-2 text-t-primary' : 'bg-fill-1 border-transparent text-t-secondary hover:bg-fill-2'}`}
          >
            <span className='truncate text-12px'>{baseName(filePath)}</span>
            {dirty ? (
              <span className='shrink-0 size-6px rd-full bg-warning' aria-label={t('ide.workspace.unsavedDot')} />
            ) : null}
            <span
              role='button'
              aria-label={t('ide.workspace.closeTab')}
              onClick={(e) => {
                e.stopPropagation();
                onClose(filePath);
              }}
              className='shrink-0 size-16px flex-center rd-4px text-t-tertiary hover:bg-fill-3 hover:text-t-primary'
            >
              <Close theme='outline' size={11} />
            </span>
          </div>
        );
      })}
    </div>
  );
};

/**
 * Compact Join-collab modal shown on the empty IDE state. Lets a peer join a
 * host's repo by `ip:port` or tunnel URL — no local folder required. Mirrors
 * the join form inside {@link TeamCollabBar} but lives standalone here so the
 * pre-folder UI never has to mount the full collab bar.
 */
const JoinCollabModal: React.FC<{
  visible: boolean;
  collab: ReturnType<typeof useTeamCollab>;
  onClose: () => void;
}> = ({ visible, collab, onClose }) => {
  const { t } = useTranslation();
  const [joinUrl, setJoinUrl] = useState('');
  const [password, setPassword] = useState('123456');
  const [name, setName] = useState('');

  useEffect(() => {
    if (visible) {
      setJoinUrl('');
      setPassword('123456');
      setName('');
    }
  }, [visible]);

  const doJoin = async (): Promise<void> => {
    const raw = joinUrl.trim();
    if (!raw) return;
    const baseUrl = /^https?:\/\//.test(raw) ? raw : `http://${raw}`;
    const ok = await collab.join(baseUrl, password, name || t('ide.team.you'));
    if (ok) onClose();
  };

  return (
    <Modal
      title={t('ide.teamCollab.joinTitle')}
      visible={visible}
      onCancel={onClose}
      onOk={() => void doJoin()}
      confirmLoading={collab.busy}
      okText={t('ide.teamCollab.join')}
      autoFocus={false}
    >
      <div className='flex flex-col gap-12px'>
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-t-secondary'>{t('ide.teamCollab.joinCodeLabel')}</span>
          <Input value={joinUrl} onChange={setJoinUrl} placeholder={t('ide.teamCollab.joinCodePlaceholder')} />
        </label>
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-t-secondary'>{t('ide.teamCollab.password')}</span>
          <Input.Password value={password} onChange={setPassword} placeholder='123456' />
        </label>
        <label className='flex flex-col gap-4px'>
          <span className='text-12px text-t-secondary'>{t('ide.teamCollab.yourName')}</span>
          <Input value={name} onChange={setName} placeholder={t('ide.teamCollab.namePlaceholder')} />
        </label>
        {collab.error ? <span className='text-12px text-danger'>{collab.error}</span> : null}
      </div>
    </Modal>
  );
};

export default IdeWorkspace;
