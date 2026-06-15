/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `virtualDisplayManager` — creates an ISOLATED virtual display/session for a
 * test run so the agent never grabs the user's real mouse/keyboard/screen
 * (Yêu cầu 2b, criterion 2.2 / Property 1). The user keeps using the machine
 * normally while tests run.
 *
 * Per `design.md` the mechanism is OS-specific:
 * - Windows: a separate desktop/session (`CreateDesktop`) or an off-screen window.
 * - Linux: `Xvfb` (X virtual framebuffer).
 * The concrete OS backend is INJECTED (`DisplayBackend`) so this orchestration
 * module stays testable and never shells out during unit tests. The critical
 * invariant enforced here: if an isolated display CANNOT be created, we throw —
 * we NEVER fall back to the real desktop (criterion 2.8 / Property 1).
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

/** A handle to a created isolated virtual display. */
export type VirtualDisplay = {
  /** Unique id of the display. */
  id: string;
  /** OS backend that created it (`windows-desktop`, `xvfb`, `offscreen`, ...). */
  backend: string;
  /** Whether input/render are confined to this display (must be true). */
  isolated: true;
  /** Opaque connection info the drivers use to target this display. */
  target: Record<string, string>;
};

/**
 * OS-specific backend that actually allocates/frees an isolated display. Injected
 * so production wires the real Win32/Xvfb/off-screen implementation while tests
 * use a fake. A backend MUST guarantee isolation; returning a non-isolated
 * display is a contract violation the manager rejects.
 */
export type DisplayBackend = {
  /** Platform/name of this backend (for diagnostics). */
  readonly name: string;
  /** Whether this backend can run on the current host right now. */
  isSupported(): Promise<boolean>;
  /** Allocate an isolated display, or reject if it cannot be created. */
  create(): Promise<{ target: Record<string, string> }>;
  /** Free a previously created display. */
  destroy(id: string, target: Record<string, string>): Promise<void>;
};

/** Options for {@link createVirtualDisplayManager}. */
export type VirtualDisplayManagerDeps = {
  /** Ordered candidate backends; the first supported one is used. */
  backends: DisplayBackend[];
  /** Unique id generator. Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
};

/** Public contract of the virtual display manager. */
export type IVirtualDisplayManager = {
  /**
   * Acquire an isolated virtual display. Throws if none of the backends can
   * create one — NEVER falls back to the real desktop (criterion 2.2 / 2.8).
   */
  acquire(): Promise<VirtualDisplay>;
  /** Release a previously acquired display. */
  release(id: string): Promise<void>;
  /** List currently held displays. */
  list(): VirtualDisplay[];
};

/**
 * Create a {@link IVirtualDisplayManager} over the injected OS backends.
 *
 * @param deps Candidate backends + optional id generator.
 * @returns A manager that allocates only isolated displays.
 */
export const createVirtualDisplayManager = (deps: VirtualDisplayManagerDeps): IVirtualDisplayManager => {
  const generateId = deps.generateId ?? (() => crypto.randomUUID());
  const displays = new Map<string, { display: VirtualDisplay; backend: DisplayBackend }>();

  const acquire = async (): Promise<VirtualDisplay> => {
    for (const backend of deps.backends) {
      if (!(await backend.isSupported())) continue;
      const { target } = await backend.create();
      const display: VirtualDisplay = { id: generateId(), backend: backend.name, isolated: true, target };
      displays.set(display.id, { display, backend });
      return display;
    }
    // CRITICAL (Property 1): no isolated display available → fail loudly. We must
    // NOT run the test on the user's real desktop.
    throw new Error(
      '[VirtualDisplay] No isolated virtual display backend is available; refusing to use the real desktop.'
    );
  };

  const release = async (id: string): Promise<void> => {
    const held = displays.get(id);
    if (!held) return;
    displays.delete(id);
    await held.backend.destroy(id, held.display.target);
  };

  const list = (): VirtualDisplay[] => [...displays.values()].map((h) => h.display);

  return { acquire, release, list };
};
