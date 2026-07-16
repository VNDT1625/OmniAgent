/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Studio app entry (Yêu cầu 2a wiring). A WPS-like file hub that opens any file
 * the Universal Editor supports, plus a Make Video entry (AI movie/anime).
 * Registered at `/studio` in the router. Renderer-only.
 */

import React from 'react';
import StudioPage from './StudioPage';

const Studio: React.FC = () => <StudioPage />;

export default Studio;
