---
inclusion: always
---

# ĐỌC TRƯỚC KHI LÀM VIỆC

Trước khi bắt đầu bất kỳ task nào trên codebase này, **PHẢI đọc file**:

> `docs/CODEBASE_GUIDE.md`

File này chứa tài liệu toàn diện về kiến trúc, cấu trúc thư mục, luồng dữ liệu,
API surface (HTTP/WS đến aioncore), database schema, quy ước code, i18n, và spec
OmniAgent đang phát triển. Đọc nó để nắm codebase nhanh trước khi sửa code.

## Tóm tắt kiến trúc cốt lõi (để khỏi nhầm)

- **Electron app** = shell mỏng. Main process CHỈ lo cửa sổ, tray, dialog, auto-update, deep links.
- **aioncore (Rust binary)** = chứa TOÀN BỘ business logic (conversations, agents, MCP, files, cron, teams).
- Renderer & main giao tiếp với aioncore qua **HTTP REST + WebSocket**, KHÔNG phải IPC.
- API surface nằm ở `packages/desktop/src/common/adapter/ipcBridge.ts`.
- Process boundary: renderer KHÔNG dùng Node.js API; main KHÔNG dùng DOM API (vi phạm = crash).

## Quy ước bắt buộc

- UI: `@arco-design/web-react` + icon `@icon-park/react`, không raw HTML interactive.
- Màu: semantic tokens trong `uno.config.ts`, không hardcode.
- i18n: không hardcode string, luôn dùng `t('key')`. Sau khi sửa locale chạy `bun run i18n:types` + `scripts/check-i18n.js`.
- Tối đa 10 children mỗi directory.
- Đọc thêm `AGENTS.md` ở root cho quy tắc đầy đủ.

> Nếu `docs/CODEBASE_GUIDE.md` lỗi thời so với code thực tế, ưu tiên code thực tế và cập nhật lại guide.

## Cập nhật guide sau mỗi phiên (BẮT BUỘC)

Sau khi hoàn thành thay đổi trong một phiên làm việc, PHẢI kiểm tra lại xem thay đổi
có ảnh hưởng đến nội dung trong `docs/CODEBASE_GUIDE.md` không. Nếu có, PHẢI cập nhật
guide cho khớp với code thực tế. Các thay đổi cần cập nhật guide gồm (không giới hạn):

- Thêm/xóa/đổi tên package, thư mục, hoặc file quan trọng.
- Thay đổi kiến trúc, luồng dữ liệu, hoặc cách giao tiếp giữa các process.
- Thêm/sửa/xóa API endpoint (HTTP/WS) hoặc database schema (table/column/version).
- Thêm/đổi route, page, component dùng chung, hoặc context provider.
- Thay đổi quy ước code, build/test workflow, hoặc danh sách ngôn ngữ i18n.
- Tiến độ hoặc phạm vi của spec OmniAgent (mục 29) thay đổi.

Khi cập nhật, cũng cập nhật dòng "Cập nhật" ở đầu guide. Nếu phiên không tạo thay đổi
nào ảnh hưởng guide thì không cần sửa. Mục tiêu: guide luôn phản ánh đúng code hiện tại.
