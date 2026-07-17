# Tomny Core replacement-readiness audit

> Audit date: 2026-07-17  
> Source of truth: `core.md`, current repository code, and executable tests.  
> “100%” is split into two gates because they are materially different outcomes.

## Executive result

| Gate | Result | Meaning |
| --- | --- | --- |
| Remove the downloaded legacy `aioncore.exe` from packaged/runtime selection | **Pass in code** | Packaging and binary resolution select `bundled-tomny-core/.../tomny-core[.exe]`, built from pinned source. The legacy resource folder is not listed in `extraResources`. |
| Replace the whole REST/WS compatibility backend with the new TypeScript run kernel | **Not yet pass** | Main app startup and many renderer contracts still require a compatibility backend. The direct Tomny/Codex/ACP/Remote chat path itself no longer calls that backend. |

The direct agent core is substantially complete: normalized streaming, direct adapters, model discovery, cross-adapter handoff, surface-aware MCP harnesses, workspace and permission policy, attachments/vision fallback, context/secret vault, durable checkpoints/events, retry/recovery, scheduler, telemetry/doctor, signed adapter catalog, and Team/Company orchestration all have concrete implementations.

The honest remaining work is no longer “make chat answer”. It is compatibility cutover and recovery proof for the rest of the application.

## Verified in this audit

The following targeted command passed on 2026-07-17:

```text
bunx vitest run
  tests/integration/tomnyCoreCutover.test.ts
  tests/integration/tomnyCoreLegacyIsolation.test.ts
  tests/unit/agentRuntime/contextEngine.test.ts
  tests/unit/agentRuntime/durableEventStore.test.ts
  tests/unit/agentRuntime/permissionStore.test.ts
  tests/unit/agentRuntime/coreDiagnostics
  tests/unit/scheduledTasks
  tests/unit/agentRuntime/surfaceRegistry.test.ts

13 test files passed; 89 tests passed.
```

Additional verification passed: the four AgentMesh engine/service/renderer-client suites (15 tests), and `bunx tsc --noEmit` completed with exit code 0.

Evidence confirmed directly in code:

- `experimentalCoreRuntime.ts` receives the same `AgentMeshService` registered by AgentMesh IPC.
- `ipcBridge.cron` and Cron MCP are backed by the new scheduled-task service through `LegacyCronAdapter`; the name describes its UI contract, not an AionCore dependency.
- telemetry and Core Doctor are constructed in the production experimental-core bridge and exposed through bounded IPC queries.
- the standalone acceptance test throws on access to `globalThis.__backendPort` and still proves direct CLI chat, harness injection, retry, replay, and continuation.
- build packaging selects `bundled-tomny-core`; `binaryResolver.ts` resolves `tomny-core`, not the downloaded AionCore executable.

## Capability status against `core.md`

