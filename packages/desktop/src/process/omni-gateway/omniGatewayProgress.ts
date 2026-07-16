/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Progress events for the Omni External MCP Gateway "Web Access" startup flow.
 *
 * The Web Access toggle in Settings can spend many seconds inside one of
 * `installing-cloudflared` (first run, downloads a ~5MB binary) or
 * `waiting-tunnel-url` (every run, Cloudflare's edge has to assign a public
 * hostname). Without per-phase feedback the UI looked frozen, so this module
 * defines a small, transport-neutral event shape that the lifecycle code emits
 * and the Settings panel subscribes to over IPC.
 *
 * Pure types + a tiny helper — no Electron, no DOM, safe to import from
 * tests and from the renderer DTO layer.
 *
 * Process boundary: Main-process. The renderer receives these events via the
 * `omniGateway.progress` emitter declared in `common/adapter/ipcBridge.ts`.
 */

/**
 * Discrete startup / shutdown phases. Ordered roughly from boot to ready:
 *  - `idle`                   nothing in flight (initial state)
 *  - `checking-cloudflared`   probing `cloudflared --version`
 *  - `installing-cloudflared` downloading the binary on demand (slow, ~5MB)
 *  - `minting-token`          generating the External Bearer token (instant)
 *  - `spawning-tunnel`        spawning `cloudflared tunnel ...`
 *  - `waiting-tunnel-url`     process is up, waiting for the public URL line
 *  - `ready`                  tunnel up, URL available
 *  - `failed`                 something blew up (carries `error`)
 *  - `stopping` / `stopped`   user disabled Web Access
 */
export type OmniGatewayProgressPhase =
  | 'idle'
  | 'checking-cloudflared'
  | 'installing-cloudflared'
  | 'minting-token'
  | 'spawning-tunnel'
  | 'waiting-tunnel-url'
  | 'ready'
  | 'failed'
  | 'stopping'
  | 'stopped';

/** Single progress data point emitted to the renderer. */
export type OmniGatewayProgressEvent = {
  phase: OmniGatewayProgressPhase;
  /** Optional human-readable detail; usually filled in by the renderer via i18n. */
  message?: string;
  /** Wall-clock timestamp (ms) — useful for sequencing and dedup. */
  at: number;
  /** Set on `ready` so the UI can immediately render the public URL. */
  tunnelUrl?: string;
  /** Set on `failed` with the underlying error message. */
  error?: string;
};

/**
 * Phases that represent "in-flight" work — used by the renderer to decide
 * whether to keep the progress strip visible. `ready` / `stopped` are
 * terminal-success, `failed` is terminal-error, `idle` means nothing happening.
 */
export const OMNI_GATEWAY_INFLIGHT_PHASES: ReadonlySet<OmniGatewayProgressPhase> = new Set<OmniGatewayProgressPhase>([
  'checking-cloudflared',
  'installing-cloudflared',
  'minting-token',
  'spawning-tunnel',
  'waiting-tunnel-url',
  'stopping',
]);

/** Callback shape accepted by the tunnel layer to surface progress upward. */
export type OmniGatewayProgressSink = (event: OmniGatewayProgressEvent) => void;

/**
 * Convenience factory: returns a function that emits to `sink` with the
 * current time pre-stamped. Keeps every call site to a one-liner like
 * `emit('checking-cloudflared')`.
 */
export const makeProgressEmitter = (
  sink: OmniGatewayProgressSink | undefined,
  now: () => number = Date.now
): ((phase: OmniGatewayProgressPhase, extra?: { message?: string; tunnelUrl?: string; error?: string }) => void) => {
  return (phase, extra) => {
    if (!sink) return;
    sink({
      phase,
      at: now(),
      message: extra?.message,
      tunnelUrl: extra?.tunnelUrl,
      error: extra?.error,
    });
  };
};
