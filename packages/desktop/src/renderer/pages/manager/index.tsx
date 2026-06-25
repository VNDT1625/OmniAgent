/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Personal Manager app entry. A top-level workspace (like Studio) with three
 * tabs — Tasks, Notes, Schedule — backed by a local file store and the user's
 * configured AI model. Registered at `/manager` in the router. Renderer-only.
 */

import React from 'react';
import ManagerPage from './ManagerPage';

const Manager: React.FC = () => <ManagerPage />;

export default Manager;
