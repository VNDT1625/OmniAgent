/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import AppLoader from '@/renderer/components/layout/AppLoader';

describe('AppLoader', () => {
  it('renders an accessible overlay during a top-level route transition', () => {
    render(<AppLoader overlay />);

    const loader = screen.getByRole('status', { name: 'common.loading' });
    expect(loader).toHaveClass('route-loader--overlay');
    expect(loader).toHaveAttribute('aria-busy', 'true');
  });

  it('uses the in-page presentation for lazy route loading', () => {
    render(<AppLoader />);

    expect(screen.getByRole('status', { name: 'common.loading' })).toHaveClass('route-loader--page');
  });
});
