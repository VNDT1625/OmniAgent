/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The body of an **editor** surface frame: a live, scaled-down view of the file
 * the editor sub-agent is rewriting. It renders the project's
 * {@link UniversalEditor} read-only and reloads it whenever the sub-agent reports
 * a write (so the frame reflects the agent's edits in near-real-time, the same
 * way the user would watch the Studio editor).
 *
 * Renderer-only module: the editor reads/writes through the fs HTTP bridge; no
 * Node.js APIs here.
 */

import React, { useEffect, useRef } from 'react';
import { UniversalEditor } from '@renderer/pages/editor/UniversalEditor';
import { useUniversalEditor } from '@renderer/pages/editor/hooks/useUniversalEditor';

/** Props for {@link EditorSurfaceView}. */
export type EditorSurfaceViewProps = {
  /** Absolute (or workspace-relative) path of the file being edited. */
  filePath: string;
  /**
   * A monotonically increasing tick that bumps whenever the sub-agent writes the
   * file; the view reloads from disk on each change so it mirrors the agent.
   */
  reloadTick: number;
};

/**
 * Live read-only preview of a file an editor sub-agent is rewriting. Uses a
 * shared {@link useUniversalEditor} controller so reloads can be triggered
 * imperatively when the agent saves.
 */
const EditorSurfaceView: React.FC<EditorSurfaceViewProps> = ({ filePath, reloadTick }) => {
  const controller = useUniversalEditor({ filePath });
  const lastTick = useRef(reloadTick);

  // Re-read the file from disk whenever the agent reports a new write.
  useEffect(() => {
    if (reloadTick !== lastTick.current) {
      lastTick.current = reloadTick;
      void controller.file.reload();
    }
  }, [reloadTick, controller.file]);

  return (
    <div className='h-full w-full overflow-hidden bg-base'>
      {/* Force read-only: the user watches the agent edit; manual edits happen in Studio. */}
      <UniversalEditor filePath={filePath} controller={{ ...controller, readOnly: true }} />
    </div>
  );
};

export default EditorSurfaceView;