| Core requirement | Current status | Evidence / remaining proof |
| --- | --- | --- |
| Built-in / ACP / CLI / Remote adapters | Implemented | Tomny, Codex app-server, generic ACP, and Remote adapters are outside the kernel. Per-target live acceptance is still required for every declared third-party CLI. |
| Normalized ordered streaming | Implemented | Delta, status, thinking, step, tool, permission, completion, error, and cancellation events are normalized and sequenced. |
| Restart, checkpoint, replay | Implemented for solo sessions | Session checkpoints and append-only event journal pass recovery tests. Long-running process-kill soak coverage remains. |
| Context and secret context | Implemented | Personal/agent layers, secret handles, policy resolution, and redaction have tests. |
| Attachment and image fallback | Implemented | Typed envelopes, artifact storage, adapter mapping, and explicit `tomny_analyze_image` fallback exist; live provider matrix remains acceptance work. |
| Surface capability broker | Implemented | IDE, Browser, Office, Music, and future manifests inject selected MCP hosts without adapter-specific surface branches. |
| Permissions and audit | Implemented for direct core | Durable scoped grants/audit exist; every provider/tool combination still needs live matrix validation. |
| Scheduler / Cron | Implemented and wired | Cron renderer contract and MCP share the scheduled-task service. Missed triggers, retry, overlap, cancel, and audit are tested. |
| Telemetry / Doctor | Implemented and wired | Redacted hash-chain telemetry plus health/P95 report are exposed by IPC. |
| Adapter update/rollback | Implemented locally | Schema, compatibility range, hash/signature validation, active/previous rollback, and revision pinning exist. A production download/key-distribution channel is intentionally outside the kernel. |
| Team/Company shared engine | Implemented in the test core | Runtime and IPC share one AgentMesh service; Company and temporary Team execute through it. UI acceptance is being completed separately. |
| Agent communication and queue control | Implemented | Grants, agent-to-agent messages, send-now/queue, edit/delete/reorder, graceful/interrupt/cancel, inspection, worklog, heartbeat, and watchdog exist. |
| Durable Team/Company recovery | **Incomplete** | AgentMesh appends events, but `AgentMeshService` keeps its controller registry in memory and does not rebuild a session/controller from the journal after process restart. |
| Compatibility REST/WS v1 | Supplied by source-built Tomny Core | The new TypeScript kernel does not yet implement all old routes/events; retaining the source-built compatibility process is currently required for the full app. |
| Import/export and rollback | Implemented for core-owned state | Checksummed bundle covers sessions, events, context, and permissions with rollback on partial failure. Full legacy SQLite migration remains separate. |
| Artifact signing and SBOM | Implemented in build pipeline | CycloneDX SBOM, artifact hashes, optional Ed25519 signature, and fail-closed required-signature policy have tests. Production must set the required signing policy/key. |

## Real blockers to a backend-free application

These are the only blockers that prevent claiming the TypeScript core has replaced the complete compatibility backend.

### 1. Renderer compatibility surface still routes to backend HTTP/WS

`packages/desktop/src/common/adapter/ipcBridge.ts` still contains 231 HTTP/WS helper references. Remaining backend-owned groups include:

- conversations, messages, confirmations, artifacts, and database search;
- persistent Team CRUD/session/list events;
- filesystem, skills, file watch, snapshots, and Office previews;
- MCP catalog/OAuth and custom ACP-agent management;
- remote-agent configuration CRUD;
- assistants, extensions, channels, hub, STT, settings, and WebUI credentials.

This is not a defect in direct chat. It means global backend deletion requires either migrating those contracts to Electron services or retaining the source-owned Tomny compatibility runtime.

### 2. Application lifecycle still requires the compatibility process

`packages/desktop/src/index.ts` still calls `startBackendOrExit`, publishes `__backendPort`, seeds the admin user, and uses the port for WebUI/channel lifecycle. Therefore “app boots with no backend process” is not yet a valid acceptance claim.

### 3. AgentMesh cannot reconstruct active orchestration after process death

The journal prevents silent history loss, but the in-memory controller registry has no event-to-controller rehydration path. Required gate: kill the main process while a queued or leased subagent task is active, restart, rebuild the mesh, and deterministically resume or terminate without dropping queued messages.

### 4. Source-build provenance has one reproducibility gap

The staged `bundled-tomny-core` manifest records a source repository, while the current build recipe uses a different repository URL and the cache-match check validates version/commit/recipe but not repository identity. The build recipe must pin and validate repository identity together with commit before treating a cached runtime as reproducible.

## Replacement policy

- The downloaded legacy executable must never be a fallback for new-core chat or packaging.
- The source-built `tomny-core` compatibility runtime may remain while unmigrated app contracts exist; this is source ownership, not dependence on the opaque legacy executable.
- Do not describe the whole application as backend-free until all four blockers above have executable acceptance tests.
- A new adapter must continue to be added through the catalog/interface without modifying the run kernel.

## Final cutover gates

1. AgentMesh process-death rehydration test passes with queued and leased messages.
2. Every remaining HTTP/WS group is migrated or explicitly accepted as a Tomny compatibility service.
3. Desktop and WebUI boot tests pass with the chosen deployment contract and no `aioncore.exe` fallback.
4. Source-build cache rejects repository/commit mismatch; release build requires signed provenance.
5. Full typecheck and the complete test suite pass after all concurrent branches settle.

Until those gates pass, the precise status is: **legacy opaque executable replacement achieved; complete TypeScript backend replacement not yet achieved**.
