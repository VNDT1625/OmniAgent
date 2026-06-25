# Requirements — Exp Graph / ExpBase

## Goal

Thiết kế một hệ thống ghi nhớ kinh nghiệm sửa lỗi cho Agent coding: mỗi lần agent sửa bug thành công hoặc mắc sai lầm khi code, hệ thống ghi lại kinh nghiệm dưới dạng có cấu trúc, lập chỉ mục vector, và tự động truy hồi kinh nghiệm liên quan khi agent gặp bug/vấn đề tương tự trong tương lai.

## Scope

### In scope

- Ghi nhận kinh nghiệm từ các phiên coding/debugging:
  - Triệu chứng lỗi.
  - Bối cảnh kỹ thuật.
  - Nguyên nhân gốc nếu biết.
  - Cách fix đã áp dụng.
  - Sai lầm/anti-pattern nếu agent tự gây lỗi.
  - Bài học rút ra.
  - Kết quả xác minh.
- Chuẩn hóa kinh nghiệm thành `ExperienceEntry`.
- Tạo index vector để semantic search theo triệu chứng + bối cảnh.
- Truy hồi kinh nghiệm liên quan trước/trong quá trình debug.
- Chấm điểm độ liên quan dựa trên similarity + metadata context match.
- Cung cấp guardrail để không áp dụng mù kinh nghiệm cũ.
- Có cơ chế cập nhật, dedupe, versioning, và decay cho entry lỗi thời.

### Out of scope cho phase đầu

- Tự động sửa code hoàn toàn chỉ dựa trên kinh nghiệm.
- Fine-tune model.
- Đồng bộ cloud/team-wide knowledge base.
- UI quản trị phức tạp.
- Thu thập dữ liệu riêng tư ngoài workspace nếu chưa có opt-in.

## Functional requirements

### FR1 — Capture experience

Hệ thống phải cho phép tạo entry sau các sự kiện:

- Fix bug thành công.
- Test/build/typecheck fail do agent gây ra rồi đã sửa.
- Agent thử một hướng sai và xác định được bài học.
- User xác nhận một giải pháp là đúng hoặc sai.

### FR2 — Experience schema

Mỗi entry phải lưu tối thiểu:

- `id`
- `createdAt`, `updatedAt`
- `projectId` / workspace fingerprint
- `sourceSessionId` nếu có
- `kind`: `successful_fix` | `agent_mistake` | `failed_attempt` | `lesson`
- `symptoms`: mô tả lỗi, log, stack trace tóm tắt
- `context`: repo area, files, framework, runtime, command, branch nếu có
- `rootCause`: nguyên nhân đã xác minh hoặc giả thuyết
- `fix`: các bước/code pattern sửa
- `lesson`: nguyên tắc ngắn gọn để áp dụng lại
- `verification`: lệnh/kiểm tra đã chạy và kết quả
- `tags`: ngôn ngữ, package, error class, subsystem
- `confidence`: mức tin cậy
- `embeddingText`: text tổng hợp dùng để embed
- `status`: `active` | `superseded` | `archived`

### FR3 — Vector indexing

Hệ thống phải tạo embedding từ `embeddingText` và lưu vào vector index cục bộ hoặc service hiện có.

### FR4 — Retrieval

Khi agent gặp bug hoặc chuẩn bị debug, hệ thống phải tạo query từ:

- Symptom hiện tại.
- Error log/stack trace.
- File/subsystem liên quan.
- Tech stack và command đang fail.

Sau đó search top-K entry trong ExpBase.

### FR5 — Ranking

Kết quả phải xếp hạng bằng:

- Vector similarity.
- Match metadata: framework, file path, command, error category, package.
- Confidence và recency.
- Penalty cho entry đã superseded hoặc verification yếu.

### FR6 — Agent workflow integration

Agent phải dùng kết quả như gợi ý, không phải chân lý:

- So sánh bối cảnh hiện tại với bối cảnh entry.
- Chỉ áp dụng nếu có bằng chứng phù hợp.
- Nếu áp dụng thất bại, ghi lại failed attempt hoặc cập nhật confidence.

### FR7 — Dedupe and update

Khi entry mới giống entry cũ, hệ thống phải:

- Gộp evidence mới vào entry cũ, hoặc
- Tạo entry mới nhưng liên kết `relatedEntryIds`.

### FR8 — Privacy and safety

Entry phải tránh lưu raw secret/token. Logs cần được sanitize trước khi lưu.

## Acceptance criteria

- Có spec kiến trúc rõ ràng cho ExpBase vector retrieval.
- Có task checklist khả thi theo phase.
- Có tiêu chí verify cho schema, indexing, retrieval, ranking, và workflow integration.
- Phase đầu có thể triển khai dưới dạng service cục bộ mà không cần UI lớn.
