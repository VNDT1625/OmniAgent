# Design — Realtime Knowledge (RTK)

## Summary

RTK là lớp memory cho **dữ kiện dễ lỗi thời**. Nó lưu mỗi dữ kiện thành `KnowledgeFact` (giá trị +
nguồn + thời điểm hiệu lực + TTL), lập chỉ mục vector để truy hồi ngữ nghĩa, **tự refresh theo lịch**,
và **tự sửa khi phát hiện lỗi thời trong lúc chat** (luôn verify trước khi ghi đè). Mục tiêu: khi
người dùng hỏi, AI nhận được dữ kiện **đã được gắn nguồn + độ tươi**, và nếu dữ kiện cũ thì hệ tự cập
nhật rồi mới trả lời.

Triển khai **local-first, Main-process, TypeScript thuần** — KHÔNG sửa aioncore (Rust). Tái dùng tối
đa hạ tầng có sẵn để tránh rework.

## Integration findings (bám code thật)

Các pattern/module có sẵn được tái dùng:

- **Vector/embedding:** `packages/desktop/src/process/ide/vectorIndex.ts`
  - `Embedder` abstraction (`embed(texts) => number[][]`), `cosine`, `createVectorRanker`,
    `isVectorIndexFresh`. RTK tạo `RealtimeVectorIndex` theo đúng shape này (in-memory + persist).
- **Crawl/extract:** `packages/desktop/src/process/services/contentExtract/`
  - Facade `getContentExtractService().extract({ kind: 'auto' | 'html' | 'file', ... })` → Markdown/text.
- **Verify đa nguồn:** `packages/desktop/src/process/browser/research/deepResearch.ts`
  - `IDeepResearch.research(question, { model, signal }) => { answer, sources[] }` (có citation,
    đi qua hidden-tab + lease). Dùng để verify giá trị mới với ≥1 nguồn độc lập.
- **Persistence:** `packages/desktop/src/process/company/memoryStore.ts`
  - File store ở Electron `userData`, fs adapter injectable, atomic write-tmp-then-rename.
- **Scheduler nền:** pattern `croner` đã dùng ở `process/terminal/terminalScheduler.ts` /
  `process/cron/` → tái dùng cho refresh định kỳ.
- **MCP built-in:** pattern `process/resources/builtinMcp/*Server.ts` + host/wiring/register ở
  `runBackendMigrations.ts` → expose tool `rtk_*` cho agent.
- **Embedder dùng chung:** `process/toolselect/semanticFilter.ts` cũng định nghĩa `Embedder` — RTK
  dùng cùng kiểu để inject model nhỏ/local ở production.

### Vị trí code khuyến nghị

```text
packages/desktop/src/process/knowledge/realtime/
  rtkTypes.ts            # PURE: KnowledgeFact, Relation, enums, no I/O
  freshness.ts           # PURE: tính freshness/expiresAt theo TTL + validAsOf
  embeddingText.ts       # PURE: build embeddingText template từ fact
  rtkStore.ts            # persist (memoryStore pattern, fs DI)
  rtkVectorIndex.ts      # RealtimeVectorIndex (vectorIndex.ts pattern)
  refreshPipeline.ts     # crawl→extract→verify→diff (DI contentExtract + deepResearch)
  verificationService.ts # PURE-ish: chấm bằng chứng, quyết định ghi đè
  staleDetector.ts       # PURE: phát hiện fact lỗi thời từ ngữ cảnh chat
  rtkService.ts          # facade singleton ghép store+index+pipeline
  rtkScheduler.ts        # croner: quét expired → refresh (lease-aware)
```

MCP + bridge (file riêng, tách process boundary):

```text
packages/desktop/src/process/resources/builtinMcp/realtimeKnowledgeServer.ts
packages/desktop/src/process/knowledge/realtimeKnowledgeMcpHost.ts
packages/desktop/src/process/knowledge/realtimeKnowledgeMcpWiring.ts
packages/desktop/src/process/knowledge/registerRealtimeKnowledgeMcp.ts
```

Lý do: RTK là state backend/main-process, KHÔNG phụ thuộc DOM/renderer. UI hoãn — chỉ thêm qua
preload/IPC nếu cần ở phase sau.

## Conceptual architecture

```text
User query ──► Retrieval ──► Grounding pack ──► Agent/LLM
                  │  (facts + freshness + sources)      │
                  ▼                                      │
            RTK Store ◄────► RealtimeVectorIndex         │ (phát hiện lỗi thời / mâu thuẫn)
                  ▲                                      ▼
                  │                              Stale Detector (cơ chế c)
          Refresh Pipeline ◄──────────────────────────┤
       crawl→extract→verify→diff                       │
                  ▲                                     ▼
            RTK Scheduler (cơ chế b)            Verification Service (FR7)
        croner quét expiresAt<=now              ≥1 nguồn độc lập, đủ mạnh
                                                        │
                                                        ▼
                                          Update fact + push history + reindex
```

