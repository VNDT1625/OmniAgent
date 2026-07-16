/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `QuickTestBrowser` — the live embedded browser hosted INSIDE the Quick Test
 * panel. It is the surface the user actually drives while Omni records the
 * runtime trace, so Quick Test no longer asks the user to "open the Browser
 * tab elsewhere" — the app under test runs right here.
 *
 * Like {@link LiveBrowserFrame}, the tab's native `WebContentsView` is not a DOM
 * node: it floats above the window. So this component reserves a region,
 * measures its on-screen rectangle, and pushes it to the Main process via
 * `setBounds`, then makes the view visible. It re-measures on resize/scroll and
 * hides the view on unmount so it never paints over other IDE modes.
 *
 * It owns the tab lifecycle: it opens a dedicated tab on mount, reports the tab
 * id to the parent (so {@link QuickTestPanel} can pass it to `qtStart` and CDP
 * attaches to THIS tab), and destroys the tab on unmount. An Arco address bar
 * with back/forward/reload lets the user navigate their app (e.g. a local dev
 * server URL).
 *
 * Renderer-only module: positions the view via IPC; never renders web content.
 */

import { Button, Input, Tooltip } from '@arco-design/web-react';
import { Left, Refresh, Right } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { browserClient } from '@renderer/pages/browser/browserBridgeClient';

/** Props for {@link QuickTestBrowser}. */
export type QuickTestBrowserProps = {
  /**
   * Called with the dedicated tab id once the embedded tab is open (and with
   * `null` when it is torn down), so the panel can target CDP at this tab.
   */
  onTabReady: (tabId: string | null) => void;
  /**
   * A URL the parent wants the embedded tab to open (e.g. the dev URL the
   * Quick-Run plan resolved). Each distinct non-empty value triggers one
   * navigation, so the panel can auto-open the app once the dev server is up.
   */
  navigateUrl?: string | null;
  /** Optional controls rendered inside the address toolbar before navigation. */
  toolbarLeading?: React.ReactNode;
  /** Optional controls rendered inside the address toolbar after the address field. */
  toolbarTrailing?: React.ReactNode;
  /** Hide the native view while a DOM popup overlaps its reserved region. */
  nativeOverlayBlocked?: boolean;
};

/** Debounce window (ms) for pushing the frame's bounds. Higher = calmer, less pulsing. */
const BOUNDS_DEBOUNCE_MS = 120;

/**
 * Stable id for the Quick Test embedded tab. Using a FIXED id (rather than a
 * random one) lets a fresh mount after a renderer refresh (F5/Ctrl+R) find and
 * reuse the SAME native tab instead of leaking a second orphaned WebContentsView
 * that keeps painting over the UI (the "refresh → treo, chuyển tab vẫn thấy web"
 * bug). Exactly one Quick Test browser is ever mounted at a time.
 */
const QT_TAB_ID = 'ide-quicktest-embedded';

/** Normalize a raw address-bar value into a navigable URL (adds https:// when bare). */
const normalizeUrl = (raw: string): string => {
  const value = raw.trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value) || /^(about|file|localhost):/i.test(value)) return value;
  // A bare host or "localhost:3000" → assume http for local, https otherwise.
  if (/^localhost(:\d+)?(\/|$)/i.test(value) || /^\d+\.\d+\.\d+\.\d+(:\d+)?/.test(value)) {
    return `http://${value}`;
  }
  return `https://${value}`;
};

/**
 * The embedded browser the user tests against. Header = navigation controls +
 * address bar; body = the reserved region the native view paints over.
 */
