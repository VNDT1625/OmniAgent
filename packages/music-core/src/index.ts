/**
 * @aionui/music-core — headless music engine.
 *
 * Pure TypeScript: schema, engine commands, scheduler/render, audio analysis
 * (the agent's "ears"), music theory, vocal-tune planning, producer brain, and
 * the agent tool catalog. No UI, no Web Audio, no Node-only APIs here, so it is
 * safe to import from both the renderer (UI plane) and the main process / MCP
 * (agent plane). Both planes are thin clients of this core.
 *
 * NOTE: the filesystem-backed project repo (node:fs) lives in the desktop
 * process layer, not here, to keep this package renderer-safe.
 *
 * Explicit re-exports are used where two modules share a name (`Scale`,
 * `pitchClassName` exist in both analysis/key and theory/theory). The theory
 * versions are canonical; key's are exported under aliases.
 */

// Schema + data layer
export * from './shared/schema';
export * from './shared/factory';
export * from './shared/validate';
export * from './shared/migrate';
export * from './shared/ids';
export type { ProjectRepo, ProjectSummary, ImportedSampleRef } from './shared/projectRepo';

// Engine commands (shared by user UI and agent)
export * from './core/engine';
export * from './core/scheduler';
export * from './core/render';
export * from './core/wav';
export * from './core/synth';

// Analysis — the agent's ears
export * from './analysis/pitch';
export * from './analysis/chroma';
export * from './analysis/tempo';
export * from './analysis/analyze';
export * from './analysis/signal';
// key.ts shares `Scale` and `pitchClassName` with theory; export explicitly.
export { detectKey } from './analysis/key';
export type { KeyResult } from './analysis/key';

// Music theory + vocal tune planning (canonical Scale / pitchClassName)
export * from './theory/theory';
export * from './theory/tune';

// Producer brain + agent tool catalog
export * from './agent/producer';
export * from './agent/tools';