## Main components

### 1. rtkTypes.ts (PURE)

Khai báo `KnowledgeFact`, `KnowledgeRelation`, các enum `VolatilityClass`, `Freshness`, `FactStatus`.
Không I/O, dễ test.

```ts
type VolatilityClass = 'version' | 'price' | 'role_holder' | 'spec_api' | 'status_event' | 'stat_metric' | 'other';
type Freshness = 'fresh' | 'stale' | 'expired' | 'unknown';
type FactStatus = 'active' | 'superseded' | 'needs_review' | 'archived';

type FactSource = { url: string; title?: string; fetchedAt: string; snippet?: string };

type KnowledgeFact = {
  id: string;
  createdAt: string;
  updatedAt: string;
  topic: string;
  question: string;
  aliases: string[];
  value: string;
  volatilityClass: VolatilityClass;
  ttlMs: number;
  validAsOf: string;
  expiresAt: string;
  sources: FactSource[];
  confidence: number;
  freshness: Freshness;
  history: Array<{ value: string; validAsOf: string; sources: FactSource[]; changedAt: string; reason: string }>;
  tags: string[];
  embeddingText: string;
  status: FactStatus;
};

type KnowledgeRelation = {
  fromId: string;
  toId: string;
  kind: 'supersedes' | 'contradicts' | 'depends_on' | 'same_topic_as' | 'derived_from';
};
```

### 2. freshness.ts (PURE)

`computeFreshness(fact, now)` → `Freshness`; `computeExpiresAt(validAsOf, ttlMs)`. TTL mặc định theo
`VolatilityClass` (vd `version` ngắn, `role_holder` dài). Không phụ thuộc clock thật (inject `now`).

### 3. embeddingText.ts (PURE)

Template gom `topic + question + aliases + value + tags` thành chuỗi để embed (giống template trong
`exp-graph/design.md`), giúp semantic search bám câu hỏi của người dùng.

### 4. RTKStore (rtkStore.ts)

Theo `memoryStore.ts`: lưu JSON ở `<userData>/knowledge/realtime/facts.json` (fs DI, atomic
tmp→rename). API:

```ts
type RTKStore = {
  upsert(fact: KnowledgeFact): Promise<KnowledgeFact>;
  patch(id: string, patch: Partial<KnowledgeFact>): Promise<KnowledgeFact>;
  get(id: string): Promise<KnowledgeFact | null>;
  byTopic(topic: string): Promise<KnowledgeFact | null>;
  list(filter?: { status?: FactStatus; expiredBefore?: string }): Promise<KnowledgeFact[]>;
};
```

### 5. RealtimeVectorIndex (rtkVectorIndex.ts)

Theo `vectorIndex.ts`: in-memory entries `{ id, vector, metadata }` + `cosine` ranking; persist cạnh
store; `upsert/query/remove`; dùng `Embedder` injectable.

### 6. RefreshPipeline (refreshPipeline.ts)

DI `contentExtract` + `deepResearch`. Với một fact:

1. Dựng câu hỏi refresh từ `fact.question`/`topic`.
2. `deepResearch.research(question)` (hoặc `extract` URL nguồn cũ) → giá trị ứng viên + sources.
3. `diff` với giá trị hiện tại.
4. Gọi `VerificationService` quyết định ghi đè / `needs_review`.

Có timeout, backoff, tôn trọng lease (ResourceCoordinator) — refresh là việc "nặng".

### 7. VerificationService (verificationService.ts)

Chấm bằng chứng (số nguồn, nhất quán, uy tín) → quyết định:

- `accept` (đủ mạnh) → update value, đẩy cũ vào `history`, set `validAsOf` từ nguồn, reindex.
- `reject` → giữ nguyên, có thể hạ confidence.
- `review` → `status='needs_review'` kèm bằng chứng đối nghịch.

Guardrail FR7: KHÔNG ghi đè khi chưa verify; KHÔNG dùng "model nghĩ vậy" làm bằng chứng.

### 8. StaleDetector (staleDetector.ts, PURE)

Đầu vào: fact đã dùng + tín hiệu từ chat (TTL hết, bằng chứng mới trong hội thoại mâu thuẫn). Đầu ra:
`shouldVerify: boolean` + lý do. Tách PURE để test, không tự gọi mạng.

### 9. RTKService (rtkService.ts) — facade

Ghép store + index + pipeline + verify. API chính:

