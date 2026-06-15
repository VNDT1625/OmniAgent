---
inclusion: always
---

# Quy tắc dùng Skill — đọc mỗi session

Dự án có sẵn nhiều skill trong `.claude/skills/`. **Đầu mỗi session (hoặc trước khi bắt đầu một
task), đọc `.claude/skills/SKILLS_GUIDE.md`** để biết: dùng skill nào cho tình huống nào, path
skill ở đâu, và cách tránh xung đột giữa các skill.

## Bắt buộc

1. **Chọn skill theo tình huống** (bảng trigger trong `SKILLS_GUIDE.md`). Khi kích hoạt một skill,
   đọc `SKILL.md` của nó và báo dòng "Announce at start" tương ứng.
2. **Path skill**: `.claude/skills/<tên>/SKILL.md` (workspace) hoặc `~/.kiro/skills/<tên>/SKILL.md` (user-level).
3. **Tránh xung đột** (chi tiết trong guide):
   - Gặp lỗi khi đang code → `systematic-debugging` (tìm root cause) TRƯỚC khi sửa. Lỗi từ GitHub/Sentry → `fix-issues`/`fix-sentry`.
   - Lag/ngốn RAM-GPU → `systematic-debugging` để định vị, rồi `performance` để tối ưu có đo đạc.
   - PR: chỉ dùng MỘT workflow cho mỗi mục tiêu. `pr-ship` đã bao trọn vòng — KHÔNG gọi `oss-pr`/`pr-review` song song với nó.
   - UI → `frontend-design` nhưng render bằng Arco + UnoCSS + i18n (không Tailwind/shadcn/raw HTML).
4. **Trước khi thêm skill mới**: theo checklist "Có nên bổ sung skill nào nữa không?" trong guide —
   không thêm nếu trùng chức năng đã có, hoặc xung đột stack (backend generic Express/Postgres,
   UI Tailwind/shadcn). Tải verbatim + giữ LICENSE, đăng ký vào `AGENTS.md` và cập nhật guide.

## Danh sách skill hiện có (tóm tắt)

Code & cấu trúc: `architecture`, `frontend-design`, `i18n`, `performance`.
Chất lượng: `testing`, `systematic-debugging`.
Sửa lỗi tự động: `fix-issues` (GitHub), `fix-sentry` (Sentry).
PR & release: `oss-pr`, `pr-review`, `pr-fix`, `pr-verify`, `pr-ship`, `pr-automation`, `bump-version`.

> Nguồn chân lý đầy đủ: `.claude/skills/SKILLS_GUIDE.md`.
