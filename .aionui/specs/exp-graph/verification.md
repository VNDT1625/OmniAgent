# Verification — Exp Graph / ExpBase

## Current verification status

Planning-only turn. No production code changed.

## Planning verification

- [x] Requirements file created: `.aionui/specs/exp-graph/requirements.md`
- [x] Design file created: `.aionui/specs/exp-graph/design.md`
- [x] Tasks file created: `.aionui/specs/exp-graph/tasks.md`
- [x] Verification file created: `.aionui/specs/exp-graph/verification.md`

## Phase 1 verification plan

### Schema/type tests

Validate:

- Required fields exist.
- `kind`, `status`, and verification outcomes reject invalid values.
- `confidence` stays in expected range, recommended `[0, 1]`.
- `embeddingText` is deterministic from entry content.

### Sanitization tests

Validate:

- Tokens/API keys are redacted from logs.
- Sensitive environment variables are not stored raw.
- Stack traces remain useful after redaction.

### Capture tests

Validate:

- Successful fix event creates `successful_fix` entry.
- Self-caused coding mistake creates `agent_mistake` entry.
- Failed attempt creates `failed_attempt` entry.
- Dedupe updates or links similar existing entries.

### Vector/index tests

Validate:

- New entry upserts vector with correct metadata.
- Updated entry refreshes vector.
- Archived/superseded entries are filtered or penalized.

### Retrieval/ranking tests

Validate:

- Similar symptoms return related entries.
- Same error but different framework is ranked lower or cautioned.
- Same command/subsystem boosts score.
- Low-confidence or weak-verification entries rank lower.
- Suggestions include `whyRelevant`, `caution`, and `suggestedChecks`.

## Phase 2 integration verification plan

- Simulate a failing command/test and confirm retrieval runs before proposing fix.
- Simulate successful verified fix and confirm capture runs after verification.
- Simulate wrong attempted fix and confirm failed attempt is recorded.
- Confirm workflow displays lessons as advisory, not auto-applied truth.

## Commands to run after implementation

Follow project workflow:

```bash
bun run lint:fix
bun run format
bunx tsc --noEmit
bun run test
```

If renderer UI or i18n files are touched later:

```bash
bun run i18n:types
node scripts/check-i18n.js
```

## Results log

- 2026-06-04: Planning specs created. No code verification required yet.
- 2026-06-04: Step 0 diagnosis completed. `tasks.md` is in the correct spec directory; backend task claiming likely failed because checklist items lacked explicit `[backend]` markers and claim metadata. Updated `tasks.md` to add backend/frontend markers, T0 diagnosis, and active T5 ownership metadata. Began T5 inspection and identified likely integration candidates: `packages/desktop/src/process/company/memoryStore.ts` for file-based persistence patterns and `packages/desktop/src/process/ide/vectorIndex.ts` for embedding/vector-index patterns.
- 2026-06-04: T5 completed. Confirmed initial backend integration direction: create ExpBase under `packages/desktop/src/process/experience/`, model persistence after `company/memoryStore.ts`, and model vector abstraction/ranking after `ide/vectorIndex.ts`. T6 claimed to define `ExperienceEntry` types next.

## Results log — implementation (2026-06-09)

- Engine TS hiện thực đầy đủ Phase 1 + projection MTUI + IPC bridge.
- TS tests: `tests/unit/experience/` **67/67 pass** (experienceText 18, store 8, vectorIndex 9,
  capture 13, retrieval 9, projection 8, service 7 — số xấp xỉ theo nhóm describe).
- `getDiagnostics` sạch trên toàn bộ `process/experience/*.ts`.
- `bunx tsc --noEmit`: không lỗi mới ở phạm vi exp-graph. Lỗi còn lại thuộc stream khác và có sẵn từ
  trước: `process/ide/db/dbService.ts`, `process/knowledge/realtime/rtkService.ts`,
  `renderer/pages/studio/ide/db/useDatabasePanel.ts`, `SpecManagerPanel.tsx`.
- Rust: `cargo test exp::` **5/5 pass** (tokenize, lexical similarity, search ranking, drop archived,
  filter by kind). `cargo build` OK.
- E2E smoke (debug binary): `mtui exp search` xếp entry đúng bối cảnh lên đầu (0.75) với
  why_relevant đầy đủ, entry không liên quan điểm thấp; `mtui exp add` ghi `inbox.jsonl` đúng shape
  `{receivedAt, draft}`; `mtui exp forget` ghi `forget.jsonl` + patch index → `archived`. Đã dọn file
  smoke.

## Còn lại (Phase 2/3/4 — chưa làm, ngoài phạm vi phiên này)

- Hook tự động chạy retrieval khi `mtui verify` fail / agent kẹt 2 lần (trigger có điều kiện) — hiện
  để agent chủ động gọi `mtui exp search`; bridge đã sẵn sàng cho app gọi.
- Capture tự động sau verified-fix (Phase 2 T16/T17/T18) — hiện capture qua `mtui exp add` thủ công
  hoặc bridge `experience.record`.
- Graph relations (Phase 3) và UI inspector + metrics (Phase 4) — deferred.
