/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import type { NavigateOptions, To } from 'react-router-dom';

export interface LayoutContextValue {
  isMobile: boolean;
  siderCollapsed: boolean;
  setSiderCollapsed: (value: boolean) => void;
  /** Shows immediate feedback, lets Chromium paint, then changes a top-level route. */
  navigateWithFeedback: (to: To, options?: NavigateOptions) => void;
}

export const LayoutContext = React.createContext<LayoutContextValue | null>(null);

export function useLayoutContext(): LayoutContextValue | null {
  return React.useContext(LayoutContext);
}
