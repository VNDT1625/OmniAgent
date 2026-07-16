/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Small status pill for a workspace surface frame — shows the sub-agent's
 * lifecycle state (queued / starting / running / done / error / stopped) with a
 * semantic colour. Renderer-only, Arco + UnoCSS semantic tokens (no hardcoded
 * colours).
 */

import { Tag } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SurfaceStatus } from '@process/workspace/surfaceTypes';

/** Map a surface status to an Arco Tag colour token. */
const COLOR_BY_STATUS: Record<SurfaceStatus, string> = {
  queued: 'gray',
  starting: 'arcoblue',
  running: 'arcoblue',
  done: 'green',
  error: 'red',
  stopped: 'orange',
};

/** Props for {@link SurfaceStatusBadge}. */
export type SurfaceStatusBadgeProps = {
  /** The surface's current lifecycle status. */
  status: SurfaceStatus;
};

/** A coloured pill labelling a surface's status (i18n via `workspace.status.*`). */
const SurfaceStatusBadge: React.FC<SurfaceStatusBadgeProps> = ({ status }) => {
  const { t } = useTranslation();
  return (
    <Tag color={COLOR_BY_STATUS[status]} size='small' bordered>
      {t(`workspace.status.${status}`)}
    </Tag>
  );
};

export default SurfaceStatusBadge;
