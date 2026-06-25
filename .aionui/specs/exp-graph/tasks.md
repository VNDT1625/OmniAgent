# Tasks — Exp Graph / ExpBase

## Task checklist metadata

- Spec path: `.aionui/specs/exp-graph/`
- Workstream: backend
- Task format: each executable backend task uses `- [status] [backend] Tn — ...`
- Claim format: active tasks append `Owner: <agent>; Started: <date>`.

## Status legend

- `[ ]` pending
- `[~]` in progress
- `[x]` completed
- `[-]` deferred/out of scope

## Step 0 — Task checklist detection diagnosis

- [x] [backend] T0 — Determine why backend task claiming did not detect this checklist. Result: the spec is in the correct directory, `.aionui/specs/exp-graph/tasks.md`. The likely cause is format mismatch: the file was created before the backend task-claim guard expected explicit backend markers/claim metadata, and tasks used plain checklist items like `- [ ] T5` without `[backend]` or owner/status metadata.

## Planning tasks

- [x] [backend] T1 — Capture idea as requirements.
- [x] [backend] T2 — Draft architecture/design for ExpBase vector retrieval.
- [x] [backend] T3 — Create phased implementation checklist.
- [x] [backend] T4 — Define verification plan.

## Phase 1 — Schema and local service

- [x] [backend] T5 — Inspect existing agent/memory/vector-related code to choose exact integration points. Owner: AI assistant; Started: 2026-06-04; Completed: 2026-06-04. Findings: use `packages/desktop/src/process/company/memoryStore.ts` as the persistence pattern and `packages/desktop/src/process/ide/vectorIndex.ts` as the vector/embedding pattern.
- [x] [backend] T6 — Define `ExperienceEntry` types in the correct shared/process location. Done: `process/experience/experienceTypes.ts`.
- [x] [backend] T7 — Implement `ExperienceStore` abstraction. Done: `experienceStore.ts` (per-entry JSON, atomic write, injectable fs).
- [x] [backend] T8 — Implement local metadata persistence adapter. Done: `defaultExperienceStoreFs` + `<userData>/experience/<projectId>/entries/`.
- [x] [backend] T9 — Implement `ExperienceVectorIndex` abstraction. Done: `experienceVectorIndex.ts` (normalize/cosine/embed wrapper).
- [x] [backend] T10 — Implement a vector backend adapter or test/mock adapter. Done: reuses `ide/vectorIndex` `Embedder`; embedding OPTIONAL (degrade to lexical).
- [x] [backend] T11 — Implement `ExperienceCaptureService` with sanitization and embedding text generation. Done: `experienceCapture.ts` + `experienceText.ts` (secret redaction, deterministic embeddingText, lexical Jaccard dedupe/merge).
- [x] [backend] T12 — Implement `ExperienceRetrievalService` with vector search + metadata reranking. Done: `experienceRetrieval.ts` (semantic-or-lexical + contextMatch + confidence + verification + recency − status penalty).
- [x] [backend] T13 — Add unit tests. Done: `tests/unit/experience/` 67 tests pass (text, store, vectorIndex, capture, retrieval, projection, service).

## Phase 1b — MTUI surface + projection (hybrid architecture, implemented)

- [x] [backend] TM1 — MTUI projection layer `experienceProjection.ts` (`.mtui/exp/index.json` + `inbox.jsonl` + `forget.jsonl`).
- [x] [backend] TM2 — MTUI Rust `mtui exp search/add/get/list/forget` (`packages/mtui/src/exp/mod.rs` + cli + dispatch). AI-free lexical + metadata ranking mirroring the TS path. Rust tests 5/5 pass + e2e smoke verified.
- [x] [backend] TM3 — IPC bridge `experienceBridge.ts` (record/search/drain/forget) wired in `initAllBridges()`; `search` drains inbox + forget queue + rebuilds projection (closes capture → index → retrieve loop). Embeddings best-effort via `createDefaultEmbedder`.

## Phase 2 — Agent workflow integration

- [x] [backend] T14 — Identify debugging/fix-success/failure events. Done: `DebugEpisode` model + `workflow/experienceWorkflow.ts`.
- [x] [backend] T15 — Add retrieval hook before debug/fix planning. Done: `onVerifyOutcome` + conditional `experienceTrigger` (threshold 2 / hard-failure) + bridge `experience.verify-outcome`.
- [x] [backend] T16 — Add capture hook after successful verification. Done: `captureSuccess` (resets failure streak).
- [x] [backend] T17 — Add capture hook for failed attempts/self-caused mistakes. Done: `captureFailure` (`failed_attempt` | `agent_mistake`).
- [x] [backend] T18 — Confidence update when a suggestion helps/fails. Done: `service.recordFeedback` + `updateConfidence` (+0.05 / −0.1, clamped) + metrics.

## Phase 3 — Exp Graph relations

- [x] [backend] T19 — Relation model `same_symptom_as` / `same_root_cause` / `supersedes` / `contradicts` / `applies_to`. Done: `ExperienceRelation` in types + `workflow/experienceGraph.ts` (`inferRelations`).
- [x] [backend] T20 — Graph-aware retrieval enrichment. Done: `enrichSuggestions` attaches related lessons + contradiction caution; relations recomputed in `rebuildProjection`.
- [x] [backend] T21 — Tests for relation creation + traversal. Done: `tests/unit/experience/workflow/experienceGraph.test.ts`.

## Phase 4 — UI / observability

- [x] [backend] T23 — Metrics for retrieval hit rate + false positives. Done: `workflow/experienceMetrics.ts` (captures/retrievals/hitRate/accepted) + service integration + `experience.metrics` channel. Tests: `experienceMetrics.test.ts`.
- [x] [frontend] T22 — Review UI for entries. Done: IDE mode **ExpBase** (`renderer/pages/studio/ide/expbase/ExpBasePanel.tsx` + `experienceClient.ts`) — search, browse, feedback (helpful/not), archive, metrics strip, graph-related lessons. Arco + UnoCSS tokens + i18n (9 locales). DOM test `ExpBasePanel.dom.test.tsx`.

## Immediate next step recommendation

Continue T5. Inspect existing locations for:

- Agent session lifecycle.
- Existing memory persistence.
- Existing embedding/vector search capability.
- Existing service patterns in `packages/desktop/src/process/services/`.

Do not implement T6+ until T5 confirms correct architecture and dependencies.
