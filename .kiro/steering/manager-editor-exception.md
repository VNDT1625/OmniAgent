---
inclusion: manual
---

# Ngoại lệ UI có khoanh vùng — Trình soạn note kiểu Notion (BlockNote)

Quy tắc chung của dự án (AGENTS.md + skill `frontend-design`): UI render bằng
`@arco-design/web-react` + UnoCSS, **không** dùng thư viện UI khác. Tài liệu này
ghi nhận **một ngoại lệ duy nhất, có khoanh vùng**, đã được người dùng đồng ý.

## Phạm vi ngoại lệ

- Chỉ **vùng soạn/đọc nội dung note** của Manager (Tasks/Schedule và toàn bộ
  khung còn lại vẫn 100% Arco).
- Thư viện: **BlockNote** (`@blocknote/core`, `@blocknote/react`,
  `@blocknote/mantine`) — giấy phép **MPL-2.0** (lõi free cho cả phần mềm đóng).
- File liên quan: `renderer/pages/manager/notes/editor/**`.

## Lý do

Trải nghiệm "trang đọc/soạn giống Notion" (slash command `/`, kéo-thả block,
bảng, ảnh/video/embed URL, cover + page icon) **không thể tái tạo hợp lý** bằng
primitive của Arco. Tự viết lại sẽ tốn rất nhiều thời gian và vẫn kém. Người
dùng yêu cầu rõ tính năng này.

## Ràng buộc để ngoại lệ an toàn

1. **Cô lập style**: mọi override BlockNote nằm dưới `.host` trong
   `packages/desktop/src/renderer/pages/manager/notes/editor/NoteBlockEditor.module.css` (CSS Module → tên hash) — KHÔNG rò ra app khác.
2. **Theo theme app**: map biến `--bn-colors-*` sang token theme + `--mgr-accent`
   để theo light/dark và accent người dùng.
3. **Hợp đồng dữ liệu không đổi**: body note vẫn lưu **Markdown** trong
   `manager-data.json`. Editor parse Markdown→blocks khi mở, serialize
   blocks→Markdown khi sửa. Backend/MCP/store KHÔNG đổi.
4. **i18n + renderer-only** giữ nguyên. Không Node API trong UI.
5. KHÔNG mở rộng BlockNote ra ngoài vùng note (không dùng cho chat/studio/…).

> Tóm tắt: BlockNote chỉ cho editor note, style cô lập, dữ liệu vẫn Markdown.
> Mọi UI khác vẫn theo luật Arco.
