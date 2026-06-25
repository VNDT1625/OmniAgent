---
inclusion: always
---

# Quy tắc thiết kế UI — BẮT BUỘC

Khi làm bất kỳ việc nào tạo mới hoặc chỉnh sửa giao diện (page, panel, component, modal,
dashboard, hoặc "làm đẹp" màn hình có sẵn), PHẢI:

1. **Kích hoạt skill `frontend-design`** trước khi code: `.claude/skills/frontend-design/SKILL.md`.
   Báo ở đầu: "I'm using the frontend-design skill for this UI work."
2. **Áp dụng nguyên tắc thẩm mỹ của skill** (typography có cá tính, palette nhất quán với màu chủ
   đạo + accent sắc, motion có chủ đích, bố cục có nhịp, tránh "AI slop").
3. **Render bằng đúng stack của dự án** (mục "Project Stack Binding" trong skill thắng mọi xung đột):
   - `@arco-design/web-react` — KHÔNG raw HTML tương tác (`<button>`, `<input>`, `<select>`...).
   - Icon `@icon-park/react`.
   - UnoCSS utility + **semantic token** (`uno.config.ts` / CSS variables) — KHÔNG hardcode màu.
   - Font tùy biến qua CSS variable trong `renderer/styles/`, không đổi thư viện component.
   - Mọi chuỗi qua `t('key')` (i18n); đăng ký/đặt key cho module của feature.
   - Renderer only — không Node.js API trong UI.
4. **Kiểm tra cả light + dark theme**, tôn trọng `prefers-reduced-motion`, mỗi thư mục ≤ 10 children.

Tham chiếu phong cảm hứng (chỉ lấy nguyên tắc, KHÔNG copy code Tailwind):
VoltAgent/awesome-claude-design (các file DESIGN.md).
