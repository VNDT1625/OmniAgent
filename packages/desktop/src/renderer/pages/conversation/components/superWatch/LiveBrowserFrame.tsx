/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `LiveBrowserFrame` — one live browser frame inside the in-chat watch grid.
 *
 * Each frame hosts ONE of the agent's embedded browser tabs. The tab's native
 * `WebContentsView` is not a DOM node — it floats above the window — so this
 * component reserves a region, measures its on-screen rectangle, and pushes it
 * to the Main process via `setBounds`, then makes the view visible with the
 * **non-exclusive** `setVisible(id, true)` (so sibling frames stay visible too).
 * It re-measures on resize/scroll and hides the view when the frame scrolls out
 * of view or unmounts, so stacked frames don't bleed over each other.
 *
 * Renderer-only module: positions the view via IPC; never renders web content.
 */

import { Typography } from '@arco-design/web-react';
import { Compass } from '@icon-park/react';
import React, { useCallback, useEffect, useRef } from 'react';
import { browserClient, type BrowserTabInfo } from '@renderer/pages/browser/browserBridgeClient';

/** Props for {@link LiveBrowserFrame}. */
export type LiveBrowserFrameProps = {
  /** The tab this frame hosts. */
  tab: BrowserTabInfo;
  /** Fallback label when the tab has no title yet. */
  fallbackLabel: string;
};

/** Debounce window (ms) for pushing a frame's bounds. */
const BOUNDS_DEBOUNCE_MS = 90;

/**
 * Logical desktop width (CSS px) the embedded page is fit to. The frame scales
 * the native view's zoom so this much layout fits its actual on-screen width —
 * i.e. a narrow in-chat frame shows a *shrunk-to-fit* desktop page instead of a
 * giant 100%-zoom page where only the top-left corner is visible (the user's
 * "vẫn to khổng lồ" report). Picked so sites render their desktop layout, then
 * get scaled down to the frame.
 */
const FIT_REFERENCE_WIDTH = 1100;
/** Zoom is clamped so text never gets unreadably tiny nor absurdly large. */
const MIN_FIT_ZOOM = 0.4;
const MAX_FIT_ZOOM = 1;

/** Compute the zoom factor that fits {@link FIT_REFERENCE_WIDTH} into `frameWidth`. */
const fitZoom = (frameWidth: number): number => {
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return MIN_FIT_ZOOM;
  const raw = frameWidth / FIT_REFERENCE_WIDTH;
  return Math.max(MIN_FIT_ZOOM, Math.min(MAX_FIT_ZOOM, raw));
};

/** Derive a short, friendly label for a tab (title → host → fallback). */
const labelOf = (title: string, url: string, fallback: string): string => {
  const trimmed = (title ?? '').trim();
  if (trimmed) return trimmed;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return fallback;
  }
};

/** One live browser frame: header (host) + the positioned native view region. */
const LiveBrowserFrame: React.FC<LiveBrowserFrameProps> = ({ tab, fallbackLabel }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastZoomRef = useRef<number>(0);
  const tabId = tab.id;

  const pushBounds = useCallback(() => {
    const el = hostRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Off-screen / collapsed → hide this view (don't paint at a stale position).
    const offscreen = rect.width <= 1 || rect.height <= 1 || rect.bottom <= 0 || rect.top >= window.innerHeight;
    if (offscreen) {
      void browserClient.setVisible({ id: tabId, visible: false }).catch(() => {});
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
    // Scale the page so a full desktop layout fits this narrow frame instead of
    // rendering at 100% (which would show only a magnified corner). Only push
    // when it changed meaningfully, to avoid spamming the bridge on every resize.
    const zoom = fitZoom(rect.width);
    if (Math.abs(zoom - lastZoomRef.current) > 0.02) {
      lastZoomRef.current = zoom;
      void browserClient.setZoom({ id: tabId, factor: zoom }).catch(() => {});
    }
    // Non-exclusive: show THIS tab without hiding the sibling frames.
    void browserClient.setVisible({ id: tabId, visible: true }).catch(() => {});
  }, [tabId]);

  const schedulePush = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(pushBounds, BOUNDS_DEBOUNCE_MS);
  }, [pushBounds]);

  useEffect(() => {
    pushBounds();
    const el = hostRef.current;
    const observer = new ResizeObserver(schedulePush);
    if (el) observer.observe(el);
    window.addEventListener('resize', schedulePush);
    window.addEventListener('scroll', schedulePush, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedulePush);
      window.removeEventListener('scroll', schedulePush, true);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      // Hide on unmount so the freed native view stops painting over the chat.
      void browserClient.setVisible({ id: tabId, visible: false }).catch(() => {});
    };
  }, [tabId, pushBounds, schedulePush]);

  // Chromium can reset the zoom factor when the page navigates (redirect or
  // in-page nav). Re-apply the fit-zoom whenever the tab's URL changes so the
  // page keeps fitting the frame instead of snapping back to a giant 100%.
  useEffect(() => {
    lastZoomRef.current = 0;
    schedulePush();
  }, [tab.url, schedulePush]);

  return (
    <div className='flex flex-col min-h-0 rd-12px border border-solid border-line-2 bg-base overflow-hidden'>
      <div className='flex items-center gap-8px px-10px py-7px border-b border-solid border-line-2 bg-fill-1 shrink-0'>
        <span className='size-20px flex-center rd-6px bg-fill-2 text-t-secondary shrink-0'>
          <Compass theme='outline' size='13' />
        </span>
        <Typography.Text className='flex-1 m-0 text-12px font-600 text-t-primary truncate' title={tab.url}>
          {labelOf(tab.title, tab.url, fallbackLabel)}
        </Typography.Text>
      </div>
      {/* The native WebContentsView paints over this region. */}
      <div ref={hostRef} className='flex-1 min-h-160px w-full bg-fill-1' aria-hidden='true' />
    </div>
  );
};

export default LiveBrowserFrame;
