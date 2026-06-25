# Tasks — Realtime Knowledge (RTK)

> Quy ước: `[ ]` chưa làm · `[x]` xong · `[-]` bỏ qua (ghi lý do ở `.kiro/status.md`).
> Mỗi task ghi rõ file được phép tạo/sửa để chạy song song an toàn (xem `subagent-parallel.md`).
> Ràng buộc chung: Main-process only (không Node API ở renderer), KHÔNG sửa aioncore, fs/Embedder/
> network đều DI để test được, tsc sạch trong phạm vi file.
>
> **TRẠNG THÁI: HOÀN TẤT 4 phase.** Tất cả test pass (72/72 trong `tests/unit/knowledge`), tsc sạch
> cho mọi file RTK (các lỗi tsc còn lại đều pre-existing ở feature khác). Xem `.kiro/status.md`.

## Phase 1 — Lõi PURE + store + index

- [x] 1.1 `rtkTypes.ts` — `KnowledgeFact`, `KnowledgeRelation`, enums (PURE).
- [x] 1.2 `freshness.ts` — `computeFreshness`/`computeExpiresAt`/`needsRefresh`/`resolveTtlMs` (PURE).
- [x] 1.3 `embeddingText.ts` — template build `embeddingText` (PURE).
- [x] 1.4 `rtkStore.ts` — persist JSON ở userData (pattern `memoryStore`, fs DI, atomic).
- [x] 1.5 `rtkVectorIndex.ts` — `RealtimeVectorIndex` (pattern `vectorIndex.ts`, Embedder DI, cosine).
- [x] 1.6 Test Phase 1 — freshness/embeddingText/rtkStore/rtkVectorIndex.

## Phase 2 — Refresh pipeline + verify + scheduler

- [x] 2.1 `verificationService.ts` — accept/reject/review, đếm nguồn độc lập + agreement.
- [x] 2.2 `refreshPipeline.ts` — crawl→extract→verify→diff, DI researcher + extractValue.
- [x] 2.3 `rtkScheduler.ts` — croner quét expired → sweep, re-entrancy guard + backoff.
- [x] 2.4 `rtkService.ts` — facade lookup/record/refresh/refreshExpired (+relate/list ở Phase 4).
- [x] 2.5 Test Phase 2 — verificationService/refreshPipeline/rtkService (mock network).

## Phase 3 — In-chat self-update + MCP tools

- [x] 3.1 `staleDetector.ts` — phát hiện fact lỗi thời từ ngữ cảnh chat (PURE).
- [x] 3.2 `realtimeKnowledgeServer.ts` — MCP `rtk_lookup`/`rtk_record`/`rtk_refresh` (SSE in-process).
- [x] 3.3 host/wiring/register — `realtimeKnowledgeMcpHost/McpWiring` + `registerRealtimeKnowledgeMcp` + `rtkWiring`/`rtkEmbedder`.
- [x] 3.4 Bootstrap — `runBackendMigrations.ts` thêm bước `ensureRealtimeKnowledgeMcpRegistered`.
- [x] 3.5 Grounding chat — `superGuidance.ts` thêm `REALTIME_KNOWLEDGE_TOOLS_RULES` + `withRealtimeKnowledgeRules`
  (agent là người crawl: lookup trước → verify bằng web/browser tool → record có guardrail).
- [x] 3.6 Test Phase 3 — staleDetector + realtimeKnowledgeServer (MCP in-memory client).

## Phase 4 — Graph relations + inspector UI

- [x] 4.1 Quan hệ `KnowledgeRelation` — `relate()` + lookup ẩn fact bị `supersedes`, cảnh báo `contradicts`.
- [x] 4.2 Inspector UI — `renderer/pages/knowledge/` (page + hook + client + FactCard/FreshnessBadge),
  bridge `realtimeKnowledgeBridge` (wire `initAllBridges`), route `/settings/knowledge` + nav (icon Refresh, desktop-only).
- [x] 4.3 Test + i18n — DOM test `RealtimeKnowledgePage.dom.test.tsx`; module i18n `realtimeKnowledge` 9 locale,
  `i18n:types` + `check-i18n` không thiếu key cho module.

## Checkpoints

- [x] **CP1 (Phase 1):** tsc sạch + test PURE/store/index pass → cơ chế (a) hoạt động với mock.
- [x] **CP2 (Phase 2):** refresh + verify + scheduler với network mock → cơ chế (b) + guardrail (FR7).
- [x] **CP3 (Phase 3):** in-chat self-update + MCP `rtk_*` → cơ chế (c)+(d) end-to-end.
