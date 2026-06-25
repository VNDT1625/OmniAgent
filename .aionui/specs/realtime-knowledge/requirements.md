# Requirements — Realtime Knowledge (RTK)

## Goal

Xây một lớp **kiến thức theo thời gian thực** (Realtime Knowledge, viết tắt RTK) để chống lại
vấn đề AI trả lời bằng kiến thức **lỗi thời**. Những thông tin có thể thay đổi theo thời gian
(phiên bản phần mềm mới nhất, giá, người giữ chức vụ, API/spec đang đổi, tỉ giá, trạng thái sự kiện…)
được lưu dưới dạng **graph có nguồn + thời điểm hiệu lực**, lập chỉ mục **vector** để truy hồi ngữ
nghĩa, tự động **crawl cập nhật theo lịch**, và **tự sửa khi phát hiện lỗi thời ngay trong lúc chat**
(có verify trước khi ghi đè).

RTK khác với spec `exp-graph` (ExpBase):

- `exp-graph` = ghi nhớ **kinh nghiệm debug/coding** của agent (bug → fix → bài học).
- `realtime-knowledge` = ghi nhớ **sự kiện/dữ kiện thế giới dễ lỗi thời**, có nguồn và hạn dùng.

Hai hệ dùng chung hạ tầng `Embedder` + vector index nhưng tách store và vòng đời.

## Scope

### In scope

- Mô hình `KnowledgeFact` (dữ kiện) + `KnowledgeRelation` (graph) có:
  - giá trị hiện tại, nguồn (URL/citation), thời điểm thu thập, độ tin cậy, **TTL/độ tươi**.
  - lịch sử thay đổi (versioning) để biết giá trị từng đổi ra sao.
- Vector index trên `embeddingText` của fact để semantic search theo câu hỏi.
- **Cơ chế (a) — Lưu + truy hồi:** query người dùng → search RTK → gom fact liên quan + metadata
  độ tươi/nguồn → đưa vào ngữ cảnh cho AI.
- **Cơ chế (b) — Crawl định kỳ:** scheduler tự refresh các fact quá hạn TTL bằng pipeline
  crawl/extract/verify, rồi cập nhật store + reindex.
- **Cơ chế (c) — Tự sửa trong lúc chat:** khi AI/luồng phát hiện một fact đã lỗi thời (hoặc mâu
  thuẫn bằng chứng mới), hệ **verify** trước rồi mới cập nhật; không ghi đè mù.
- **Cơ chế (d) — Luồng hoạt động đầy đủ:** query → retrieve → ground → phát hiện lỗi thời → verify
  → update → reindex → trả kết quả đã cập nhật.
- Guardrail: chỉ ghi đè khi có **bằng chứng nguồn đủ mạnh**; giữ giá trị cũ trong lịch sử; gắn cờ
  `needs_review` khi mâu thuẫn không giải được.
- Sanitize: không lưu secret/token; tôn trọng opt-in cho việc crawl ra ngoài workspace.

### Out of scope (phase đầu)

- Sửa Rust backend aioncore (RTK là service Main-process TypeScript, tái dùng hạ tầng có sẵn).
- Đồng bộ cloud/team-wide knowledge base.
- Fine-tune model.
- UI quản trị phức tạp (chỉ inspector tối thiểu ở phase sau).
- Crawl quy mô lớn/scraping vi phạm điều khoản; chỉ dùng `contentExtract`/`deepResearch` sẵn có.

## Functional requirements

### FR1 — Phân loại kiến thức lỗi-thời-được (volatility tagging)

Hệ phải đánh dấu fact là **volatile** (có thể đổi theo thời gian) kèm `volatilityClass`
(`version` | `price` | `role_holder` | `spec_api` | `status_event` | `stat_metric` | `other`)
và TTL mặc định theo lớp. Kiến thức **bất biến** (định lý, lịch sử đã chốt) không vào RTK.

### FR2 — KnowledgeFact schema

Mỗi fact lưu tối thiểu:

