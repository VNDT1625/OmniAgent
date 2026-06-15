/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `LiveEditorFrame` — one live EDITOR frame inside the Super watch grid.
 *
 * Renders the project's {@link UniversalEditor} (the same component Studio uses)
 * for a file the agent opened via the `editor_open` / `editor_write` MCP tools.
 * It reloads the file from disk whenever the frame's `version` bumps (i.e. the
 * agent wrote), so the user watches the document change in near-real-time — the
 * editor counterpart of {@link LiveBrowserFrame}.
 *
 * The editor is read-only here: the user watches the agent work (manual editing
 * happens in the full Studio app). Unlike browser frames this is pure DOM — no
 * native view positioning needed.
 *
 * Renderer-only module: reads via the fs bridge through UniversalEditor.
 */

import { Typography } from '@arco-design/web-react';
import { FileEditing } from '@icon-park/react';
import React, { useEffect, useRef } from 'react';
import { UniversalEditor } from '@renderer/pages/editor/UniversalEditor';
import { useUniversalEditor } from '@renderer/pages/editor/hooks/useUniversalEditor';

/** Props for {@link LiveEditorFrame}. */
export type LiveEditorFrameProps = {
  /** Path of the file this frame edits. */
  filePath: string;
  /** Short title (file name). */
  title: string;
  /** Bumps whenever the agent writes the file → triggers a reload from disk. */
  version: number;
};

/** One live editor frame: header (file name) + a reloading UniversalEditor. */
const LiveEditorFrame: React.FC<LiveEditorFrameProps> = ({ filePath, title, version }) => {
  const controller = useUniversalEditor({ filePath });
  const lastVersion = useRef(version);

  // Re-read the file whenever the agent reports a new write (version bump).
  useEffect(() => {
    if (version !== lastVersion.current) {
      lastVersion.current = version;
      void controller.file.reload();
    }
  }, [version, controller.file]);

  return (
    <div className='flex flex-col min-h-0 rd-12px border border-solid border-line-2 bg-base overflow-hidden'>
      <div className='flex items-center gap-8px px-10px py-7px border-b border-solid border-line-2 bg-fill-1 shrink-0'>
        <span className='size-20px flex-center rd-6px bg-fill-2 text-t-secondary shrink-0'>
          <FileEditing theme='outline' size='13' />
        </span>
        <Typography.Text className='flex-1 m-0 text-12px font-600 text-t-primary truncate' title={filePath}>
          {title}
        </Typography.Text>
      </div>
      <div className='flex-1 min-h-160px w-full overflow-hidden bg-base'>
        <UniversalEditor filePath={filePath} controller={{ ...controller, readOnly: true }} />
      </div>
    </div>
  );
};

export default LiveEditorFrame;
