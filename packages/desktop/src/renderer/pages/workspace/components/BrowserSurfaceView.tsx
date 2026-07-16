/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The body of a **browser** surface frame: a placeholder region the
 * Main-process {@link WebContentsView} (the live tab the sub-agent drives) is
 * positioned over.
 *
 * The native view is NOT a DOM node — it floats above the window — so this
 * component measures its own on-screen rectangle (`getBoundingClientRect`) and
 * pushes it to the Main process via the browser bridge's `setBounds`, exactly
 * the overlay mechanism the standalone Browser page uses. It re-measures on
 * resize/scroll and **hides** the view when the frame scrolls out of view or
 * unmounts, so multiple parallel browser frames don't bleed over each other or
 * over the rest of the chat.
 *
 * Renderer-only module: positions the view via IPC; never renders web content
 * itself.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { browserClient } from '@renderer/pages/browser/browserBridgeClient';
import { SURFACE_BOUNDS_DEBOUNCE_MS } from '../constants';

/** Props for {@link BrowserSurfaceView}. */
export type BrowserSurfaceViewProps = {
  /** The backing browser tab id whose native view this frame hosts. */
  tabId: string;
  /** Whether this frame is currently the visible/active one in its column. */
  active: boolean;
};

/**
 * Reserve a region for a browser surface's native view and keep the view aligned
 * to it. The view is shown while the frame is mounted + active and hidden
 * otherwise so stacked/parallel frames stay isolated.
 */
const BrowserSurfaceView: React.FC<BrowserSurfaceViewProps> = ({ tabId, active }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushBounds = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // A zero/negative or off-screen rect means the frame is not visible — hide
    // the native view instead of painting it at a stale position.
    const offscreen = rect.width <= 1 || rect.height <= 1 || rect.bottom <= 0 || rect.top >= window.innerHeight;
    if (!active || offscreen) {
      void browserClient.hide({ id: tabId }).catch(() => {});
      return;
    }
    void browserClient
      .setBounds({
        id: tabId,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      })
      .catch(() => {});
    void browserClient.show({ id: tabId }).catch(() => {});
  }, [tabId, active]);

  const schedulePush = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(pushBounds, SURFACE_BOUNDS_DEBOUNCE_MS);
  }, [pushBounds]);

  useEffect(() => {
    pushBounds();
    const el = hostRef.current;
    const observer = new ResizeObserver(schedulePush);
    if (el) observer.observe(el);
    window.addEventListener('resize', schedulePush);
    // Capture scrolls from any ancestor (the chat list scrolls) so the overlay tracks.
    window.addEventListener('scroll', schedulePush, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedulePush);
      window.removeEventListener('scroll', schedulePush, true);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Hide on unmount so the freed native view stops painting over the chat.
      void browserClient.hide({ id: tabId }).catch(() => {});
    };
  }, [tabId, pushBounds, schedulePush]);

  return <div ref={hostRef} className='h-full w-full bg-fill-1' aria-hidden='true' />;
};

export default BrowserSurfaceView;
