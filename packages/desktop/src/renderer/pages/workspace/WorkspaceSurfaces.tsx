/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `WorkspaceSurfaces` — the reusable body that runs several sub-agents in
 * parallel, each on its own live frame (composer + parallel-frame grid).
 *
 * It is intentionally chrome-less (no page header, no route/settings wrapper) so
 * it can be embedded **inside a conversation** — the chat with the CLI/AI the
 * user picked — rather than living as a standalone settings page. The hosting
 * conversation supplies a `defaultModel` (its own selected model) so the
 * sub-agents run on the same model the user is already chatting with; the user
 * can still override it in the composer.
 *
 * Renderer-only: talks to the Main process only via the workspace bridge client.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import SurfaceGrid from './components/SurfaceGrid';
import WorkspaceComposer from './components/WorkspaceComposer';
import { loadWorkspaceModel, parseSurfaceSpecs, saveWorkspaceModel } from './constants';
import { useWorkspaceRun } from './useWorkspaceRun';

/** Props for {@link WorkspaceSurfaces}. */
export type WorkspaceSurfacesProps = {
  /**
   * Model the host conversation is using; used as the initial model for the
   * sub-agents (the user can override it in the composer). When omitted the
   * last-used workspace model (localStorage) is used.
   */
  defaultModel?: string | null;
};

/** Composer + live parallel-frame grid, embeddable inside a conversation. */
const WorkspaceSurfaces: React.FC<WorkspaceSurfacesProps> = ({ defaultModel }) => {
  const { t } = useTranslation();
  const run = useWorkspaceRun();
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState<string | null>(() => defaultModel ?? loadWorkspaceModel());

  // Adopt the conversation's model when it becomes available and the user has
  // not picked one yet (so a freshly opened panel uses the chat's own model).
  useEffect(() => {
    if (defaultModel) setModel((cur) => cur ?? defaultModel);
  }, [defaultModel]);

  const handleModelChange = useCallback((next: string | null) => {
    setModel(next);
    saveWorkspaceModel(next);
  }, []);

  const handleRun = useCallback(() => {
    if (!model) return;
    const specs = parseSurfaceSpecs(draft, model);
    if (specs.length === 0) return;
    void run.start(specs);
  }, [draft, model, run]);

  return (
    <div className='flex flex-col h-full w-full gap-12px min-h-0'>
      <WorkspaceComposer
        draft={draft}
        model={model}
        running={run.status === 'running'}
        onDraftChange={setDraft}
        onModelChange={handleModelChange}
        onRun={handleRun}
        onStop={run.cancel}
      />
      {run.error ? <Alert type='warning' showIcon content={t('workspace.bridgeUnavailable')} /> : null}
      <div className='flex-1 min-h-0'>
        <SurfaceGrid surfaces={run.surfaces} logs={run.logs} />
      </div>
    </div>
  );
};

export default WorkspaceSurfaces;
