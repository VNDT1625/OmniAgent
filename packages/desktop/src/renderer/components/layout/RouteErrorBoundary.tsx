/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RouteErrorBoundary` — catches runtime errors thrown while rendering a routed
 * page so a single page crash shows a readable message + Reload button instead
 * of unmounting the whole React tree (which leaves the window blank with no
 * hint). Wraps the lazy route elements in {@link Router}.
 *
 * Why a class component: React error boundaries require `componentDidCatch` /
 * `getDerivedStateFromError`, which have no hooks equivalent.
 *
 * Renderer-only. No Node.js APIs.
 */

import React from 'react';
import { Button, Result } from '@arco-design/web-react';

type Props = {
  children: React.ReactNode;
  /** Re-mount the boundary when this key changes (e.g. the route path), so
   *  navigating away from a crashed page clears the error. */
  resetKey?: string;
};

type State = { error: Error | null };

class RouteErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface to the console (forwarded to the main-process log) so the real
    // stack is recoverable even though the UI only shows a summary.
    console.error('[RouteErrorBoundary] A routed page crashed:', error, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className='flex items-center justify-center h-full w-full p-24px'>
        <Result
          status='error'
          title='This page hit an error'
          subTitle={error.message || String(error)}
          extra={
            <Button type='primary' onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        />
      </div>
    );
  }
}

export default RouteErrorBoundary;