```ts
type RTKService = {
  lookup(query: string, opts?: { topK?: number }): Promise<GroundingPack>;
  record(draft: FactDraft): Promise<KnowledgeFact>;       // có verify
  refresh(id: string): Promise<KnowledgeFact>;            // 1 fact
  refreshExpired(now?: Date): Promise<{ refreshed: number; review: number }>;
};

type GroundingPack = {
  facts: Array<{ fact: KnowledgeFact; score: number; freshness: Freshness; whyRelevant: string[] }>;
  notice?: string; // vd "1 dữ kiện đã hết hạn, đang xác minh lại"
};
```

### 10. RTKScheduler (rtkScheduler.ts)

`croner` chạy nền (vd mỗi 6h, cấu hình được): gọi `refreshExpired()`, lease-aware, backoff khi lỗi.
Không chặn UI; degrade an toàn khi offline.

### 11. MCP tools (realtimeKnowledgeServer.ts)

- `rtk_lookup(query)` → grounding pack (đọc).
- `rtk_record(draft)` → ghi có verify.
- `rtk_refresh(topicOrId)` → ép refresh.

Đăng ký qua host/wiring/register ở `runBackendMigrations.ts` (catalog `enabled:false` mặc định, opt-in).

## Luồng hoạt động (ánh xạ 4 cơ chế người dùng yêu cầu)

### (a) Lưu + truy hồi qua vector index thông minh

`lookup(query)` → embed query → `RealtimeVectorIndex.query` top-K → load fact từ store → gắn
freshness + sources → trả `GroundingPack` cho AI. AI thấy rõ dữ kiện nào tươi/cũ và nguồn ở đâu.

### (b) Crawl định kỳ tự cập nhật

`RTKScheduler` quét `expiresAt <= now` → `RefreshPipeline` crawl/verify → update + reindex. Đây là
"một thời điểm nhất định chính hệ tự cập nhật".

### (c) Tự phát hiện + tự sửa trong lúc chat (có verify trước)

Trong một lượt chat, sau khi `lookup` cấp dữ kiện cho AI: nếu `StaleDetector` thấy fact đã `expired`
hoặc mâu thuẫn bằng chứng mới → chạy `VerificationService` (deepResearch) → nếu xác nhận thì update
rồi để AI trả lời bằng giá trị mới; nếu không đủ bằng chứng thì giữ cũ + `needs_review`.

### (d) Luồng tổng

```text
query → lookup(RTK) → GroundingPack → AI
   → AI/Detector phát hiện lỗi thời → verify (≥1 nguồn) → update + reindex → AI trả lời (đã cập nhật)
```

## Guardrails

- Không auto-ghi-đè chỉ vì vector match cao hoặc model "nghĩ" khác — phải verify nguồn.
- Luôn giữ `history`; `validAsOf` lấy từ nguồn, không phải lúc ghi.
- Mâu thuẫn không giải được → `needs_review`, không xoá giá trị cũ.
- Sanitize secret/token; crawl ngoài workspace cần opt-in.
- Việc nặng (crawl/deepResearch) đi qua lease/ResourceCoordinator.

## Phasing

### Phase 1 — Lõi PURE + store + index (không mạng)

`rtkTypes`, `freshness`, `embeddingText`, `rtkStore`, `rtkVectorIndex` + test. Cơ chế (a) chạy được
với fact nhập thủ công / mock.

### Phase 2 — Refresh pipeline + verify + scheduler (cơ chế b)

`refreshPipeline`, `verificationService`, `rtkScheduler` (DI contentExtract/deepResearch). Crawl định
kỳ + verify.

### Phase 3 — In-chat self-update (cơ chế c) + MCP tools (cơ chế d, FR10)

`staleDetector`, nối `rtkService.lookup` vào luồng grounding chat, MCP `rtk_*`.

### Phase 4 — Graph relations + inspector UI (hoãn)

Quan hệ `supersedes/contradicts/depends_on…` enrich ranking; inspector tối thiểu (Arco) review fact +
metrics (hit rate, số lần tự cập nhật, false update).

## Testing strategy

- PURE modules (`freshness`, `embeddingText`, `staleDetector`, `verificationService` logic): unit test
  thuần, deterministic (inject `now`).
- `rtkStore`/`rtkVectorIndex`: test với fs/Embedder mock (theo pattern `vectorIndex`/`memoryStore`).
- `refreshPipeline`: mock `contentExtract`/`deepResearch`, assert diff + quyết định verify.
- MCP server: test tool I/O giống `tests/unit/...Server` hiện có.
- Tuân thủ: tsc sạch, không Node API ở renderer (RTK ở main), i18n cho mọi chuỗi UI ở Phase 4.
