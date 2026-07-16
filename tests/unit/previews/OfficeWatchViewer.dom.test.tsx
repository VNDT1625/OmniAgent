/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * N4c V8: OfficeWatchViewer export-shape smoke test.
 *
 * Design note:
 * OfficeWatchViewer mounts long-lived watch polling via useEffect. Rendering it
 * under jsdom (even with fully stubbed ipcBridge / Arco / WebviewHost) spins
 * setInterval/setTimeout cycles that don't settle inside worker-fork timeouts
 * and cause the vitest pool to hang (see plan §2.4 WS reconnect hazard).
 *
 * We therefore validate only the static module surface: exports, component
 * type, displayName-ish identity. Runtime render coverage for this file is
 * deferred to e2e (where the real watch backend is online) — this trade-off
 * is recorded in N4c-final.md Deviations.
 *
 * The module has a heavy dependency chain, so the cold import is paid ONCE in
 * `beforeAll` (with a generous hook timeout) rather than inside a per-test
 * timer, which under full-suite parallel transform pressure can exceed the
 * default 10s and cause a flaky timeout.
 */

import { describe, it, expect, beforeAll } from 'vitest';

const IMPORT_TIMEOUT_MS = 120000;

type OfficeWatchViewerModule =
  typeof import('@/renderer/pages/conversation/Preview/components/viewers/OfficeWatchViewer');

let mod: OfficeWatchViewerModule;

beforeAll(async () => {
  mod = await import('@/renderer/pages/conversation/Preview/components/viewers/OfficeWatchViewer');
}, IMPORT_TIMEOUT_MS);

describe('OfficeWatchViewer module shape', () => {
  it('module loads and exposes a default export', () => {
    expect(mod).toBeDefined();
    expect(mod.default).toBeDefined();
  });

  it('default export is a function (React component)', () => {
    expect(typeof mod.default).toBe('function');
  });

  it('module exports object has no thrown side effects during import', () => {
    expect(mod.default).toBeDefined();
    // Component functions in React typically have at most one required argument (props).
    expect((mod.default as { length: number }).length).toBeLessThanOrEqual(2);
  });
});