- `id`, `createdAt`, `updatedAt`
- `topic` (chủ đề chuẩn hoá, vd `nodejs.lts.version`)
- `question` / `aliases`: các cách hỏi tương đương
- `value`: giá trị hiện tại (text/structured)
- `volatilityClass`, `ttlMs`, `validAsOf` (thời điểm giá trị đúng), `expiresAt`
- `sources`: danh sách `{ url, title, fetchedAt, snippet }`
- `confidence` (0..1)
- `freshness`: `fresh` | `stale` | `expired` | `unknown`
- `history`: mảng `{ value, validAsOf, sources, changedAt, reason }`
- `tags`, `embeddingText`
- `status`: `active` | `superseded` | `needs_review` | `archived`

### FR3 — Vector indexing

Hệ phải sinh embedding từ `embeddingText` (qua `Embedder` injectable, tái dùng pattern
`process/ide/vectorIndex.ts`) và hỗ trợ `upsert` / `query` top-K / `remove`.

### FR4 — Retrieval + grounding

Khi nhận query, hệ phải:

- Sinh query text, vector top-K, lọc theo `status`/`topic`.
- Trả về fact kèm **freshness + nguồn + validAsOf** để AI biết độ tin cậy.
- Khi fact `expired`/`stale`, đánh dấu rõ để luồng quyết định refresh.

### FR5 — Scheduled crawl/refresh (cơ chế b)

Phải có scheduler chạy nền (DI, không chặn UI) quét fact `expiresAt <= now` và refresh qua
`RefreshPipeline` (crawl → extract → verify → diff). Có giới hạn tần suất, tôn trọng
lease/ResourceCoordinator, và backoff khi nguồn lỗi.

### FR6 — In-chat stale detection + self-update (cơ chế c)

Khi luồng chat phát hiện một fact RTK đã được dùng nhưng có dấu hiệu lỗi thời (TTL hết, hoặc bằng
chứng mới mâu thuẫn), hệ phải:

- Chạy **verify** bằng `deepResearch`/`contentExtract` (≥1 nguồn độc lập).
- Nếu xác nhận giá trị mới: cập nhật fact, đẩy giá trị cũ vào `history`, reindex.
- Nếu không đủ bằng chứng: giữ giá trị cũ, hạ `confidence`, gắn `needs_review`.
- Không bao giờ ghi đè chỉ vì model "nghĩ" khác mà chưa verify.

### FR7 — Verify before write (guardrail)

Mọi thao tác ghi đè giá trị phải qua `VerificationService`:

- Yêu cầu nguồn đủ mạnh (số nguồn / độ uy tín / nhất quán).
- Ghi `validAsOf` từ nguồn, không phải thời điểm ghi.
- Atomic write + giữ lịch sử (không mất dữ liệu cũ).

### FR8 — Dedupe / supersede / conflict

Fact mới trùng topic phải **gộp** vào fact cũ (cập nhật + history), không tạo bản rời. Mâu thuẫn
giữa các nguồn → `needs_review` kèm danh sách bằng chứng đối nghịch.

### FR9 — Privacy & safety

Sanitize secret/token trước khi lưu; crawl ra ngoài cần opt-in; tôn trọng `prefers` của người dùng;
không lưu dữ liệu cá nhân nhạy cảm.

### FR10 — Agent/Tool integration

RTK lộ ra cho agent qua MCP tool (đọc: `rtk_lookup`; ghi có verify: `rtk_record`/`rtk_refresh`) để
agent chủ động tra/cập nhật, theo pattern built-in MCP hiện có. RTK là **gợi ý có nguồn**, không phải
chân lý tuyệt đối.

## Acceptance criteria

- Có spec kiến trúc rõ cho store + vector index + refresh pipeline + verify + self-update loop.
- Có `design.md` ánh xạ vào code thật (Embedder, vectorIndex, contentExtract, deepResearch, memoryStore).
- Có `tasks.md` chia phase khả thi, mỗi task độc-lập-theo-file để chạy song song được khi an toàn.
- Phase đầu triển khai được như service Main-process thuần TS, không sửa aioncore, không cần UI lớn.
- Có tiêu chí verify cho: schema, indexing, retrieval, scheduled refresh, in-chat self-update, guardrail.
