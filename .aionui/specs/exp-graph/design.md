# Design — Exp Graph / ExpBase

## Summary

Exp Graph là một lớp memory chuyên cho kinh nghiệm debugging/coding. Nó biến các sự kiện sửa lỗi thành `ExperienceEntry`, lưu metadata có cấu trúc + embedding vector, rồi truy hồi các bài học gần giống khi agent gặp lỗi mới.

Thiết kế khuyến nghị triển khai theo hướng local-first:

- Store metadata: JSON/SQLite tùy hạ tầng hiện có.
- Vector index: adapter trừu tượng để dùng embedding/vector backend hiện có hoặc index local.
- Integration: hook vào workflow debugging/test-failure của agent, không trộn trực tiếp vào renderer UI.

## Integration findings from T5

T5 inspection found two existing backend patterns to reuse:

- Persistence reference: `packages/desktop/src/process/company/memoryStore.ts`
  - Main-process file storage.
  - Electron `userData` default root.
  - Injectable filesystem adapter for tests.
  - Atomic write-to-temp-then-rename pattern.
- Vector/embedding reference: `packages/desktop/src/process/ide/vectorIndex.ts`
  - Existing `Embedder` abstraction.
  - In-memory vector entry representation and cosine ranking.
  - Query interface suitable as a model for `ExperienceVectorIndex`.

Recommended initial type location for T6/T7:

```text
packages/desktop/src/process/experience/
```

Rationale:

- ExpBase is backend/main-process state and must not depend on DOM/renderer APIs.
- It can reuse Node/Electron persistence patterns.
- Renderer UI is deferred, so shared renderer-facing contracts can be added later through preload/IPC only if needed.

## Conceptual architecture

```text
Debug/Test Event
      │
      ▼
Experience Capture
  - summarize symptom/context/fix
  - sanitize secrets
  - normalize schema
      │
      ▼
Experience Store ───────► Vector Index
  metadata + history       embeddingText vectors
      │                         │
      └──────────────┬──────────┘
                     ▼
Retrieval Service
  - build query from current bug
  - vector top-K
  - metadata rerank
  - return grounded suggestions
                     │
                     ▼
Agent Debug Workflow
  - inspect candidates
  - validate context match
  - apply cautiously
  - record outcome
```

## Main components

### 1. ExperienceCaptureService

Responsibility:

- Accept raw debugging outcome events.
- Convert them to normalized `ExperienceEntryDraft`.
- Sanitize logs and paths where needed.
- Generate `embeddingText`.
- Decide whether to create new entry or update existing entry.

Inputs:

- Bug symptom/log.
- Current workspace context.
- Files touched.
- Commands run.
- Fix summary.
- Verification results.
- Agent reflection: what went wrong/right.

Outputs:

- Stored entry id.
- Dedupe/update decision.

### 2. ExperienceStore

Responsibility:

- Persist structured entries.
- Support lookup by id, tags, project, status.
- Track versions and related entries.

Suggested interface:

```ts
type ExperienceStore = {
  create(entry: ExperienceEntry): Promise<ExperienceEntry>;
  update(id: string, patch: ExperienceEntryPatch): Promise<ExperienceEntry>;
  get(id: string): Promise<ExperienceEntry | null>;
  searchMetadata(filter: ExperienceFilter): Promise<ExperienceEntry[]>;
};
```

### 3. ExperienceVectorIndex

Responsibility:

- Embed `embeddingText`.
- Upsert/delete vectors.
- Query top-K by semantic similarity.

Suggested interface:

```ts
type ExperienceVectorIndex = {
  upsert(entryId: string, text: string, metadata: VectorMetadata): Promise<void>;
  query(queryText: string, options: QueryOptions): Promise<VectorHit[]>;
  remove(entryId: string): Promise<void>;
};
```

### 4. ExperienceRetrievalService

Responsibility:

- Build query text from current problem.
- Fetch vector candidates.
- Fetch full entries from store.
- Re-rank with metadata and trust signals.
- Return concise suggestions for agent.

Ranking formula example:

```text
score = 0.55 * vectorSimilarity
      + 0.20 * contextMatch
      + 0.10 * confidence
      + 0.10 * verificationStrength
      + 0.05 * recency
      - penalties
```

Context match signals:

- Same package/framework.
- Same command failed.
- Same subsystem/path prefix.
- Same error category.
- Similar stack trace function names.

### 5. AgentWorkflowHook

Responsibility:

- On debug start: call retrieval and present relevant lessons.
- On fix success: capture successful fix.
- On failed attempt: capture lesson/failed attempt.
- On repeated false match: lower confidence or mark entry needs review.

## ExperienceEntry model

```ts
type ExperienceKind = 'successful_fix' | 'agent_mistake' | 'failed_attempt' | 'lesson';
type ExperienceStatus = 'active' | 'superseded' | 'archived';

type ExperienceEntry = {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectId: string;
  sourceSessionId?: string;
  kind: ExperienceKind;
  symptoms: {
    summary: string;
    errorMessages: string[];
    stackTraceDigest?: string;
  };
  context: {
    workspace?: string;
    repoArea: string[];
    files: string[];
    commands: string[];
    runtime?: string;
    frameworks: string[];
    packages: string[];
  };
  rootCause?: string;
  fix?: {
    summary: string;
    steps: string[];
    changedFiles: string[];
  };
  lesson: string;
  verification: {
    commands: Array<{ command: string; outcome: 'passed' | 'failed' | 'not_run'; notes?: string }>;
    confidenceEvidence: string[];
  };
  tags: string[];
  confidence: number;
  relatedEntryIds: string[];
  supersededBy?: string;
  embeddingText: string;
  status: ExperienceStatus;
};
```

## Embedding text template