const QuickTestBrowser: React.FC<QuickTestBrowserProps> = ({
  onTabReady,
  navigateUrl,
  toolbarLeading,
  toolbarTrailing,
  nativeOverlayBlocked = false,
}) => {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  // Last zoom factor pushed to the native view. Quick Test keeps zoom at 1 so
  // the selected viewport width is stable and never pulses due to side panels.
  const lastZoomRef = useRef<number>(0);
  // Last pushed geometry (rounded) to avoid redundant setBounds when ResizeObserver
  // or timers report micro-jitter or no-op resizes.
  const lastRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  /** Force next push to re-apply zoom=1 after navigations that may reset Chromium zoom. */
  const forceZoomRef = useRef(false);
  const nativeOverlayBlockedRef = useRef(nativeOverlayBlocked);
  nativeOverlayBlockedRef.current = nativeOverlayBlocked;

  // Reposition the native view to cover the reserved region (or hide it when
  // the region is off-screen / collapsed). Mirrors LiveBrowserFrame.
  const pushBounds = useCallback(() => {
    const id = tabIdRef.current;
    const el = hostRef.current;
    if (!id || !el) return;
    if (nativeOverlayBlockedRef.current) {
      lastRectRef.current = null;
      void browserClient.setVisible({ id, visible: false }).catch(() => {});
      return;
    }
    const rect = el.getBoundingClientRect();
    const offscreen = rect.width <= 1 || rect.height <= 1 || rect.bottom <= 0 || rect.top >= window.innerHeight;
    if (offscreen) {
      lastRectRef.current = null;
      void browserClient.setVisible({ id, visible: false }).catch(() => {});
      return;
    }
    const rw = Math.round(rect.width);
    const rh = Math.round(rect.height);
    const rx = Math.round(rect.left);
    const ry = Math.round(rect.top);
    const prev = lastRectRef.current;
    // Ignore subpixel micro-jitter, but still move when the real container moves.
    const geometryChanged =
      !prev ||
      Math.abs(prev.x - rx) > 2 ||
      Math.abs(prev.y - ry) > 2 ||
      Math.abs(prev.w - rw) > 2 ||
      Math.abs(prev.h - rh) > 2;
    if (geometryChanged) {
      lastRectRef.current = { x: rx, y: ry, w: rw, h: rh };
      void browserClient
        .setBounds({
          id,
          bounds: { x: rx, y: ry, width: rw, height: rh },
        })
        .catch(() => {});
    }

    const shouldForceZoom = forceZoomRef.current || lastZoomRef.current !== 1;
    if (shouldForceZoom) {
      lastZoomRef.current = 1;
      forceZoomRef.current = false;
      void browserClient.setZoom({ id, factor: 1 }).catch(() => {});
    }
    if (geometryChanged) {
      void browserClient.setVisible({ id, visible: true }).catch(() => {});
    }
  }, []);

  const schedulePush = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(pushBounds, BOUNDS_DEBOUNCE_MS);
  }, [pushBounds]);

  // Open the dedicated tab on mount; destroy it on unmount. Bounds are pushed
  // only when the real reserved region changes, and zoom is kept at 1 to avoid
  // repeated native repaint pulses during recording.
  //
  // The tab uses a FIXED id ({@link QT_TAB_ID}). A renderer refresh (F5/Ctrl+R)
  // skips React cleanup, so the old native view would otherwise be orphaned and
  // keep painting over the whole IDE (the "treo + chuyển tab vẫn thấy web" bug).
  // By reusing a fixed id, the freshly-reloaded renderer simply re-attaches to
  // that surviving tab instead of leaking a second one; we then re-apply bounds
  // so it tracks the new layout. `openTab` throws when the id already exists, so
  // a thrown error here means "an orphan from before the refresh is still alive"
  // — we adopt it rather than create a new one.
  useEffect(() => {
    let alive = true;
    const adopt = (id: string): void => {
      if (!alive) {
        void browserClient.setVisible({ id, visible: false }).catch(() => {});
        return;
      }
      tabIdRef.current = id;
      lastRectRef.current = null;
      lastZoomRef.current = 0;
      setTabId(id);
      onTabReady(id);
      pushBounds();
    };
    void browserClient
      .openTab({ id: QT_TAB_ID, visible: false })
      .then((res) => adopt(res.id))
      // Id already in use → an orphan survived a refresh; re-attach to it.
      .catch(() => adopt(QT_TAB_ID));
    return () => {
      alive = false;
      const id = tabIdRef.current;
      tabIdRef.current = null;
      lastRectRef.current = null;
      lastZoomRef.current = 0;
      onTabReady(null);
      if (id) {
        void browserClient.setVisible({ id, visible: false }).catch(() => {});
        void browserClient.destroyTab({ id }).catch(() => {});
      }
    };
    // onTabReady/pushBounds are stable for the panel's lifetime; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A renderer refresh does not run React cleanup, so hide the native view on
  // `beforeunload` — otherwise the surviving tab paints over the reloading IDE
  // (a grey/frozen overlay) until the remount re-positions it. Hiding now means
  // the reloaded renderer re-shows it at the right bounds via the mount effect.
  useEffect(() => {
    const onBeforeUnload = (): void => {
      const id = tabIdRef.current;
      if (id) void browserClient.setVisible({ id, visible: false }).catch(() => {});
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Keep the native view glued to the region on resize/scroll.
  useEffect(() => {
    if (!tabId) return undefined;
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
    };
  }, [tabId, pushBounds, schedulePush]);

  // Native WebContentsViews sit above renderer DOM and otherwise intercept
  // pointer events meant for dropdowns/modals that extend into the browser body.
  useEffect(() => {
    const id = tabIdRef.current;
    if (!id) return;
    if (nativeOverlayBlocked) {
      lastRectRef.current = null;
      void browserClient.setVisible({ id, visible: false }).catch(() => {});
      return;
    }
    pushBounds();
  }, [nativeOverlayBlocked, pushBounds]);

  // Mirror live URL/title changes (including in-page SPA navigation) into the
  // address bar so it stays in sync as the user clicks around their app.
  useEffect(() => {
    if (!tabId) return undefined;
    const unsub = browserClient.onTabUpdated((update) => {
      if (update.id !== tabId) return;
      // Only update state (and trigger downstream zoom re-apply) on actual change.
      // Rapid did-navigate / title events from the loaded app must not cause
      // spurious repeated setZoom that make the display pulse.
      setCurrentUrl((prev) => (prev === update.url ? prev : update.url));
      setAddress((prev) => (prev === update.url ? prev : update.url));
    });
    return () => unsub();
  }, [tabId]);

  const navigate = useCallback(() => {
    const id = tabIdRef.current;
    if (!id) return;
    const url = normalizeUrl(address);
    if (!url) return;
    setCurrentUrl(url);
    void browserClient.navigate({ id, url }).catch(() => {});
  }, [address]);

  // Parent-driven navigation: when the Quick-Run plan resolves a dev URL (and
  // the dev server is up), open it here automatically. Guarded so the same URL
  // is not re-opened on every render (only a distinct value navigates).
  const lastNavRef = useRef<string | null>(null);
  useEffect(() => {
    const target = navigateUrl?.trim();
    if (!tabId || !target || target === lastNavRef.current) return;
    lastNavRef.current = target;
    const url = normalizeUrl(target);
    if (!url) return;
    setAddress(url);
    setCurrentUrl(url);
    void browserClient.navigate({ id: tabId, url }).catch(() => {});
    // Force re-apply the desktop viewport zoom after the navigation (Chromium resets it).
    forceZoomRef.current = true;
    schedulePush();
  }, [navigateUrl, tabId]);

  // When the controlled run stops (readyUrl cleared), reset tracking so the
  // next "Run" starts with a clean zoom/size baseline. This helps stability
  // across multiple test iterations after clicks/inspect.
  useEffect(() => {
    if (!navigateUrl) {
      forceZoomRef.current = false;
      lastZoomRef.current = 0;
      lastRectRef.current = null;
    }
  }, [navigateUrl]);

  const goBack = useCallback(() => {
    const id = tabIdRef.current;
    if (id) void browserClient.goBack({ id }).catch(() => {});
  }, []);
  const goForward = useCallback(() => {
    const id = tabIdRef.current;
    if (id) void browserClient.goForward({ id }).catch(() => {});
  }, []);
  const reload = useCallback(() => {
    const id = tabIdRef.current;
    if (id && currentUrl) void browserClient.navigate({ id, url: currentUrl }).catch(() => {});
  }, [currentUrl]);

  // Only re-apply zoom on controlled navigates (readyUrl from Run).
  // Do NOT force on every currentUrl / in-page nav from the app under test.
  // This prevents continuous pulsing when the user clicks around during recording.
  // If Chromium resets zoom on SPA nav, it will be corrected on the next explicit navigation or viewport action.

  return (
    <div className='size-full flex flex-col min-h-0 bg-fill-1'>
      <div className='shrink-0 flex items-center gap-5px px-8px py-3px border-b border-b-1 bg-1'>
        {toolbarLeading}
        <Tooltip content={t('browser.address.back')}>
          <Button size='mini' type='text' icon={<Left theme='outline' size={15} />} onClick={goBack} />
        </Tooltip>
        <Tooltip content={t('browser.address.forward')}>
          <Button size='mini' type='text' icon={<Right theme='outline' size={15} />} onClick={goForward} />
        </Tooltip>
        <Tooltip content={t('browser.address.reload')}>
          <Button size='mini' type='text' icon={<Refresh theme='outline' size={14} />} onClick={reload} />
        </Tooltip>
        <Input
          size='mini'
          value={address}
          onChange={setAddress}
          onPressEnter={navigate}
          allowClear
          placeholder={t('browser.address.placeholder')}
          className='flex-1'
        />
        {toolbarTrailing}
      </div>
      {/* The native WebContentsView paints over this region. */}
      <div ref={hostRef} className='flex-1 min-h-0 w-full bg-fill-2' aria-hidden='true' />
    </div>
  );
};

export default QuickTestBrowser;
