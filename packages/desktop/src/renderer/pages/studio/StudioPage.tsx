/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `StudioPage` — top-level view for the Studio app (`/studio`). A tiny local
 * router between the WPS-like dashboard, open-file editors, and the IDE.
 *
 * Background-friendly editors: once a file is opened, its editor view stays
 * MOUNTED (just hidden via `display:none`) when the user goes back to the
 * dashboard or opens another file. This keeps the live ONLYOFFICE editor + its
 * AI agent running in the background, so a doc-editing run continues while the
 * user browses other files, and returning to the file shows it exactly as left.
 * Editors are tracked in `openFiles`; closing one unmounts it (ending the agent
 * session's live editing).
 *
 * Renderer-only.
 */

import React, { Suspense, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getLastStudioView, isStarred, setLastStudioView, toggleStarred } from './studioStorage';
import StudioDashboard from './components/StudioDashboard';
import StudioEditorView from './components/StudioEditorView';
import StudioPeerView from './components/StudioPeerView';
import { useEditorToolsProvider } from './editorToolsProvider';
import { useMakeVideoAgentHarness } from './makevideo/makeVideoAgentHarness';
import type { CollabJoinData } from '@renderer/pages/editor/adapters/collabClient';
import { MUSIC_STUDIO_ENABLED } from '@/common/config/constants';

const AutomationView = React.lazy(() => import('./automation/AutomationView'));
const IdeWorkspace = React.lazy(() => import('./ide/IdeWorkspace'));
const MakeVideoView = React.lazy(() => import('./makevideo/MakeVideoView'));
const MusicStudio = React.lazy(() => import('@renderer/pages/music'));

type StudioView =
  | { mode: 'dashboard' }
  | { mode: 'editor'; filePath: string }
  | { mode: 'peer'; join: CollabJoinData; hostBaseUrl: string }
  | { mode: 'ide' }
  | { mode: 'automation' }
  | { mode: 'makeVideo' }
  | { mode: 'music' };

type StudioRouteState = {
  studioView?: 'music';
};

const StudioPage: React.FC = () => {
  const location = useLocation();
  const routeState = location.state as StudioRouteState | null;
  // Register the Main→Renderer editor-tools provider once for the Studio app, so
  // the Office-editor MCP server can drive whichever Office editor is open.
  useEditorToolsProvider();
  useMakeVideoAgentHarness();

  const [view, setView] = useState<StudioView>(() => {
    if (routeState?.studioView === 'music' && MUSIC_STUDIO_ENABLED) return { mode: 'music' };

    const lastView = getLastStudioView();
    return lastView.mode === 'music' && !MUSIC_STUDIO_ENABLED ? { mode: 'dashboard' } : lastView;
  });
  // Files with a live (kept-alive) editor. Order doesn't matter; presence does.
  const [openFiles, setOpenFiles] = useState<string[]>(() => (view.mode === 'editor' ? [view.filePath] : []));
  // Bump to force a re-read of the starred flag after toggling from the editor.
  const [, setStarTick] = useState(0);

  useEffect(() => {
    if (view.mode !== 'peer') setLastStudioView(view);
  }, [view]);

  const handleStar = (filePath: string): void => {
    toggleStarred(filePath);
    setStarTick((tick) => tick + 1);
  };

  const openFile = (filePath: string): void => {
    setOpenFiles((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
    setView({ mode: 'editor', filePath });
  };

  const closeFile = (filePath: string): void => {
    setOpenFiles((prev) => prev.filter((p) => p !== filePath));
    setView({ mode: 'dashboard' });
  };

  const isEditor = view.mode === 'editor';
  const showDashboard = view.mode === 'dashboard';

  return (
    <div className='size-full relative'>
      {/* Dashboard — hidden (not unmounted) while an editor is foreground so
          returning is instant; fully shown otherwise. */}
      <div className='size-full' style={{ display: showDashboard ? 'block' : 'none' }}>
        <StudioDashboard
          onOpenFile={openFile}
          onOpenIde={() => setView({ mode: 'ide' })}
          onJoinSession={(join, joinCode) => setView({ mode: 'peer', join, hostBaseUrl: `http://${joinCode}` })}
          onAutomation={() => setView({ mode: 'automation' })}
          onMakeVideo={() => setView({ mode: 'makeVideo' })}
          onMusic={() => setView({ mode: 'music' })}
        />
      </div>

      {/* Kept-alive editors: all mounted; only the active one is visible. The
          others keep running their AI agent in the background. */}
      {openFiles.map((filePath) => {
        const active = isEditor && view.filePath === filePath;
        return (
          <div key={filePath} className='absolute inset-0' style={{ display: active ? 'block' : 'none' }}>
            <StudioEditorView
              filePath={filePath}
              starred={isStarred(filePath)}
              onBack={() => setView({ mode: 'dashboard' })}
              onClose={() => closeFile(filePath)}
              onStar={handleStar}
            />
          </div>
        );
      })}

      {view.mode === 'ide' ? (
        <div className='absolute inset-0'>
          <Suspense fallback={null}>
            <IdeWorkspace onBack={() => setView({ mode: 'dashboard' })} />
          </Suspense>
        </div>
      ) : null}

      {view.mode === 'peer' ? (
        <div className='absolute inset-0'>
          <StudioPeerView
            join={view.join}
            hostBaseUrl={view.hostBaseUrl}
            onBack={() => setView({ mode: 'dashboard' })}
          />
        </div>
      ) : null}

      {view.mode === 'automation' ? (
        <div className='absolute inset-0'>
          <Suspense fallback={null}>
            <AutomationView onBack={() => setView({ mode: 'dashboard' })} />
          </Suspense>
        </div>
      ) : null}

      {view.mode === 'makeVideo' ? (
        <div className='absolute inset-0'>
          <Suspense fallback={null}>
            <MakeVideoView onBack={() => setView({ mode: 'dashboard' })} />
          </Suspense>
        </div>
      ) : null}

      {view.mode === 'music' ? (
        <div className='absolute inset-0'>
          <Suspense fallback={null}>
            <MusicStudio onBack={() => setView({ mode: 'dashboard' })} />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
};

export default StudioPage;