```text
Kind: successful_fix
Symptoms: <summary + key error messages>
Context: <repo area, framework, commands, packages, files>
Root cause: <root cause>
Fix: <fix summary + steps>
Lesson: <lesson>
Verification: <passed commands>
Tags: <tags>
```

## Retrieval output shape

```ts
type ExperienceSuggestion = {
  entryId: string;
  score: number;
  whyRelevant: string[];
  caution: string[];
  symptom: string;
  lesson: string;
  suggestedChecks: string[];
};
```

## Workflow

### Capture after successful fix

1. Detect or receive fix-complete event.
2. Summarize before/after:
   - failing command/log before fix.
   - changed files and root cause.
   - verification passed.
3. Sanitize.
4. Dedupe search with high threshold.
5. Create/update entry.
6. Upsert vector.

### Retrieve during debugging

1. Build problem query from observed error.
2. Vector query top 10-20.
3. Filter project/status.
4. Re-rank.
5. Return top 3-5 suggestions.
6. Agent validates context before using.

## Guardrails

- Never auto-apply fix only because vector match is high.
- Require at least one concrete context match for high-impact changes.
- If current framework/version differs, show caution.
- If entry verification was weak, mark as low-confidence.
- Redact tokens, absolute personal paths if privacy setting requires it.

## Phasing

### Phase 1 — Spec and local service

- Define schema and service interfaces.
- Implement local storage + mock/vector adapter abstraction.
- Add capture/retrieval tests.

### Phase 2 — Agent workflow integration

- Hook retrieval into debugging start.
- Hook capture into fix success/failure reflection.
- Add dedupe and confidence update.

### Phase 3 — Graph layer

- Add relation types:
  - `same_symptom_as`
  - `caused_by_same_root_cause`
  - `supersedes`
  - `contradicts`
  - `applies_to`
- Use graph traversal to enrich ranking.

### Phase 4 — UI/observability

- Minimal inspector UI for reviewing entries.
- Metrics: retrieval hit rate, accepted suggestions, false matches.

## Implemented architecture — hybrid engine + MTUI gateway (2026-06-09)

Người dùng đã duyệt và yêu cầu triển khai kiến trúc **lai**. Đã hiện thực hoá:

### Tách "engine" và "mặt gọi"

- **Engine (TS, main process)** ở `packages/desktop/src/process/experience/` — sở hữu embedding,
  store, dedupe, retrieval và việc ghi file projection. Lý do: sinh embedding cần model provider,
  còn MTUI tuyên bố "No AI".
- **Mặt gọi cho agent qua MTUI** — `mtui exp search/add/get/list/forget`. MTUI AI-free: chỉ **đọc**
  file projection `.mtui/exp/index.json` rồi rank thuần Rust (lexical + metadata), 0 token/0 model.

### Files (engine, ≤10 children)

- `experienceTypes.ts` — kiểu dữ liệu + hằng validate + kiểu projection/inbox.
- `experienceText.ts` — redact secret, embeddingText tất định, lexical soup, verificationStrength.
- `experienceStore.ts` — store JSON theo từng entry (atomic, inject fs), mẫu theo `company/memoryStore.ts`.
- `experienceVectorIndex.ts` — normalize/cosine + wrapper embed (embedding OPTIONAL).
- `experienceProjection.ts` — build/read/write `.mtui/exp/index.json`, hàng đợi `inbox.jsonl`/`forget.jsonl`.
- `experienceCapture.ts` — normalize + sanitize + dedupe (lexical Jaccard ≥ 0.82, merge enrich confidence) + embed.
- `experienceRetrieval.ts` — rank: `0.5*semantic-or-lexical + 0.22*contextMatch + 0.1*confidence + 0.1*verification + 0.08*recency − statusPenalty`.
- `experienceBridge.ts` — IPC `experience.{record,search,drain,forget}`, wire ở `initAllBridges()`.
- `index.ts` — `createExperienceService` (facade per-project) + barrel.

### MTUI (Rust)

- `packages/mtui/src/exp/mod.rs` + cli `Exp(ExpArgs)` + dispatch trong `main.rs`.
- `search` rank lexical + metadata (mirror TS), lọc archived, phạt superseded, trả top-K JSON gọn.
- `add` → ghi draft vào `inbox.jsonl` (AI-free). `forget` → ghi `forget.jsonl` + patch index in-place `archived`.

### Vòng khép kín (capture → index → retrieve)

`mtui exp add` (CLI, AI-free) chỉ xếp hàng draft. Khi engine chạy `search` qua bridge, nó **drain
inbox + forget queue → embed/dedupe → rebuild projection** rồi mới rank. Nhờ vậy draft thêm bằng CLI
trở nên searchable ở lần retrieve kế tiếp.

### Trigger CÓ ĐIỀU KIỆN (chủ động + tiết kiệm)

- KHÔNG inject vào mọi query. Retrieval chỉ nên chạy khi gặp tín hiệu "bug khó": `verify`/test/typecheck
  fail, hoặc agent đã thử sửa 2 lần chưa xong (đúng ngưỡng trong `autonomous-run`).
- Hot path (`mtui exp search`) không gọi model → 0 token lúc bình thường; semantic chất lượng cao chỉ
  bật khi có provider embedding (degrade an toàn về lexical nếu không có).

### Verify

- TS: `tests/unit/experience/` 67/67 pass; `getDiagnostics` sạch toàn module; `tsc` không lỗi mới
  (các lỗi `ide/db`, `knowledge/rtkService`, `SpecManagerPanel` là của stream khác, pre-existing).
- Rust: `cargo test exp::` 5/5 pass; build OK; e2e smoke `mtui exp search/add/forget` trên index mẫu
  xác nhận serde camelCase khớp định dạng TS và ranking đúng.
