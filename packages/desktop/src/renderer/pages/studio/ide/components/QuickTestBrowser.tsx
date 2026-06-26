/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
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

import { Button, Input, Select, Tooltip } from '@arco-design/web-react';
import { Left, Monitor, Redo, Refresh, Right } from '@icon-park/react';
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
};

/** Debounce window (ms) for pushing the frame's bounds. */
const BOUNDS_DEBOUNCE_MS = 90;

/**
 * Desktop viewport widths (CSS px) the user can preview against. The embedded
 * page is rendered as if its viewport were this wide — its real DESKTOP layout —
 * and then scaled with zoom so it fits the (usually narrower) panel region. This
 * is what fixes the "tracker shrinks the page so it triggers mobile breakpoints
 * and the design looks wrong" report: the page now lays out at a true desktop
 * width instead of at the panel's cramped physical width.
 *
 * `0` is the "Responsive / fit" option — no forced width, the page lays out at
 * the panel's own width at 100% zoom (useful for checking real responsive
 * behaviour at the current size).
 */
const VIEWPORT_WIDTHS = [0, 1280, 1440, 1920] as const;

/** Default preview width: 1440 is the most common design baseline for desktop. */
const DEFAULT_VIEWPORT_WIDTH = 1440;

/** Zoom is clamped to Chromium's practical range so a value can't break rendering. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1;

/**
 * Compute the zoom factor that fits a `referenceWidth`-wide desktop layout into
 * the panel's actual on-screen `hostWidth`. When `referenceWidth` is `0`
 * (Responsive), the page renders 1:1 at the panel width (zoom = 1).
 */
const fitZoom = (hostWidth: number, referenceWidth: number): number => {
  if (referenceWidth <= 0) return 1;
  if (!Number.isFinite(hostWidth) || hostWidth <= 0) return MIN_ZOOM;
  const raw = hostWidth / referenceWidth;
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, raw));
};

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
const QuickTestBrowser: React.FC<QuickTestBrowserProps> = ({ onTabReady, navigateUrl }) => {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabIdRef = useRef<string | null>(null);
  const [tabId, setTabId] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [currentUrl, setCurrentUrl] = useState('');
  // The desktop viewport width (CSS px) the page is laid out at; 0 = Responsive
  // (no forced width, 1:1). Drives the fit-zoom so the page renders its true
  // desktop layout scaled into the panel instead of a cramped, narrow viewport.
  const [viewportWidth, setViewportWidth] = useState<number>(DEFAULT_VIEWPORT_WIDTH);
  // Last zoom factor pushed to the native view, so we only re-push when it
  // changes meaningfully (avoids spamming the bridge on every resize tick).
  const lastZoomRef = useRef<number>(0);
  const viewportWidthRef = useRef<number>(DEFAULT_VIEWPORT_WIDTH);

  // Reposition the native view to cover the reserved region (or hide it when
  // the region is off-screen / collapsed). Mirrors LiveBrowserFrame.
  const pushBounds = useCallback(() => {
    const id = tabIdRef.current;
    const el = hostRef.current;
    if (!id || !el) return;
    const rect = el.getBoundingClientRect();
    const offscreen = rect.width <= 1 || rect.height <= 1 || rect.bottom <= 0 || rect.top >= window.innerHeight;
    if (offscreen) {
      void browserClient.setVisible({ id, visible: false }).catch(() => {});
      return;
    }
    void browserClient
      .setBounds({
        id,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      })
      .catch(() => {});
    const zoom = fitZoom(rect.width, viewportWidthRef.current);
    if (Math.abs(zoom - lastZoomRef.current) > 0.01) {
      lastZoomRef.current = zoom;
      void browserClient.setZoom({ id, factor: zoom }).catch(() => {});
    }
    void browserClient.setVisible({ id, visible: true }).catch(() => {});
  }, []);

  const schedulePush = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(pushBounds, BOUNDS_DEBOUNCE_MS);
  }, [pushBounds]);

  // Open the dedicated tab on mount; destroy it on unmount. The tab is fit-zoomed
  // so the page lays out at a desktop viewport width (see fitZoom), scaled to the
  // panel — not a cramped narrow viewport that would trip mobile breakpoints.
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

  // Mirror live URL/title changes (including in-page SPA navigation) into the
  // address bar so it stays in sync as the user clicks around their app.
  useEffect(() => {
    if (!tabId) return undefined;
    const unsub = browserClient.onTabUpdated((update) => {
      if (update.id !== tabId) return;
      setCurrentUrl(update.url);
      setAddress(update.url);
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
  }, [navigateUrl, tabId]);

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

  // Change the desktop preview width: update the ref the bounds-pusher reads,
  // reset the last-zoom guard so the new factor is force-applied, then re-push.
  const handleViewportChange = useCallback(
    (width: number) => {
      setViewportWidth(width);
      viewportWidthRef.current = width;
      lastZoomRef.current = 0;
      pushBounds();
    },
    [pushBounds]
  );

  // Chromium resets the zoom factor on navigation (redirect or in-page nav), so
  // re-apply the fit-zoom whenever the URL changes — otherwise the page snaps
  // back to a narrow 100% viewport after the user navigates their app.
  useEffect(() => {
    if (!tabId) return;
    lastZoomRef.current = 0;
    schedulePush();
  }, [currentUrl, tabId, schedulePush]);

  return (
    <div className='size-full flex flex-col min-h-0 bg-fill-1'>
      <div className='shrink-0 flex items-center gap-6px px-10px py-7px border-b border-b-1 bg-1'>
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
          size='small'
          value={address}
          onChange={setAddress}
          onPressEnter={navigate}
          allowClear
          placeholder={t('browser.address.placeholder')}
          className='flex-1'
        />
        <Tooltip content={t('ide.quicktest.viewportHint')}>
          <Select
            size='small'
            value={viewportWidth}
            onChange={handleViewportChange}
            prefix={<Monitor theme='outline' size={13} />}
            className='w-128px shrink-0'
            triggerProps={{ autoAlignPopupWidth: false }}
          >
            {VIEWPORT_WIDTHS.map((w) => (
              <Select.Option key={w} value={w}>
                {w === 0 ? t('ide.quicktest.viewportResponsive') : `${w}px`}
              </Select.Option>
            ))}
          </Select>
        </Tooltip>
        <Button size='small' type='primary' icon={<Redo theme='outline' size={13} />} onClick={navigate}>
          {t('browser.address.go')}
        </Button>
      </div>
      {/* The native WebContentsView paints over this region. */}
      <div ref={hostRef} className='flex-1 min-h-0 w-full bg-fill-2' aria-hidden='true' />
    </div>
  );
};

export default QuickTestBrowser;
